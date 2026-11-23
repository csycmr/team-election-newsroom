import csv
import json

from app.config import ROOT
from app.models import ElectionSnapshot


REPLAY_DIR = ROOT / "data/replay"
FRAMES = [
    ElectionSnapshot.model_validate(row)
    for row in json.loads((REPLAY_DIR / "snapshots.json").read_text(encoding="utf-8"))
]


def replay_snapshot(step: int) -> ElectionSnapshot:
    return FRAMES[step - 1]


def _count_timeline() -> list[dict]:
    """Build the displayed replay from the checked-in reporting timeline."""
    full_counts = {
        frame.counted_rate: frame.model_dump(mode="json")
        for frame in FRAMES
        if frame.record_type == "reported"
    }
    roster = [candidate.model_dump() for candidate in FRAMES[-1].candidates]
    prefixes = {"seoul-1": "oh_se_hoon", "seoul-2": "jung_won_oh"}
    with (REPLAY_DIR / "count_timeline.csv").open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))

    timeline = []
    for step, row in enumerate(rows, start=1):
        rate = float(row["counted_rate_pct"]) if row["counted_rate_pct"] else None
        full_count = full_counts.get(rate)
        candidates = []
        if full_count:
            candidates = full_count["candidates"]
        elif rate is not None:
            for candidate in roster:
                prefix = prefixes.get(candidate["candidate_id"])
                if prefix and row[f"{prefix}_votes"] and row[f"{prefix}_vote_rate_pct"]:
                    candidates.append({
                        **candidate,
                        "votes": int(row[f"{prefix}_votes"]),
                        "vote_rate": float(row[f"{prefix}_vote_rate_pct"]),
                    })
        timeline.append({
            **row,
            "step_id": step,
            "counted_rate": rate,
            "candidates": candidates,
            "article_snapshot": full_count,
        })
    return timeline


COUNT_TIMELINE = _count_timeline()
