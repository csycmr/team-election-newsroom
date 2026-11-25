from fastapi.testclient import TestClient

from app import main
from app.services.storage_service import Storage


def test_only_approved_articles_can_be_posted_to_newsroom(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "articles.db"))
    client = TestClient(main.app)
    frame = client.get("/api/replay").json()[-1]
    article = client.post("/api/articles", json={"snapshot": frame}).json()
    path = f"/api/articles/{article['article_id']}"

    assert client.post(path + "/post").status_code == 409
    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 200
    assert client.get("/api/articles?status=approved").json()["articles"][0]["posted"] is False

    posted = client.post(path + "/post")
    assert posted.status_code == 200 and posted.json()["posted"] is True
    assert client.post(path + "/post").status_code == 200
    assert client.get("/api/articles?status=approved").json()["articles"][0]["posted"] is True
    assert [log["action"] for log in client.get(path + "/audit").json()].count("posted") == 1
