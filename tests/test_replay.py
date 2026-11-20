import csv

from fastapi.testclient import TestClient

from app.main import app
from app.services.replay_service import REPLAY_DIR


client = TestClient(app)


def test_replay_finishes_at_reported_totals():
    frames = client.get("/api/replay").json()
    assert [frame["step_id"] for frame in frames] == list(range(1, 13))

    for previous, current in zip(frames, frames[1:]):
        assert previous["counted_rate"] < current["counted_rate"]
        for before, after in zip(previous["candidates"], current["candidates"]):
            assert before["candidate_id"] == after["candidate_id"]
            assert before["votes"] <= after["votes"]

    with (REPLAY_DIR / "reported_results.csv").open(encoding="utf-8-sig") as file:
        reported = list(csv.DictReader(file))

    for frame in frames[-2:]:
        assert frame["record_type"] == "reported"
        for source, candidate in zip(
            (row for row in reported if row["evidence_id"] == frame["evidence_id"]),
            frame["candidates"],
            strict=True,
        ):
            assert candidate["votes"] == int(source["votes"])
            assert candidate["vote_rate"] == float(source["published_vote_rate"])

    assert frames[-1]["counted_rate"] == 100
    assert sum(candidate["votes"] for candidate in frames[-1]["candidates"]) == 5_232_982


def test_replay_websocket_delivers_simulated_frame():
    with client.websocket_connect("/ws/replay") as websocket:
        frame = websocket.receive_json()
        assert frame["step_id"] == 1
        assert frame["mode"] == "replay"
        assert frame["record_type"] == "simulated"


def test_replay_article_uses_verified_evidence_and_rejects_tampering():
    frame = client.get("/api/replay").json()[-1]
    response = client.post("/api/articles", json={"snapshot": frame})
    assert response.status_code == 200
    article = response.json()
    assert [row["evidence_id"] for row in article["evidence"]] == ["NEC-SEOUL-2"]
    assert "최종 개표 결과" in article["body"]

    path = f"/api/articles/{article['article_id']}"
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 409
    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 200
    assert client.post(path + "/publish").status_code == 409

    frame["candidates"][0]["votes"] += 1
    assert client.post("/api/articles", json={"snapshot": frame}).status_code == 409
