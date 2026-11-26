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
    assert "서울시장 선거 개표가 완료됐다" in article["body"]
    assert "NEC-SEOUL-2" not in article["body"]
    assert "출처:" not in article["body"]

    path = f"/api/articles/{article['article_id']}"
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 409
    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 200
    assert client.post(path + "/publish").status_code == 409

    frame["candidates"][0]["votes"] += 1
    assert client.post("/api/articles", json={"snapshot": frame}).status_code == 409


def test_each_timeline_step_creates_a_draft_with_its_own_timestamp_and_source():
    frames = client.get("/api/count-timeline").json()
    assert [frame["step_id"] for frame in frames] == list(range(1, 16))
    assert [frame["step_id"] for frame in frames if frame["counted_rate"] is None] == [1, 4, 14]
    assert [frames[index]["counted_rate"] for index in (4, 6, 10, 14)] == [15.42, 46.72, 97.17, 100]

    for frame in frames:
        snapshot = frame["article_snapshot"]
        response = client.post("/api/articles", json={"snapshot": snapshot})
        assert response.status_code == 200
        article = response.json()
        assert article["snapshot"] == snapshot
        assert snapshot["step_id"] == frame["step_id"]
        assert snapshot["collected_at"] == frame["timestamp_kst"]
        assert f'{frame["step_id"]}단계' not in article["body"]
        assert snapshot["collected_at"] not in article["body"]
        assert "근거 [" not in article["body"]
        assert article["evidence"][0]["source_url"] == snapshot["source_url"]
        if frame["counted_rate"] is None:
            assert frame["event"] in article["body"]
            assert "개표 진행률" not in article["body"]
        if snapshot["record_type"] == "mixed":
            assert "권영국 후보" not in article["body"]

    snapshot = frames[10]["article_snapshot"]
    snapshot["candidates"][0]["votes"] += 1
    assert client.post("/api/articles", json={"snapshot": snapshot}).status_code == 409
