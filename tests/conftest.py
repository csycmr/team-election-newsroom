import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["APP_MODE"] = "demo"
os.environ["DATABASE_URL"] = "sqlite:///data/processed/test_election_newsroom.db"

