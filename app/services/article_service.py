from uuid import uuid4

from app.models import Article, ArticleCreate
from app.services.time_service import now_seoul


def _compact_vote_margin(votes: int) -> str:
    if votes >= 10_000:
        ten_thousands, remainder = divmod(votes, 10_000)
        return f"{ten_thousands:,}만{remainder}표" if remainder else f"{ten_thousands:,}만표"
    return f"{votes:,}표"


def _reported_candidates(snapshot):
    """Do not present interpolated candidate counts as reported election results."""
    if snapshot.record_type == "mixed":
        return [
            candidate for candidate in snapshot.candidates
            if candidate.candidate_name in {"오세훈", "정원오"}
        ]
    return list(snapshot.candidates)


def election_headline(snapshot) -> str:
    event = (snapshot.timeline_event or "").strip()
    if snapshot.counted_rate is None or not snapshot.candidates:
        if "투표용지 부족" in event:
            return "잠실7동 투표용지 부족…투표시간 연장"
        if "투표함 2개" in event:
            return "잠실7동 투표함 2개 이송…개표 절차 재개"
        if "개표 시작" in event:
            return "서울시장 선거 개표 시작"
        return f"서울시장 선거…{event}" if event else "서울시장 선거 개표 상황"

    ordered = sorted(_reported_candidates(snapshot), key=lambda item: item.votes, reverse=True)
    leader = ordered[0]
    if len(ordered) == 1:
        return f"서울시장 개표…{leader.candidate_name} 선두"
    runner_up = ordered[1]
    gap = _compact_vote_margin(leader.votes - runner_up.votes)
    if snapshot.counted_rate == 100:
        return f"서울시장 개표 완료…{leader.candidate_name}, {runner_up.candidate_name}에 {gap} 앞서"
    if "역전" in event:
        return f"서울시장 개표 역전…{leader.candidate_name}, {runner_up.candidate_name}에 {gap} 앞서"
    return f"서울시장 개표 {snapshot.counted_rate:g}%…{leader.candidate_name}, {runner_up.candidate_name}에 {gap} 앞서"


def _article_body(snapshot) -> str:
    if snapshot.counted_rate is None or not snapshot.candidates:
        event = (snapshot.timeline_event or "").strip()
        if "투표용지 부족" in event:
            return (
                "서울 송파구 잠실7동 제2투표소에서 투표용지가 부족해 투표시간이 연장됐다.\n\n"
                "대기표를 받은 유권자에 한해 이날 오후 10시까지 투표가 진행됐다."
            )
        if "투표함 2개" in event:
            return (
                "서울 송파구 잠실7동 제2투표소의 투표함 2개가 개표소로 옮겨졌다.\n\n"
                "투표함 반출은 현장 대치로 지연됐다."
            )
        return f"서울시장 선거 {event}." if event else "서울시장 선거 개표 상황이 전해졌다."

    ordered = sorted(_reported_candidates(snapshot), key=lambda item: item.votes, reverse=True)
    first = ordered[0]
    if len(ordered) == 1:
        return f"서울시장 선거에서 {first.candidate_name} 후보가 {first.votes:,}표({first.vote_rate:.2f}%)를 얻었다."

    second = ordered[1]
    margin = first.votes - second.votes
    margin_rate = first.vote_rate - second.vote_rate
    if snapshot.counted_rate == 100:
        lead = (
            f"서울시장 선거 개표가 완료됐다. {first.candidate_name} 후보가 "
            f"{first.votes:,}표({first.vote_rate:.2f}%)를 얻어 "
            f"{second.candidate_name} 후보({second.votes:,}표·{second.vote_rate:.2f}%)를 "
            f"{_compact_vote_margin(margin)} 차이로 앞섰다."
        )
        detail = f"두 후보의 득표율 격차는 {margin_rate:.2f}%포인트다."
    elif "역전" in (snapshot.timeline_event or ""):
        lead = (
            f"서울시장 선거 개표 과정에서 선두가 바뀌었다. "
            f"{first.candidate_name} 후보가 {first.votes:,}표({first.vote_rate:.2f}%)로 "
            f"{second.candidate_name} 후보({second.votes:,}표·{second.vote_rate:.2f}%)를 "
            f"{_compact_vote_margin(margin)} 차이로 앞섰다."
        )
        detail = f"당시 개표율은 {snapshot.counted_rate:g}%였다."
    else:
        lead = (
            f"서울시장 선거 개표율이 {snapshot.counted_rate:g}%를 기록한 가운데 "
            f"{first.candidate_name} 후보가 {first.votes:,}표({first.vote_rate:.2f}%)로 "
            f"{second.candidate_name} 후보({second.votes:,}표·{second.vote_rate:.2f}%)를 "
            f"{_compact_vote_margin(margin)} 차이로 앞섰다."
        )
        detail = f"두 후보의 득표율 격차는 {margin_rate:.2f}%포인트다."

    paragraphs = [lead, detail]
    if snapshot.record_type != "mixed" and len(ordered) > 2:
        others = ", ".join(
            f"{c.candidate_name} 후보 {c.votes:,}표({c.vote_rate:.2f}%)"
            for c in ordered[2:]
        )
        paragraphs.append(f"이 밖에 {others}를 기록했다.")
    return "\n\n".join(paragraphs)


def generate_article(request: ArticleCreate) -> Article:
    snapshot = request.snapshot
    title = election_headline(snapshot)
    # Reconstructed frames must never masquerade as an actual news report.
    if snapshot.record_type == "simulated":
        title = f"[시연용 재구성] {title}"
    body = _article_body(snapshot)
    now = now_seoul()
    return Article(
        article_id=uuid4().hex,
        title=title,
        body=body,
        status="draft",
        snapshot=snapshot,
        evidence=request.evidence,
        created_at=now,
        updated_at=now,
    )


async def generate_ai_article(request: ArticleCreate, api_key: str, model: str) -> Article:
    """Generate an entire article, with the snapshot and sources held separately."""
    import json
    from openai import AsyncOpenAI

    if not api_key:
        raise ValueError("AI 기사 생성에는 OPENAI_API_KEY가 필요합니다.")

    factual = generate_article(request)
    snapshot = request.snapshot
    payload = {
        "snapshot": snapshot.model_dump(mode="json"),
        "suggested_headline": factual.title,
        "verified_draft": factual.body,
        "evidence": [item.model_dump(mode="json") for item in request.evidence],
    }
    client = AsyncOpenAI(api_key=api_key, timeout=35, max_retries=0)
    response = await client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": (
                "당신은 한국 언론사 선거 속보 담당 기자의 작성 보조자다. "
                "제공된 스냅샷과 근거에서 확인 가능한 사실만 사용해 실제 기사처럼 제목과 본문 전체를 작성하라. "
                "기사 제목은 핵심 사실 중심으로 짧게 작성하고, 본문은 리드와 후속 문단 2~4개로 구성하라. "
                "모든 후보 수치를 나열할 필요는 없지만, 언급하는 후보별 득표수와 득표율은 원본 그대로 사용하라. "
                "특히 1·2위 후보의 득표수·득표율은 숫자와 쉼표 형식으로 정확히 인용하라. "
                "출처명, 근거 ID, URL, ISO 시각, 내부 개표 단계, 작성 지침이나 검증 안내는 본문에 쓰지 마라. "
                "각 후보의 공약·발언·원인·전망·과거 상황을 근거 없이 만들지 마라. "
                "중간 집계는 당선 확정처럼 쓰지 마라. "
                "시연용 재구성 프레임이면 반드시 제목에 '[시연용 재구성]'을 남겨 실제 개표로 오인되지 않게 하라. "
                "일부 후보 수치가 추정된 mixed 프레임에서는 오세훈·정원오의 보도 수치만 사용하라. "
                "개표 수치가 없는 사건 단계에서는 사건 보도만 작성하고 개표율·득표 수치를 쓰지 마라. "
                "JSON 객체 {title: 문자열, body: 문자열}만 반환하라."
            )},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0,
    )
    try:
        result = json.loads(response.choices[0].message.content or "{}")
    except (ValueError, IndexError, AttributeError) as exc:
        raise ValueError("AI 기사 응답을 해석할 수 없습니다.") from exc
    if not isinstance(result, dict):
        raise ValueError("AI 기사 형식이 올바르지 않습니다.")
    title, body = result.get("title"), result.get("body")
    if not isinstance(title, str) or not isinstance(body, str):
        raise ValueError("AI가 기사 제목·본문을 반환하지 않았습니다.")
    title, body = title.strip(), body.strip()
    if not title or len(title) > 500 or "\n" in title or "\r" in title or not body:
        raise ValueError("AI 기사 제목 또는 본문이 유효하지 않습니다.")
    if snapshot.record_type == "simulated" and "[시연용 재구성]" not in title:
        title = "[시연용 재구성] " + title
    factual.title = title
    factual.body = body
    return factual
