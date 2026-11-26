import math
import re

import httpx
from openai import AsyncOpenAI

from app.config import Settings
from app.models import Article, FactCheckResult


def _issue(field, message, original=None, suggestion=None, target="body"):
    return {
        "field": field, "message": message, "original": original, "suggestion": suggestion,
        "target": target,
        "action": ("replace" if original else "insert") if suggestion is not None else None,
    }


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
    """The LLM only reviews unsupported context and bias, never replaces number checks."""
    if not settings.openai_api_key:
        return {"mode": "disabled", "issues": [], "note": "규칙 기반 검증만 수행했습니다."}
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    prompt = (
        "다음 선거 기사에서 근거 없는 단정·전망·후보 편향·중요한 맥락 누락을 검토하세요. "
        "숫자의 정오 판정은 하지 마세요. 문제가 없다면 issues를 빈 배열로 반환하세요. "
        "JSON 객체 {issues:[{type,reason,quote}]}만 반환하세요.\n\n" + article.body
    )
    response = await client.chat.completions.create(
        model=settings.openai_chat_model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"}, temperature=0,
    )
    import json
    result = json.loads(response.choices[0].message.content or "{}")
    return {"mode": "openai", "issues": result.get("issues", [])}


def _reported_candidates(snapshot):
    if snapshot.record_type == "mixed":
        return [c for c in snapshot.candidates if c.candidate_name in {"오세훈", "정원오"}]
    return snapshot.candidates


def _number_claims(text: str, candidate_name: str):
    """Extract explicit candidate votes+rates, without requiring every candidate in the story."""
    pattern = (
        rf"(?<![가-힣A-Za-z]){re.escape(candidate_name)}\s*"
        rf"(?:후보(?:는|가|의)?)?\s*\(?\s*"
        rf"(\d[\d,]*)\s*표\s*[·(]\s*(\d+(?:\.\d+)?)\s*%\s*\)?"
    )
    return list(re.finditer(pattern, text))


def _votes_from_notation(value: str) -> int:
    if "만" not in value:
        return int(value.replace(",", ""))
    higher, lower = value.split("만", 1)
    return int(higher.replace(",", "")) * 10000 + int(lower.replace(",", "") or "0")


async def check_article(article: Article, settings: Settings) -> FactCheckResult:
    snapshot = article.snapshot
    if snapshot is None:
        raise ValueError("개표 기사에는 스냅샷이 필요합니다.")

    text = article.title + "\n" + article.body
    checks: list[dict] = []
    issues: list[dict] = []

    if snapshot.counted_rate is None:
        event = (snapshot.timeline_event or "").strip()
        # Event-only articles should not fabricate vote numbers.
        event_ok = bool(event) and (
            event in text or (
                ("투표용지 부족" in event and "투표용지 부족" in text)
                or ("투표함 2개" in event and "투표함 2개" in text)
                or ("개표 시작" in event and "개표 시작" in text)
            )
        )
        checks.append({"field": "타임라인 사건", "expected": event, "passed": event_ok})
        if not event_ok:
            issues.append(_issue("타임라인 사건", "원본 사건과 일치하는 설명이 없습니다."))
    else:
        # Check the source snapshot's integrity separately from what is written.
        if snapshot.record_type != "mixed":
            total_rate = sum(c.vote_rate for c in snapshot.candidates)
            checks.append({
                "field": "득표율 합계", "expected": "약 100%", "actual": total_rate,
                "passed": math.isclose(total_rate, 100, abs_tol=0.2),
            })
            if not checks[-1]["passed"]:
                issues.append(_issue("득표율 합계", "원본 스냅샷의 득표율 합계 확인이 필요합니다."))

        matched_count = 0
        for candidate in _reported_candidates(snapshot):
            claims = _number_claims(text, candidate.candidate_name)
            if not claims:
                continue
            matched_count += len(claims)
            valid = all(
                int(m.group(1).replace(",", "")) == candidate.votes
                and math.isclose(float(m.group(2)), candidate.vote_rate, abs_tol=0.005)
                for m in claims
            )
            checks.append({
                "field": f"득표:{candidate.candidate_name}",
                "expected": f"{candidate.votes:,}표({candidate.vote_rate:.2f}%)",
                "passed": valid,
            })
            if not valid:
                for claim in claims:
                    if (int(claim.group(1).replace(",", "")) != candidate.votes
                            or not math.isclose(float(claim.group(2)), candidate.vote_rate, abs_tol=0.005)):
                        issues.append(_issue(
                            f"{candidate.candidate_name} 득표",
                            "후보자 득표 수치가 원본 집계와 다릅니다.",
                            claim.group(0),
                            f"{candidate.candidate_name} 후보 {candidate.votes:,}표({candidate.vote_rate:.2f}%)",
                            "body" if claim.group(0) in article.body else "title",
                        ))

        claims_present = matched_count > 0
        checks.append({"field": "기사 수치 확인", "expected": "원본 후보 득표 근거", "passed": claims_present})
        if not claims_present:
            issues.append(_issue("기사 수치 확인", "원본과 비교할 수 있는 후보자 득표 수치가 없습니다."))

        # The article need not recite a machine timestamp, internal step number or source URL.
        # But an explicit margin claim must agree with the top-two snapshot totals.
        candidates = sorted(_reported_candidates(snapshot), key=lambda c: c.votes, reverse=True)
        if len(candidates) > 1:
            expected_gap = candidates[0].votes - candidates[1].votes
            for m in re.finditer(r"(\d[\d,]*(?:만[\d,]*)?)표\s*(?:차(?:이)?로\s*)?앞서", text):
                actual_gap = _votes_from_notation(m.group(1))
                passed = actual_gap == expected_gap
                checks.append({"field": "득표 격차", "expected": expected_gap,
                               "actual": actual_gap, "passed": passed})
                if not passed:
                    issues.append(_issue(
                        "득표 격차", "득표 차이가 원본 집계와 다릅니다.",
                        m.group(0), f"{expected_gap:,}표 앞서",
                        "body" if m.group(0) in article.body else "title",
                    ))

        if snapshot.record_type == "simulated":
            clearly_labeled = "[시연용 재구성]" in article.title
            checks.append({"field": "시연 구분", "passed": clearly_labeled})
            if not clearly_labeled:
                issues.append(_issue("시연 구분", "재구성 데이터는 제목에서 시연용임을 구분해야 합니다.",
                                     None, "[시연용 재구성] ", target="title"))

    # Reject contradictory explicit machine timestamps; do not require them in prose.
    iso_times = re.findall(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?",
        text,
    )
    correct_time = snapshot.collected_at.isoformat()
    time_ok = all(stamp == correct_time for stamp in iso_times)
    checks.append({"field": "명시된 ISO 시각", "expected": correct_time, "passed": time_ok})
    if not time_ok:
        issues.append(_issue("명시된 ISO 시각", "원본 스냅샷과 다른 시각이 적혀 있습니다."))

    failed = any(not check["passed"] for check in checks)
    claims = await google_claims(article.title, settings)
    review = await contextual_review(article, settings)
    status = "fail" if failed else ("review_required" if review.get("issues") else "pass")
    return FactCheckResult(
        status=status,
        reason=("기사가 언급한 수치를 원본 스냅샷과 대조했습니다. 검증하지 않은 해석은 사람 검토가 필요합니다."
                if not failed else "기사 속 수치 또는 사건이 원본과 일치하지 않습니다."),
        checks=checks, issues=issues, external_claims=claims, llm_review=review,
    )
