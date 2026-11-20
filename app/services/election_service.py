import httpx

from app.config import Settings
from app.models import CandidateResult, ElectionSnapshot
from app.services.demo_service import demo_snapshot
from app.services.time_service import now_seoul


async def fetch_snapshot(settings: Settings, region: str = "중구", step: int = 1) -> ElectionSnapshot:
    if settings.app_mode != "live" or not settings.election_data_api_key:
        return demo_snapshot(step, region)

    # 공공데이터포털 서비스는 실시간 개표 스트림이 아니다. 정확한 operation과
    # 선거 ID는 승인 후 받은 최신 활용가이드 기준으로 설정한다.
    endpoint = settings.election_data_api_url.rstrip("/") + "/getVoteSttusInfoInqire"
    params = {
        "ServiceKey": settings.election_data_api_key,
        "pageNo": 1,
        "numOfRows": 100,
        "resultType": "json",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(endpoint, params=params)
        response.raise_for_status()
        payload = response.json()
    items = payload.get("response", {}).get("body", {}).get("items", {}).get("item", [])
    if isinstance(items, dict):
        items = [items]
    if not items:
        return demo_snapshot(step, region)
    candidates = []
    for idx, row in enumerate(items[:10]):
        votes = int(row.get("getcnt", row.get("voteCnt", 0)) or 0)
        rate = float(row.get("getrate", row.get("voteRate", 0)) or 0)
        candidates.append(CandidateResult(
            candidate_id=str(row.get("huboid", idx)),
            candidate_name=str(row.get("name", row.get("jdName", f"후보 {idx + 1}"))),
            party=str(row.get("jdName", "정당 미상")), votes=votes, vote_rate=rate,
        ))
    return ElectionSnapshot(
        election_id="official", election_name="공식 선거 데이터", region=region,
        step_id=step, counted_rate=0, collected_at=now_seoul(),
        source="중앙선거관리위원회·공공데이터포털",
        source_url=settings.election_data_api_url, mode="live", candidates=candidates,
    )

