import json
import re
from pathlib import Path

from app.models import Evidence


class LocalRAG:
    def __init__(self, path: Path):
        self.documents = json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def tokens(text: str) -> set[str]:
        return set(re.findall(r"[가-힣A-Za-z0-9]{2,}", text.lower()))

    @staticmethod
    def bigrams(text: str) -> set[str]:
        compact = re.sub(r"\s+", "", text.lower())
        return {compact[i:i + 2] for i in range(len(compact) - 1)}

    def search(self, query: str, limit: int = 5) -> list[Evidence]:
        query_tokens = self.tokens(query)
        query_bigrams = self.bigrams(query)
        if not query_tokens and not query_bigrams:
            return []
        scored = []
        for document in self.documents:
            haystack = f"{document['title']} {document['content']} {document.get('candidate_name', '')}"
            doc_tokens = self.tokens(haystack)
            doc_bigrams = self.bigrams(haystack)
            token_score = len(query_tokens & doc_tokens) / len(query_tokens) if query_tokens else 0
            char_score = len(query_bigrams & doc_bigrams) / len(query_bigrams) if query_bigrams else 0
            score = 0.55 * token_score + 0.45 * char_score
            if score > 0:
                scored.append((score, document))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [Evidence(**doc, score=round(score, 3)) for score, doc in scored[:limit]]


async def answer_question(question: str, searcher: LocalRAG, api_key: str = "", model: str = "gpt-4.1-mini") -> dict:
    """Answer only from returned evidence; expose citations, including in no-key demo mode."""
    evidence = searcher.search(question, limit=3)
    base = {"question": question, "evidence": [row.model_dump() for row in evidence]}
    if not evidence:
        return {**base, "mode": "no_evidence", "answer": "검색된 근거가 없어 답변할 수 없습니다.", "evidence_ids": []}
    if not api_key:
        excerpts = [f"[{row.evidence_id}] {row.title}: {row.content}" for row in evidence]
        return {**base, "mode": "extractive", "answer": "\n".join(excerpts),
                "evidence_ids": [row.evidence_id for row in evidence]}

    import json
    from openai import AsyncOpenAI

    supplied = [{"evidence_id": row.evidence_id, "content": row.content, "title": row.title,
                 "source": row.source, "source_url": row.source_url} for row in evidence]
    client = AsyncOpenAI(api_key=api_key, timeout=25, max_retries=0)
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": (
                "당신은 선거보도 근거 확인 보조자다. 제공된 근거만 사용하라. "
                "외부 지식·추측·미제공 수치는 쓰지 마라. 시연용 재구성과 실제 보도 수치를 구분하라. "
                "근거가 부족하면 답할 수 없다고 명시하라. "
                "JSON 객체 {answer: 문자열, evidence_ids: 문자열 배열}만 반환하라. "
                "evidence_ids에는 답변에 실제 사용한 제공 근거 ID만 포함하라."
            )},
            {"role": "user", "content": json.dumps({"question": question, "evidence": supplied}, ensure_ascii=False)},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    parsed = json.loads(response.choices[0].message.content or "{}")
    allowed = {row.evidence_id for row in evidence}
    ids = parsed.get("evidence_ids", [])
    valid_ids = [item for item in ids if isinstance(item, str) and item in allowed] if isinstance(ids, list) else []
    answer = parsed.get("answer", "")
    if not isinstance(answer, str) or not answer.strip() or not valid_ids:
        return {**base, "mode": "no_evidence", "answer": "제시된 근거로 답변을 확인하지 못했습니다.", "evidence_ids": []}
    return {**base, "mode": "openai", "answer": answer.strip(), "evidence_ids": valid_ids}

