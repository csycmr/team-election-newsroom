from fastapi.testclient import TestClient

from app import main
from app.services.storage_service import Storage


def test_article_list_filters_and_returns_latest(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "articles.db"))
    client = TestClient(main.app)
    frame = client.get("/api/replay").json()[-1]

    first = client.post("/api/articles", json={"snapshot": frame}).json()
    second = client.post("/api/articles", json={"snapshot": frame}).json()
    path = f"/api/articles/{second['article_id']}"
    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 200

    all_items = client.get("/api/articles").json()
    assert all_items["count"] == 2
    assert {row["article_id"] for row in all_items["articles"]} == {first["article_id"], second["article_id"]}
    assert all_items["articles"][0]["article_id"] == second["article_id"]

    approved = client.get("/api/articles?status=approved").json()
    assert approved["count"] == 1
    assert approved["articles"][0]["article_id"] == second["article_id"]
    assert approved["articles"][0]["status"] == "approved"
    assert approved["articles"][0]["snapshot"]["evidence_id"] == "NEC-SEOUL-2"
    assert client.get(f"/api/articles/{first['article_id']}").status_code == 200

    drafts = client.get("/api/articles?status=draft").json()
    assert [row["article_id"] for row in drafts["articles"]] == [first["article_id"]]
    assert client.get("/api/articles?status=rejected").json() == {"articles": [], "count": 0}


def test_article_list_rejects_bad_filter_and_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "articles.db"))
    client = TestClient(main.app)
    assert client.get("/api/articles?status=not_a_status").status_code == 422
    assert client.get("/api/articles?limit=0").status_code == 422
    assert client.get("/api/articles?limit=101").status_code == 422
    assert client.get("/api/articles").json() == {"articles": [], "count": 0}


def test_article_list_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "articles.db"))
    client = TestClient(main.app)
    frame = client.get("/api/replay").json()[-1]
    for _ in range(3):
        assert client.post("/api/articles", json={"snapshot": frame}).status_code == 200
    listed = client.get("/api/articles?limit=2").json()
    assert listed["count"] == 2
    assert len(listed["articles"]) == 2
