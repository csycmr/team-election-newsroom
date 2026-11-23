"""Fetch NEC candidate election promises from the public-data portal.

Usage (from project root):
    py -3.14 fetch_election_pledges.py --candidate-id ACTUAL_ID --election-type 3

Set ELEC_PRMS_SERVICE_KEY=<public data portal key> in local .env.
Raw response is saved in data/raw/pledges/api; normalized data in data/processed/pledges.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = "https://apis.data.go.kr/9760000/ElecPrmsInfoInqireService/getCnddtElecPrmsInfoInqire"
ROOT = Path(__file__).resolve().parent
KEY_NAME = "ELEC_PRMS_SERVICE_KEY"


def read_local_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    env_path = ROOT / ".env"
    if env_path.exists():
        for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if key.strip() == name:
                return val.strip().strip('"').strip("'")
    return ""


def text(node: ET.Element, key: str) -> str:
    element = node.find(key)
    return (element.text or "").strip() if element is not None else ""


def build_url(key: str, election_id: str, election_type: str, candidate_id: str, page: int) -> str:
    # Public-data-portal keys can be already URL-encoded. Decode exactly once,
    # then let urlencode encode once to avoid double-encoding '%' characters.
    decoded_key = urllib.parse.unquote(key)
    return ENDPOINT + "?" + urllib.parse.urlencode({
        "ServiceKey": decoded_key,
        "pageNo": page,
        "numOfRows": 10,
        "sgId": election_id,
        "sgTypecode": election_type,
        "cnddtId": candidate_id,
    })


def request_xml(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ElectionNewsroom/1.0", "Accept": "application/xml, text/xml, */*"})
    try:
        with urllib.request.urlopen(req, timeout=35) as res:
            return res.read()
    except urllib.error.HTTPError as exc:
        # Never print the URL; it contains the ServiceKey.
        raise RuntimeError(f"HTTP {exc.code}: 서버 요청 실패 (인증키 및 서비스 상태 확인)") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"네트워크 연결 실패: {exc.reason}") from exc


def parse_response(blob: bytes) -> tuple[str, str, int, list[dict]]:
    try:
        tree = ET.fromstring(blob)
    except ET.ParseError as exc:
        raise ValueError("XML이 아닌 응답을 받았습니다. API 접속 상태를 확인하세요.") from exc
    code = (tree.findtext(".//resultCode") or "").strip()
    message = (tree.findtext(".//resultMsg") or "").strip()
    total_str = (tree.findtext(".//totalCount") or "0").strip()
    total = int(total_str) if total_str.isdecimal() else 0
    items = [{child.tag: (child.text or "").strip() for child in node} for node in tree.findall(".//item")]
    return code, message, total, items


def normalize(item: dict, election_id: str, election_type: str, candidate_id: str) -> dict:
    promises = []
    for no in range(1, 11):
        title = item.get(f"prmsTitle{no}", "").strip()
        content = item.get(f"prmsCont{no}", "").strip()
        if not title and not content:
            continue
        promises.append({
            "number": item.get(f"prmsOrd{no}") or no,
            "category": item.get(f"prmsRealmName{no}", ""),
            "title": title,
            "content": content,
        })
    return {
        "election_id": item.get("sgId", election_id),
        "election_type": item.get("sgTypecode", election_type),
        "candidate_id": item.get("cnddtId", candidate_id),
        "candidate_name": item.get("krName", ""),
        "party": item.get("partyName", ""),
        "election_district": item.get("sggName", ""),
        "province": item.get("sidoName", ""),
        "municipality": item.get("wiwName", ""),
        "declared_promise_count": item.get("prmsCnt", ""),
        "promises": promises,
        "source": "중앙선거관리위원회 선거공약정보 OpenAPI",
        "source_url": "https://www.data.go.kr/data/15040587/openapi.do",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="선관위 후보자 공약 OpenAPI 1명 조회")
    parser.add_argument("--candidate-id", required=True, help="실제 선관위 후보자 ID (기호번호 아님)")
    parser.add_argument("--election-id", default="20260603")
    parser.add_argument("--election-type", choices=["3", "4", "11"], default="3", help="3 광역단체장, 4 기초단체장, 11 교육감")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{8}", args.election_id):
        parser.error("--election-id는 YYYYMMDD 형식이어야 합니다")
    if not re.fullmatch(r"\d+", args.candidate_id):
        parser.error("--candidate-id는 선관위 숫자 ID여야 합니다")
    key = read_local_env(KEY_NAME)
    if not key:
        print(f"인증키 없음: 프로젝트 .env에 {KEY_NAME}=발급받은_인증키 를 추가하세요.", file=sys.stderr)
        return 1

    raw_dir = ROOT / "data" / "raw" / "pledges" / "api"
    processed_dir = ROOT / "data" / "processed" / "pledges"
    raw_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{args.election_id}_{args.election_type}_{args.candidate_id}"

    records = []
    total_count = None
    page = 1
    while True:
        blob = request_xml(build_url(key, args.election_id, args.election_type, args.candidate_id, page))
        code, message, total, items = parse_response(blob)
        raw_file = raw_dir / f"{stem}_page{page}.xml"
        raw_file.write_bytes(blob)
        print(f"원본 저장: {raw_file.relative_to(ROOT)}")
        if code not in {"00", "0", "NORMAL_SERVICE"}:
            print(f"API 응답: {code or '(코드 없음)'} / {message or '(메시지 없음)'}")
            if code == "INFO-03":
                print("조회 결과 없음: 선거일·선거종류·실제 후보자 ID 및 API 제공 범위를 확인하세요.")
            return 2
        total_count = total
        records.extend(items)
        if not items or len(records) >= total or page >= 100:
            break
        page += 1

    if not records:
        print("정상 응답이지만 공약 항목이 없습니다.")
        return 2

    output = [normalize(item, args.election_id, args.election_type, args.candidate_id) for item in records]
    destination = processed_dir / f"{stem}.json"
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"정제 저장: {destination.relative_to(ROOT)}")
    print(f"결과 {len(output)}건 / 후보 {', '.join(x['candidate_name'] or '(이름 없음)' for x in output)} / 공약 {sum(len(x['promises']) for x in output)}개")
    print("공약 내용은 후보자의 제안이며, 확정된 정책이나 이행 실적이 아닙니다.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        sys.exit(1)
