"""Convert NEC candidate pledge records into searchable evidence documents."""
import csv
import json
from pathlib import Path

SOURCE = "https://www.data.go.kr/data/15040587/openapi.do"
PROVINCES = {
    "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시",
    "인천": "인천광역시", "광주": "광주광역시", "대전": "대전광역시",
    "울산": "울산광역시", "세종": "세종특별자치시", "경기": "경기도",
    "강원": "강원특별자치도", "충북": "충청북도", "충남": "충청남도",
    "전북": "전북특별자치도", "전남": "전라남도", "경북": "경상북도",
    "경남": "경상남도", "제주": "제주특별자치도",
}


def query_provinces(query: str) -> set[str]:
    return {full for short, full in PROVINCES.items()
            if full in query or short in query}


def load_pledge_documents(pledge_path: Path, candidate_csv: Path):
    payload = json.loads(pledge_path.read_text(encoding="utf-8"))
    with candidate_csv.open(encoding="utf-8-sig", newline="") as f:
        candidates = {row["candidate_id"]: row for row in csv.DictReader(f)}
    docs = []
    for record in payload.get("pledge_records", []):
        cid = str(record.get("candidate_id", ""))
        candidate = candidates.get(cid, {})
        name = candidate.get("candidate_name") or record.get("candidate_name", "")
        province = candidate.get("province") or record.get("province", "")
        district = candidate.get("district") or record.get("election_district", "")
        kind = str(candidate.get("election_type") or record.get("election_type", ""))
        for ordinal, pledge in enumerate(record.get("promises", []), 1):
            title = str(pledge.get("title", "")).strip()
            content = str(pledge.get("content", "")).strip()
            if not (title or content):
                continue
            number = str(pledge.get("number") or ordinal)
            category = str(pledge.get("category", "")).strip()
            docs.append({
                "evidence_id": f"NEC-PRMS-20260603-{kind}-{cid}-{ordinal}",
                "title": f"{province} {district} {name} 후보 공약: {title}",
                "content": f"공약 분야: {category}. 공약 내용: {content}",
                "source": "중앙선거관리위원회 선거공약정보 OpenAPI (후보자 제안)",
                "source_url": SOURCE,
                "published_at": str(record.get("retrieved_at") or payload.get("retrieved_at", ""))[:10],
                "candidate_name": name,
                "pledge_candidate_id": cid,
                "province": province,
                "district": district,
                "election_type": kind,
            })
    return docs, {c["candidate_name"] for c in candidates.values()
                  if len(c.get("candidate_name", "")) >= 2}
