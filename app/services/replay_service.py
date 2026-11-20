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
