import json
from tempfile import TemporaryDirectory
from pathlib import Path

from app.services.rag_service import LocalRAG


def test_real_pledges_in_existing_search():
    with TemporaryDirectory(dir=".") as temp_dir:
        tmp_path = Path(temp_dir)
        base = tmp_path / "sample.json"
        base.write_text('[{"evidence_id":"demo","title":"교육용","content":"가상","source":"demo","source_url":"x","published_at":"2026-06-03"}]', encoding="utf-8")
        candidates = tmp_path / "candidates.csv"
        candidates.write_text("candidate_id,candidate_name,election_type,province,district\n1,홍길동,3,서울특별시,서울특별시\n2,홍길동,4,부산광역시,해운대구\n", encoding="utf-8")
        payload = {"pledge_records": [
            {"candidate_id":"1", "election_type":"3", "promises":[{"number":1,"title":"돌봄 확대","content":"서울 돌봄 인력을 확대한다."}]},
            {"candidate_id":"2", "election_type":"4", "promises":[{"number":1,"title":"해양 관광","content":"부산 해양 관광 지원."}]},
        ]}
        pledges = tmp_path / "pledges.json"
        pledges.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        rag = LocalRAG(base, pledge_path=pledges, candidate_csv=candidates)
        result = rag.search("서울 홍길동 공약", limit=5)
        assert result and all("서울" in x.title for x in result)
        assert all(x.evidence_id.startswith("NEC-PRMS-") for x in result)
        assert not rag.search("제주 홍길동 공약")


def test_replay_index_stays_separate():
    replay = LocalRAG(Path(__file__).parents[1] / "data/replay/rag_documents.json")
    assert replay.search("서울시장 개표 100%")
    assert not any(d.get("pledge_candidate_id") for d in replay.documents)
