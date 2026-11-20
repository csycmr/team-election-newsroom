from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def create_article():
    snapshot = client.get("/api/election/snapshot?region=중구&step=2").json()
    evidence = client.get("/api/rag/search?q=선거 개표 보도 출처").json()["results"]
    response = client.post("/api/articles", json={"snapshot": snapshot, "evidence": evidence})
    assert response.status_code == 200
    return response.json()


def test_health_hides_secret_values():
    data = client.get("/health").json()
    assert data["status"] == "ok"
    assert "api_key" not in str(data).lower()


def test_approval_requires_factcheck_and_human_review():
    article = create_article()
    blocked = client.post(f"/api/articles/{article['article_id']}/approve", json={"reviewer": "편집장"})
    assert blocked.status_code == 409


def test_complete_approval_flow_and_audit_log():
    article = create_article()
    article_id = article["article_id"]
    checked = client.post(f"/api/articles/{article_id}/fact-check")
    assert checked.status_code == 200
    assert checked.json()["result"]["status"] == "pass"
    reviewed = client.post(f"/api/articles/{article_id}/human-review", json={"reviewer": "기자", "note": "검토"})
    assert reviewed.json()["status"] == "human_reviewed"
    approved = client.post(f"/api/articles/{article_id}/approve", json={"reviewer": "편집장", "note": "승인"})
    assert approved.json()["status"] == "approved"
    logs = client.get(f"/api/articles/{article_id}/audit").json()
    assert {row["action"] for row in logs} >= {"draft_created", "fact_checked", "human_reviewed", "approved"}


def test_cms_local_fallback_only_accepts_approved():
    article = create_article()
    blocked = client.post(f"/api/articles/{article['article_id']}/publish")
    assert blocked.status_code == 409


def test_websocket_delivers_election_snapshot():
    with client.websocket_connect("/ws/election?region=종로구") as websocket:
        data = websocket.receive_json()
        assert data["region"] == "종로구"
        assert data["mode"] == "demo"

