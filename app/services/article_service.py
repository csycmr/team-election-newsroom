from uuid import uuid4

from app.models import Article, ArticleCreate
from app.services.time_service import now_seoul


def generate_article(request: ArticleCreate) -> Article:
    snapshot = request.snapshot
    ordered = sorted(snapshot.candidates, key=lambda candidate: candidate.votes, reverse=True)
    leader = ordered[0]
    rows = ", ".join(f"{c.candidate_name} {c.votes:,}표({c.vote_rate:.2f}%)" for c in ordered)
    evidence_text = ""
    if request.evidence:
        refs = ", ".join(f"{e.title}({e.source})" for e in request.evidence[:3])
        ids = ", ".join(e.evidence_id for e in request.evidence[:3])
        evidence_text = f" 근거 [{ids}] {refs}."
    if snapshot.mode == "replay":
        label = "시연용 재구성" if snapshot.record_type == "simulated" else "과거 보도 기록"
        stage = "최종 개표 결과입니다." if snapshot.counted_rate == 100 else "개표 중간 단계입니다."
    else:
        label = "교육용 모의 보도"
        stage = "개표 중간 단계입니다."
    body = (
        f"[{label}] {snapshot.collected_at.isoformat()} 기준 {snapshot.election_name} "
        f"{snapshot.region} {snapshot.step_id}단계 집계에서 {rows}로 집계됐다. "
        f"현재 개표 진행률은 {snapshot.counted_rate:.2f}%이며 {leader.candidate_name} 후보가 가장 많은 표를 얻고 있다."
        f"{evidence_text} {stage} 초안은 팩트체크와 편집 검토를 거쳐야 한다. "
        f"출처: {snapshot.source} ({snapshot.source_url})"
    )
    now = now_seoul()
    return Article(article_id=uuid4().hex, title=f"{snapshot.region} 개표 {snapshot.step_id}단계 속보",
                   body=body, status="draft", snapshot=snapshot, evidence=request.evidence,
                   created_at=now, updated_at=now)

