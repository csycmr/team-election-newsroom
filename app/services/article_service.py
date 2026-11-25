from uuid import uuid4

from app.models import Article, ArticleCreate
from app.services.time_service import now_seoul


def _compact_vote_margin(votes: int) -> str:
    if votes >= 10_000:
        ten_thousands, remainder = divmod(votes, 10_000)
        rest = f" {remainder:,}" if remainder else ""
        return f"{ten_thousands:,}만{rest}표"
    return f"{votes:,}표"


def election_headline(snapshot) -> str:
    """Build a timestamped, fact-led headline from the selected count snapshot."""
    collected_at = snapshot.collected_at
    stamp = f"{collected_at.month}월 {collected_at.day}일 {collected_at:%H}시 {collected_at:%M}분"
    if snapshot.time_basis == "approximate":
        time_phrase = f"{stamp}쯤"
    elif snapshot.time_basis == "publication_time":
        time_phrase = f"{stamp} 보도 기준"
    else:
        time_phrase = f"{stamp} 현재"

    event = (snapshot.timeline_event or "").strip()
    if snapshot.counted_rate is None or not snapshot.candidates:
        if "투표용지 부족" in event:
            detail = "잠실7동 투표용지 부족으로 투표가 연장됐습니다."
        elif "투표함 2개" in event:
            detail = "잠실7동 투표함 2개가 이송됐습니다."
        elif "개표 시작" in event:
            detail = "서울시장 선거 개표가 시작됐습니다."
        elif event:
            detail = f"{event} 상황이 전해졌습니다."
        else:
            detail = "집계 상황을 확인 중입니다."
        return f"[서울시장 개표상황] {time_phrase}, {detail}"

    ordered = sorted(snapshot.candidates, key=lambda candidate: candidate.votes, reverse=True)
    leader = ordered[0]
    incident = ""
    if "역전" in event:
        incident = f" {leader.candidate_name} 후보가 역전에 성공했습니다."
    elif "최종 개표 완료" in event:
        incident = " 최종 개표가 완료됐습니다."

    if len(ordered) > 1:
        gap = leader.votes - ordered[1].votes
        if gap:
            lead_text = f"{leader.candidate_name} 후보가 {_compact_vote_margin(gap)} 차로 선두입니다."
        else:
            lead_text = f"{leader.candidate_name} 후보와 2위 후보가 동률입니다."
    else:
        lead_text = f"{leader.candidate_name} 후보가 선두입니다."

    rate = f"{snapshot.counted_rate:g}%"
    count_text = f"최종 개표율 {rate}" if snapshot.counted_rate == 100 else f"개표율 {rate}"
    if "역전" in event and "차로 선두" in lead_text:
        lead_text = lead_text.removesuffix("선두입니다.") + "역전 선두입니다."
    elif snapshot.counted_rate == 100 and "차로 선두" in lead_text:
        lead_text = lead_text.removesuffix("선두입니다.") + "최종 선두입니다."
    incident = "" if "역전" in event or "최종 개표 완료" in event else incident
    return f"[서울시장 개표상황] {time_phrase}, {count_text}, {lead_text}{incident}"


def generate_article(request: ArticleCreate) -> Article:
    snapshot = request.snapshot
    evidence_text = ""
    if request.evidence:
        refs = ", ".join(f"{e.title}({e.source})" for e in request.evidence[:3])
        ids = ", ".join(e.evidence_id for e in request.evidence[:3])
        evidence_text = f" 근거 [{ids}] {refs}."
    if snapshot.mode != "replay":
        label = "교육용 모의 보도"
    else:
        label = {
            "simulated": "시연용 재구성",
            "mixed": "보도 집계 · 일부 시연 추정",
        }.get(snapshot.record_type, "과거 보도 기록")

    time_label = {
        "approximate": "무렵",
        "publication_time": "보도 시각",
    }.get(snapshot.time_basis, "기준")
    intro = (
        f"[{label}] {snapshot.collected_at.isoformat()} {time_label} "
        f"{snapshot.election_name} {snapshot.region} {snapshot.step_id}단계"
    )
    if snapshot.counted_rate is None:
        summary = f" 소식은 ‘{snapshot.timeline_event}’이다."
    else:
        ordered = sorted(snapshot.candidates, key=lambda candidate: candidate.votes, reverse=True)
        rows = ", ".join(
            f"{candidate.candidate_name} {candidate.votes:,}표({candidate.vote_rate:.2f}%)"
            for candidate in ordered
        )
        stage = "최종 개표 결과입니다." if snapshot.counted_rate == 100 else "개표 중간 단계입니다."
        summary = (
            f" 집계에서 {rows}로 집계됐다. 개표 진행률은 {snapshot.counted_rate:.2f}%이며 "
            f"{ordered[0].candidate_name} 후보가 가장 많은 표를 얻었다. {stage}"
        )
        if snapshot.record_type == "mixed":
            summary += " 오세훈·정원오 후보는 보도 수치이며 권영국·유지혜·김정철 후보는 시연 추정 수치다."
    title = election_headline(snapshot)
    note = f" {snapshot.timeline_note}" if snapshot.timeline_note else ""
    body = (
        f"{intro}{summary}{note}{evidence_text} 초안은 팩트체크와 편집 검토를 거쳐야 한다. "
        f"출처: {snapshot.source} ({snapshot.source_url})"
    )
    now = now_seoul()
    return Article(article_id=uuid4().hex, title=title,
                   body=body, status="draft", snapshot=snapshot, evidence=request.evidence,
                   created_at=now, updated_at=now)



async def generate_ai_article(request: ArticleCreate, api_key: str, model: str) -> Article:
    """AI writes the lead while the timestamped title stays tied to snapshot facts."""
    import json
    from openai import AsyncOpenAI

    if not api_key:
        raise ValueError("AI 기사 생성을 요청했지만 OPENAI_API_KEY가 없습니다.")

    # Ground factual figures in the existing deterministic article rather than
    # trusting the language model to reproduce vote totals and percentages.
    factual = generate_article(request)
    snapshot = request.snapshot
    evidence = [
        {"evidence_id": item.evidence_id, "title": item.title,
         "content": item.content, "source": item.source,
         "source_url": item.source_url}
        for item in request.evidence
    ]
    payload = {
        "election": snapshot.election_name,
        "region": snapshot.region,
        "snapshot": snapshot.model_dump(mode="json"),
        "verified_input_for_drafting": factual.body,
        "standard_headline": factual.title,
        "evidence": evidence,
    }
    client = AsyncOpenAI(api_key=api_key, timeout=35, max_retries=0)
    response = await client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": (
                "당신은 한국 선거 뉴스룸의 기사 작성 보조자다. "
                "입력된 개표 집계와 근거 문서만 사용해 짧은 한국어 리드 1~2문장을 작성하라. "
                "title은 입력의 standard_headline을 글자 그대로 반환하라. "
                "입력에 없는 발언, 정책, 원인, 전망, 숫자를 만들지 마라. "
                "중간 집계를 확정 결과처럼 표현하지 마라. "
                "record_type=simulated는 반드시 시연용 재구성임을 밝히고 "
                "record_type=reported는 당시 보도 기록임을 구분하라. "
                "record_type=mixed에서는 오세훈·정원오와 나머지 후보 수치의 출처가 다름을 밝히라. "
                "counted_rate가 null이면 사건만 작성하고 개표율과 득표 수치는 언급하지 마라. "
                "외부 출처의 확인 수준을 과장하지 마라. "
                "JSON 객체 {title: 문자열, lead: 문자열}만 반환하라."
            )},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        temperature=0,
    )
    try:
        parsed = json.loads(response.choices[0].message.content or "{}")
    except (ValueError, IndexError, AttributeError) as exc:
        raise ValueError("AI 기사 응답을 해석할 수 없습니다.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("AI 기사 응답 형식이 올바르지 않습니다.")
    title, lead = parsed.get("title"), parsed.get("lead")
    if not isinstance(title, str) or not isinstance(lead, str):
        raise ValueError("AI가 제목과 리드를 반환하지 않았습니다.")
    title, lead = title.strip(), lead.strip()
    if not title or len(title) > 500 or "\n" in title or "\r" in title or not lead:
        raise ValueError("AI 기사 제목 또는 리드가 유효하지 않습니다.")

    # The authoritative facts and evidence IDs come from the validated snapshot,
    # so fact-checking still has the exact candidate/value/source strings it expects.
    factual.title = election_headline(snapshot)
    factual.body = lead + "\n\n" + factual.body
    return factual
