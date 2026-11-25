import csv
import json

from app.config import ROOT
from app.models import ElectionSnapshot, Evidence


REPLAY_DIR = ROOT / "data/replay"
FRAMES = [
    ElectionSnapshot.model_validate(row)
    for row in json.loads((REPLAY_DIR / "snapshots.json").read_text(encoding="utf-8"))
]


def replay_snapshot(step: int) -> ElectionSnapshot:
    return FRAMES[step - 1]


def _count_timeline() -> list[dict]:
    """Build the displayed replay from the checked-in reporting timeline."""
    roster = [candidate.model_dump(exclude={"votes", "vote_rate"}) for candidate in FRAMES[-1].candidates]
    prefixes = {
        "seoul-1": "oh_se_hoon",
        "seoul-2": "jung_won_oh",
        "seoul-3": "kwon_young_guk",
        "seoul-4": "yoo_ji_hye",
        "seoul-5": "kim_jeong_cheol",
    }
    with (REPLAY_DIR / "count_timeline.csv").open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))

    timeline = []
    for step, row in enumerate(rows, start=1):
        rate = float(row["counted_rate_pct"]) if row["counted_rate_pct"] else None
        candidates = []
        if rate is not None:
            for candidate in roster:
                prefix = prefixes.get(candidate["candidate_id"])
                if prefix and row[f"{prefix}_votes"] and row[f"{prefix}_vote_rate_pct"]:
                    candidates.append({
                        **candidate,
                        "votes": int(row[f"{prefix}_votes"]),
                        "vote_rate": float(row[f"{prefix}_vote_rate_pct"]),
                        **(
                            {"is_simulated": True}
                            if prefix not in ("oh_se_hoon", "jung_won_oh")
                            and row.get("other_candidate_votes_basis") == "simulation_interpolation"
                            else {}
                        ),
                    })
        record_type = "reported"
        if row["time_basis"] == "simulated":
            record_type = "simulated"
        elif any(candidate.get("is_simulated") for candidate in candidates):
            record_type = "mixed"

        election = FRAMES[-1]
        snapshot = ElectionSnapshot(
            election_id=election.election_id,
            election_name=election.election_name,
            region=election.region,
            step_id=step,
            counted_rate=rate,
            collected_at=row["timestamp_kst"],
            source="연합뉴스 보도 집계" if row["additional_source_url"] else row["source_name"],
            source_url=row["additional_source_url"] or row["source_url"],
            mode="replay",
            record_type=record_type,
            evidence_id=f"COUNT-TIMELINE-{step:02d}",
            candidates=candidates,
            timeline_event=row["event"],
            timeline_note=row["note"],
            time_basis=row["time_basis"],
        )
        timeline.append({
            **row,
            "step_id": step,
            "counted_rate": rate,
            "candidates": candidates,
            "article_snapshot": snapshot.model_dump(mode="json"),
            "counted_valid_votes": int(row["counted_valid_votes"]) if row["counted_valid_votes"] else None,
        })
    return timeline


COUNT_TIMELINE = _count_timeline()


TIMELINE_SNAPSHOTS = [
    ElectionSnapshot.model_validate(frame["article_snapshot"]) for frame in COUNT_TIMELINE
]


def timeline_evidence(snapshot: ElectionSnapshot) -> Evidence:
    return Evidence(
        evidence_id=snapshot.evidence_id,
        title=f"서울시장 개표 {snapshot.step_id}단계 · {snapshot.timeline_event}",
        content=snapshot.timeline_note or snapshot.timeline_event,
        source=snapshot.source,
        source_url=snapshot.source_url,
        published_at=snapshot.collected_at.date().isoformat(),
    )
