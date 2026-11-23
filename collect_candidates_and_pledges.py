"""NEC 2026 candidates -> candidate IDs -> election pledges (XML API).

Run from the project root, alongside fetch_election_pledges.py:
  .\.venv\Scripts\python.exe collect_candidates_and_pledges.py
  .\.venv\Scripts\python.exe collect_candidates_and_pledges.py --types 3,4,11 --sido 서울특별시

Requires approved NEC Candidate Information API (15000908) as well as
approved NEC Election Pledges API (15040587). Both may use the public data
portal general key. Keep secrets in .env, never commit it.
"""
import argparse
import csv
import json
import re
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from fetch_election_pledges import (read_local_env, request_xml, parse_response,
                                    normalize, build_url as pledge_url)

ROOT = Path(__file__).resolve().parent
CANDIDATE_URL = "https://apis.data.go.kr/9760000/PofelcddInfoInqireService/getPofelcddRegistSttusInfoInqire"
SOURCE_CANDIDATES = "https://www.data.go.kr/data/15000908/openapi.do"
SOURCE_PLEDGES = "https://www.data.go.kr/data/15040587/openapi.do"
RAW_CAND = ROOT / "data" / "raw" / "candidates" / "api"
RAW_PLEDGES = ROOT / "data" / "raw" / "pledges" / "api"
PROCESSED = ROOT / "data" / "processed"


def safe(s):
    return re.sub(r"[^0-9A-Za-z가-힣_-]", "_", s)


def fetch_candidate_pages(key, election_id, kind, sido):
    all_items = []
    page = 1
    while True:
        params = {"ServiceKey": urllib.parse.unquote(key), "pageNo": page,
                  "numOfRows": 100, "sgId": election_id, "sgTypecode": kind}
        if sido:
            params["sdName"] = sido
        url = CANDIDATE_URL + "?" + urllib.parse.urlencode(params)
        blob = request_xml(url)
        RAW_CAND.mkdir(parents=True, exist_ok=True)
        raw_path = RAW_CAND / f"{election_id}_{kind}_{safe(sido or 'all')}_page{page}.xml"
        raw_path.write_bytes(blob)
        code, msg, total, items = parse_response(blob)
        if code not in ("INFO-00", "00"):
            if code in ("INFO-03", "03"):
                raise RuntimeError(
                    f"후보자 정보 조회 결과 없음 ({kind}, {sido or '전국'}): {code} {msg}. "
                    "후보자 API의 2026년 데이터 제공 여부와 선거종류코드를 확인하세요."
                )
            raise RuntimeError(f"후보자 API 오류: {code or '미확인'} {msg} "
                               "(별도 활용신청 승인/키/요청변수 확인)")
        all_items.extend(items)
        print(f"후보자 조회: 종류={kind} 페이지={page}, 누적={len(all_items)}, 전체={total}")
        if not items or len(all_items) >= total:
            break
        page += 1
        if page > 200:
            raise RuntimeError("페이지가 비정상적으로 많아서 중단합니다.")
    return all_items



def load_pledge_xml(url, raw_path):
    import time

    if raw_path.exists():
        cached = raw_path.read_bytes()
        try:
            code, _, _, _ = parse_response(cached)
            if code in ("INFO-00", "00", "INFO-03", "03"):
                return cached
        except ValueError:
            pass

    for attempt in range(3):
        try:
            blob = request_xml(url)
            code, _, _, _ = parse_response(blob)
            if not code:
                raise ValueError("??? API ?? ??? ????.")
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(blob)
            return blob
        except (RuntimeError, ValueError) as exc:
            if attempt == 2:
                raise RuntimeError(
                    f"?? ?? 3? ??: {raw_path.name} / {exc}"
                ) from None
            time.sleep(2 ** attempt)

def fetch_pledges(key, election_id, kind, candidate_id):
    results = []
    page = 1
    while True:
        raw_path = RAW_PLEDGES / f"{election_id}_{kind}_{candidate_id}_page{page}.xml"
        blob = load_pledge_xml(
            pledge_url(key, election_id, kind, candidate_id, page),
            raw_path,
        )
        code, msg, total, items = parse_response(blob)
        if code in ("INFO-03", "03"):
            return [], "no_data"
        if code not in ("INFO-00", "00"):
            raise RuntimeError(f"공약 API 오류 ({kind}/{candidate_id}): {code} {msg}")
        results.extend(items)
        if not items or len(results) >= total:
            break
        page += 1
        if page > 30:
            raise RuntimeError("공약 응답 페이지 수가 비정상적입니다.")
    return [normalize(i, election_id, kind, candidate_id) for i in results], "found" if results else "no_data"


def main():
    ap = argparse.ArgumentParser(description="후보자 ID 자동 수집 후 공약 API 조회")
    ap.add_argument("--election-id", default="20260603")
    ap.add_argument("--types", default="3", help="3=광역단체장, 4=기초단체장, 11=교육감 (예: 3,4,11)")
    ap.add_argument("--sido", default="서울특별시", help="시도명. 전국은 --sido ''")
    ap.add_argument("--max-candidates", type=int, default=0, help="테스트용 조회 인원 제한 (0=전체)")
    args = ap.parse_args()
    kinds = [x.strip() for x in args.types.split(",")]
    if not kinds or any(k not in {"3", "4", "11"} for k in kinds):
        ap.error("--types는 3,4,11의 쉼표 구분 목록이어야 합니다.")
    if args.max_candidates < 0:
        ap.error("--max-candidates는 0 이상이어야 합니다.")

    pledge_key = read_local_env("ELEC_PRMS_SERVICE_KEY")
    candidate_key = read_local_env("ELEC_CANDIDATE_SERVICE_KEY") or pledge_key
    if not candidate_key or not pledge_key:
        raise SystemExit(".env에 ELEC_PRMS_SERVICE_KEY=일반인증키를 설정하세요. "
                         "후보자 API에 다른 키를 쓰면 ELEC_CANDIDATE_SERVICE_KEY도 설정하세요.")

    all_candidates = []
    all_pledges = []
    statuses = []
    for kind in kinds:
        candidates = fetch_candidate_pages(candidate_key, args.election_id, kind, args.sido)
        print(f"후보자 명단: {kind}번 {len(candidates)}명")
        valid = []
        for candidate in candidates:
            cid = candidate.get("huboid", "").strip()
            if not cid.isdecimal():
                raise RuntimeError(f"후보자 ID가 없거나 숫자가 아닙니다: {candidate.get('name','')} / {cid!r}")
            record = {
                "election_id": args.election_id,
                "election_type": kind,
                "candidate_id": cid,
                "candidate_name": candidate.get("name", ""),
                "party": candidate.get("jdName", ""),
                "province": candidate.get("sdName", ""),
                "district": candidate.get("sggName", ""),
                "municipality": candidate.get("wiwName", ""),
                "ballot_number": candidate.get("giho", ""),
                "registration_status": candidate.get("status", ""),
                "source_url": SOURCE_CANDIDATES,
            }
            valid.append(record)
        all_candidates.extend(valid)
        for c in valid[:args.max_candidates or None]:
            cid = c["candidate_id"]
            try:
                pledges, status = fetch_pledges(
                    pledge_key, args.election_id, kind, cid
                )
            except (RuntimeError, ValueError) as exc:
                pledges, status = [], "error"
                print(f"  API error: {cid} / {exc}")
            all_pledges.extend(pledges)
            statuses.append({"election_type": kind, "candidate_id": cid,
                             "candidate_name": c["candidate_name"], "pledge_status": status,
                             "pledge_records": len(pledges)})
            print(f"  {c['candidate_name']} ({cid}): {status}, {len(pledges)}건")

    PROCESSED.mkdir(parents=True, exist_ok=True)
    base = f"{args.election_id}_{safe(args.sido or 'all')}_{'-'.join(kinds)}"
    candidate_file = PROCESSED / f"candidates_{base}.csv"
    if all_candidates:
        with candidate_file.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(all_candidates[0]))
            writer.writeheader()
            writer.writerows(all_candidates)
    pledges_dir = PROCESSED / "pledges"
    pledges_dir.mkdir(parents=True, exist_ok=True)
    pledge_file = pledges_dir / f"pledges_{base}.json"
    pledge_file.write_text(json.dumps({
        "election_id": args.election_id,
        "election_types": kinds,
        "province_filter": args.sido,
        "candidate_source": SOURCE_CANDIDATES,
        "pledge_source": SOURCE_PLEDGES,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "notes": "공약 API의 데이터 없음은 공약 부재를 뜻하지 않음. 낙선 후보 선거공보 별도 수집 필요.",
        "candidates_queried": statuses,
        "pledge_records": all_pledges,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n저장 완료:")
    if all_candidates:
        print(candidate_file)
    print(pledge_file)
    print(f"후보자 {len(all_candidates)}명 / 공약 응답 후보 {sum(s['pledge_status']=='found' for s in statuses)}명")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from None
