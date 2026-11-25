from fastapi.testclient import TestClient

from app import main
from app.services.storage_service import Storage


def frame_dateline(frame):
    from datetime import datetime
    return datetime.fromisoformat(frame["collected_at"]).isoformat()


def test_pledge_articles_are_dated_on_june_2():
    from app.models import Article
    from datetime import datetime
    article = Article(article_type="pledge", article_id="abc", title="t", body="b", status="approved",
                      evidence=[], created_at=datetime.now(), updated_at=datetime.now())
    dated = main.article_dateline(article)
    assert dated.startswith("2026-06-02T") and dated.endswith("+09:00")
    assert dated == main.article_dateline(article)


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
    row = client.get("/api/articles?status=approved").json()["articles"][0]
    assert row["posted"] is True
    assert row["author"] == "기자"
    assert row["posted_at"]
    assert row["dated_at"] == frame_dateline(frame)
    assert [log["action"] for log in client.get(path + "/audit").json()].count("posted") == 1


def test_posted_article_can_be_revised_or_deleted(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "storage", Storage(tmp_path / "articles.db"))
    client = TestClient(main.app)
    frame = client.get("/api/replay").json()[-1]

    def approved_article():
        article = client.post("/api/articles", json={"snapshot": frame}).json()
        path = f"/api/articles/{article['article_id']}"
        client.post(path + "/fact-check")
        client.post(path + "/human-review", json={"reviewer": "기자"})
        client.post(path + "/approve", json={"reviewer": "편집장"})
        client.post(path + "/post")
        return path

    path = approved_article()
    revised = client.post(path + "/revise")
    assert revised.status_code == 200 and revised.json()["status"] == "draft"
    client.post(path + "/fact-check")
    client.post(path + "/human-review", json={"reviewer": "기자"})
    client.post(path + "/approve", json={"reviewer": "편집장"})
    assert client.get("/api/articles?status=approved").json()["articles"][0]["posted"] is False

    other = approved_article()
    assert client.delete(other).status_code == 200
    assert client.get(other).status_code == 404
    assert client.delete(other).status_code == 404
