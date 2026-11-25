import math
import re
import httpx
from openai import AsyncOpenAI

from app.config import Settings
from app.models import Article, FactCheckResult


async def google_claims(query: str, settings: Settings) -> list[dict]:
    if not settings.google_fact_check_enabled or not settings.google_fact_check_api_key:
        return []
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(settings.google_fact_check_api_url, params={
            "query": query, "languageCode": "ko", "key": settings.google_fact_check_api_key,
        })
        response.raise_for_status()
        return response.json().get("claims", [])[:5]


async def contextual_review(article: Article, settings: Settings) -> dict:
    """LLM은 규칙 판정을 대체하지 않고 문맥·누락·편향만 보조 검토한다."""
    if not settings.openai_api_key:
        return {"mode": "disabled", "issues": [], "note": "OPENAI_API_KEY가 없어 규칙 검증만 수행했습니다."}
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    prompt = (
        "다음 교육용 선거 기사에서 과장, 근거 없는 전망, 후보 편향, 중요한 맥락 누락만 점검하세요. "
        "수치 판정은 하지 마세요. 문제가 없으면 issues를 빈 배열로 반환하세요. "
        "JSON 객체 {issues:[{type,reason,quote}]}만 출력하세요.\n\n" + article.body
    )
    response = await client.chat.completions.create(
        model=settings.openai_chat_model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"}, temperature=0,
    )
    import json
    result = json.loads(response.choices[0].message.content or "{}")
    return {"mode": "openai", "issues": result.get("issues", [])}


async def check_article(article: Article, settings: Settings) -> FactCheckResult:
    checks = []
    snapshot = article.snapshot
    text = article.title + "\n" + article.body
    if snapshot.counted_rate is None:
        checks.append({
            "field": "타임라인 사건",
            "expected": snapshot.timeline_event,
            "passed": snapshot.timeline_event in text,
        })
    else:
        total_rate = sum(candidate.vote_rate for candidate in snapshot.candidates)
        checks.append({"field": "득표율 합계", "expected": "약 100%", "actual": total_rate,
                       "passed": math.isclose(total_rate, 100, abs_tol=0.2)})

    for candidate in snapshot.candidates:
        name = candidate.candidate_name
        escaped = re.escape(name)
        # Compare each candidate's figures with the figures *adjacent to that name*.
        # Checking mere number presence would wrongly pass swapped candidates.
        votes = re.findall(
            rf"(?<![가-힣A-Za-z]){escaped}\s*(?:후보(?:는|가|의)?\s*)?"
            rf"(?:득표수\s*)?(\d[\d,]*)\s*표", text,
        )
        rates = re.findall(
            rf"(?<![가-힣A-Za-z]){escaped}\s*(?:후보(?:는|가|의)?\s*)?"
            rf"(?:득표율\s*)?(\d+(?:\.\d+)?)\s*%", text,
        )
        pairs = re.findall(
            rf"(?<![가-힣A-Za-z]){escaped}\s*(?:후보(?:는|가|의)?\s*)?"
            rf"(\d[\d,]*)\s*표\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)", text,
        )
        expected_votes = candidate.votes
        expected_rate = candidate.vote_rate
        # The canonical snapshot paragraph carries this exact pair. Detect
        # additional conflicting candidate-specific claims elsewhere as well.
        pair_ok = any(int(v.replace(",", "")) == expected_votes and
                      math.isclose(float(r), expected_rate, abs_tol=0.005)
                      for v, r in pairs)
        vote_ok = pair_ok and all(int(v.replace(",", "")) == expected_votes for v in votes)
        rate_ok = pair_ok and all(math.isclose(float(r), expected_rate, abs_tol=0.005) for r in rates)
        checks.extend([
            {"field": f"후보명:{name}", "expected": name, "passed": name in text},
            {"field": f"득표수:{name}", "expected": expected_votes, "passed": vote_ok},
            {"field": f"득표율:{name}", "expected": expected_rate, "passed": rate_ok},
        ])

    expected_time = snapshot.collected_at.isoformat()
    # Time strings are stored and drafted in ISO 8601 form. A different ISO
    # time in a lead must not be silently accepted just because the original
    # factual paragraph still contains the correct time.
    times = re.findall(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?", text)
    checks.extend([
        {"field": "지역", "expected": snapshot.region, "passed": snapshot.region in article.body},
        {"field": "단계", "expected": snapshot.step_id, "passed": f"{snapshot.step_id}단계" in article.body},
        {"field": "기준시각", "expected": expected_time,
         "passed": expected_time in article.body and bool(times) and all(t == expected_time for t in times)},
        {"field": "출처", "expected": snapshot.source, "passed": snapshot.source in article.body},
    ])
    failed = [check for check in checks if not check["passed"]]
    claims = await google_claims(article.title, settings)
    llm_review = await contextual_review(article, settings)
    status = "fail" if failed else ("review_required" if llm_review.get("issues") else "pass")
    return FactCheckResult(status=status,
                           reason="수치·후보·지역·단계·기준시각·출처가 원 데이터와 일치합니다." if not failed else "원 데이터 불일치가 발견됐습니다.",
                           checks=checks, external_claims=claims, llm_review=llm_review)
