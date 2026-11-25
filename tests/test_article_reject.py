from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_editor_can_reject_only_after_human_review():
    snapshot = client.get("/api/election/snapshot?region=중구&step=2").json()
    article = client.post("/api/articles", json={"snapshot": snapshot}).json()
    path = f"/api/articles/{article['article_id']}"

    assert client.post(path + "/reject", json={"reviewer": "편집장"}).status_code == 409
    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200

    rejected = client.post(path + "/reject", json={"reviewer": "편집장"})
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 409
    assert any(log["action"] == "rejected" for log in client.get(path + "/audit").json())
