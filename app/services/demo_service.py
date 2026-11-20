from copy import deepcopy

from app.models import CandidateResult, ElectionSnapshot
from app.services.time_service import now_seoul


BASE = [
    {"candidate_id": "c1", "candidate_name": "김하늘", "party": "가상미래당", "votes": 18420},
    {"candidate_id": "c2", "candidate_name": "이바다", "party": "시민연합", "votes": 17310},
    {"candidate_id": "c3", "candidate_name": "박푸름", "party": "무소속", "votes": 5260},
]


def demo_snapshot(step: int = 1, region: str = "중구") -> ElectionSnapshot:
    rows = deepcopy(BASE)
    factor = max(step, 1)
    for index, row in enumerate(rows):
        row["votes"] += factor * (310 - index * 70)
    total = sum(row["votes"] for row in rows)
    candidates = [CandidateResult(**row, vote_rate=round(row["votes"] / total * 100, 2)) for row in rows]
    return ElectionSnapshot(
        election_id="edu-2026-01",
        election_name="2026 교육용 모의 지방선거",
        region=region,
        step_id=step,
        counted_rate=min(12.5 + step * 7.5, 100),
        collected_at=now_seoul(),
        source="교육용 모의 개표 데이터",
        source_url="data/sample/election_results.json",
        mode="demo",
        candidates=candidates,
    )

