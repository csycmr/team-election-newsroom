import asyncio
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.models import ArticleCreate
from app.services.article_service import generate_ai_article
from app.services.replay_service import FRAMES


client = TestClient(app)


def test_default_template_is_backward_compatible():
    frame = client.get("/api/replay").json()[-1]
    result = client.post("/api/articles", json={"snapshot": frame})
    assert result.status_code == 200
    article = result.json()
    assert "최종 개표 결과" in article["body"]
    log = client.get(f"/api/articles/{article['article_id']}/audit").json()
    assert log[0]["actor"] == "template"


def test_ai_request_requires_key(monkeypatch):
    from app import main
    monkeypatch.setattr(main.settings, "openai_api_key", "")
    frame = client.get("/api/replay").json()[-1]
    result = client.post("/api/articles", json={"snapshot": frame, "generation_mode": "ai"})
    assert result.status_code == 503


def test_ai_replay_rejects_changed_frame_before_generation(monkeypatch):
    from app import main
    monkeypatch.setattr(main.settings, "openai_api_key", "test-key")
    frame = client.get("/api/replay").json()[-1]
    frame["candidates"][0]["votes"] += 1
    result = client.post("/api/articles", json={"snapshot": frame, "generation_mode": "ai"})
    assert result.status_code == 409


def test_ai_lead_keeps_authoritative_facts():
    # No network request: mock the OpenAI client's response.
    import json
    from types import SimpleNamespace

    fake = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
        content=json.dumps({"title": "서울시장 최종 개표", "lead": "[과거 보도 집계] 최종 집계가 발표됐다."}, ensure_ascii=False)))])
    with patch("openai.AsyncOpenAI") as cls:
        cls.return_value.chat.completions.create = AsyncMock(return_value=fake)
        request = ArticleCreate(snapshot=FRAMES[-1], generation_mode="ai")
        article = asyncio.run(generate_ai_article(request, "test-key", "test-model"))
    assert article.title == "서울시장 최종 개표"
    assert "[과거 보도 집계]" in article.body
    for candidate in FRAMES[-1].candidates:
        assert candidate.candidate_name in article.body
        assert f"{candidate.votes:,}" in article.body
        assert f"{candidate.vote_rate:.2f}" in article.body
    assert article.status == "draft"


def test_ai_rejects_empty_output_without_saving(monkeypatch):
    from app import main
    monkeypatch.setattr(main.settings, "openai_api_key", "test-key")
    with patch("app.main.generate_ai_article", new_callable=AsyncMock) as mock:
        mock.side_effect = ValueError("AI가 제목과 리드를 반환하지 않았습니다.")
        frame = client.get("/api/replay").json()[-1]
        result = client.post("/api/articles", json={"snapshot": frame, "generation_mode": "ai"})
    assert result.status_code == 502
