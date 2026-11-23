from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def new_article():
    snapshot = client.get("/api/election/snapshot?region=중구&step=2").json()
    response = client.post("/api/articles", json={"snapshot": snapshot})
    assert response.status_code == 200
    return response.json()


def test_article_edit_resets_factcheck_and_requires_recheck():
    article = new_article()
    path = f"/api/articles/{article['article_id']}"
    checked = client.post(path + "/fact-check")
    assert checked.json()["result"]["status"] == "pass"

    updated = client.put(path, json={
        "title": "  중구 개표 속보 수정  ",
        "body": "  " + article["body"] + "  ",
    })
    assert updated.status_code == 200
    assert updated.json()["title"] == "중구 개표 속보 수정"
    assert updated.json()["status"] == "draft"
    assert client.get(path).json()["title"] == "중구 개표 속보 수정"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 409
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 409

    assert client.post(path + "/fact-check").json()["result"]["status"] == "pass"
    assert client.post(path + "/human-review", json={"reviewer": "기자"}).status_code == 200
    assert client.post(path + "/approve", json={"reviewer": "편집장"}).status_code == 200
    assert client.put(path, json={"title": "다시 수정", "body": article["body"]}).status_code == 409
    logs = client.get(path + "/audit").json()
    assert any(log["action"] == "article_updated" for log in logs)


def test_article_edit_rejects_empty_or_multiline_title():
    article = new_article()
    path = f"/api/articles/{article['article_id']}"
    for title, body in [("  ", article["body"]), ("두 줄\n제목", article["body"]), ("제목", "   ")]:
        assert client.put(path, json={"title": title, "body": body}).status_code == 422
    assert client.get(path).json()["status"] == "draft"
