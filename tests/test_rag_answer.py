import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.services.rag_service import LocalRAG, answer_question


client = TestClient(app)


def test_replay_answer_without_api_key_has_citations():
    searcher = LocalRAG(Path(__file__).parents[1] / "data/replay/rag_documents.json")
    result = asyncio.run(answer_question("서울시장 개표 100% 보도 집계", searcher))
    assert result["mode"] == "extractive"
    assert result["evidence_ids"]
    assert all(ref in result["answer"] for ref in result["evidence_ids"])
    assert result["evidence"]


def test_no_evidence_returns_explicit_no_answer():
    searcher = LocalRAG(Path(__file__).parents[1] / "data/replay/rag_documents.json")
    result = asyncio.run(answer_question("ㅁㅁㅁㅁㅁㅁㅁ", searcher))
    assert result["mode"] == "no_evidence"
    assert result["evidence_ids"] == []


def test_rag_answer_endpoint_rejects_short_query():
    assert client.get("/api/rag/answer?q=a&replay=true").status_code == 422


def test_existing_search_endpoint_works():
    response = client.get("/api/rag/search?q=서울시장&replay=true")
    assert response.status_code == 200
    assert response.json()["results"]
