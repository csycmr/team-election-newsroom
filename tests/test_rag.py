from pathlib import Path

from app.services.rag_service import LocalRAG


def test_rag_returns_source_metadata():
    rag = LocalRAG(Path(__file__).parents[1] / "data/sample/rag_documents.json")
    result = rag.search("개표 보도 출처 기준시각")
    assert result
    assert result[0].source
    assert result[0].source_url
    assert result[0].published_at

