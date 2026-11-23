"""Read the local NEC governor election CSV and derive Seoul mayor data.

Run with the project virtualenv Python: collect_seoul_mayor_results.py
Uses only Python's standard library. Reads data/raw/, writes data/processed/.
Does not alter data/replay/ or any existing article database.
"""
import csv
import io
import json
import re
from collections import defaultdict
from pathlib import Path

SOURCE_PAGE = "https://www.data.go.kr/data/15162288/fileData.do"
ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
SEOUL_RAW = OUT / "2026_seoul_mayor_rows.csv"
DISTRICT_CSV = OUT / "2026_seoul_mayor_district_votes.csv"
DISTRICT_JSON = OUT / "2026_seoul_mayor_district_votes.json"

# Figures already present in the project's reported final snapshot.
EXPECTED_VOTES = {
    "오세훈": 2575819,
    "정원오": 2515560,
    "권영국": 54315,
    "유지혜": 43967,
    "김정철": 43321,
}
DISTRICTS = {
    "종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구",
    "강북구","도봉구","노원구","은평구","서대문구","마포구","양천구",
    "강서구","구로구","금천구","영등포구","동작구","관악구","서초구",
    "강남구","송파구","강동구",
}
FIELDS = ["시도명","구시군명","읍면동명","구분명","후보자","득표수"]

def retrieve():
    OUT.mkdir(parents=True, exist_ok=True)
    if not RAW_DIR.is_dir():
        raise SystemExit(f"원본 데이터 폴더가 없습니다: {RAW_DIR}")
    options = sorted(p for p in RAW_DIR.glob("*.csv") if p.is_file())
    if not options:
        raise SystemExit(f"{RAW_DIR}에 CSV 파일이 없습니다.")
    matched = []
    for path in options:
        try:
            # Choose by the source's actual header, not a guessed filename.
            with path.open("rb") as source_file:
                header = source_file.readline()
            for encoding in ("utf-8-sig", "cp949", "euc-kr"):
                try:
                    columns = next(csv.reader(io.StringIO(header.decode(encoding))))
                    if set(FIELDS).issubset({name.strip().lstrip("\ufeff") for name in columns}):
                        matched.append(path)
                        break
                except (UnicodeDecodeError, StopIteration, csv.Error):
                    pass
        except OSError as exc:
            raise SystemExit(f"CSV를 읽을 수 없습니다: {path}: {exc}") from exc
    if len(matched) != 1:
        raise SystemExit(f"공식 개표결과 형식의 CSV가 정확히 하나 필요합니다. 발견: {[p.name for p in matched]}")
    print("원본 사용 (수정하지 않음):", matched[0])
    return matched[0].read_bytes()

def parse(raw):
    for encoding in ["utf-8-sig", "cp949", "euc-kr"]:
        try:
            text = raw.decode(encoding)
            reader = csv.DictReader(io.StringIO(text))
            headings = [(s or "").strip().lstrip("\ufeff") for s in (reader.fieldnames or [])]
            if not set(FIELDS).issubset(headings):
                continue
            reader.fieldnames = headings
            return list(reader), headings, encoding
        except UnicodeDecodeError:
            continue
    raise SystemExit("인코딩 또는 컬럼 구성이 예상과 다릅니다. 원본 CSV 헤더를 확인하세요.")

def main():
    raw = retrieve()
    rows, headers, encoding = parse(raw)
    print(f"원본 {len(rows):,}행 · 인코딩 {encoding} · 컬럼 {', '.join(headers)}")
    seoul = [r for r in rows if r["시도명"].strip() in {"서울", "서울특별시"}]
    if not seoul:
        raise SystemExit("서울특별시 데이터가 없습니다. 원본을 확인하세요.")
    with SEOUL_RAW.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(seoul)
    print(f"서울 원자료 {len(seoul):,}행 저장:", SEOUL_RAW)

    # Candidate vote rows only: exclude electorate/turnout/invalid vote rows.
    # All voting methods are counted once each, only across actual 25 districts.
    votes = defaultdict(lambda: defaultdict(int))
    unknown_candidate = set()
    excluded_summary = 0
    for r in seoul:
        district = r["구시군명"].strip()
        name_field = r["후보자"].strip()
        if district not in DISTRICTS:
            excluded_summary += 1
            continue
        candidates = [name for name in EXPECTED_VOTES if re.search(rf"(?<![가-힣]){re.escape(name)}$", name_field)]
        if not candidates:
            if name_field not in {"선거인수","투표수","기권자수","무효 투표수","무효투표수","기타"}:
                unknown_candidate.add(name_field)
            continue
        if len(candidates) != 1:
            raise SystemExit(f"후보 이름 해석 불가: {name_field}")
        count = r["득표수"].strip().replace(",", "")
        if not re.fullmatch(r"\d+", count):
            raise SystemExit(f"득표수 비정상: {district}/{name_field}={count!r}")
        votes[district][candidates[0]] += int(count)

    totals = {name: sum(v[name] for v in votes.values()) for name in EXPECTED_VOTES}
    print("검증: 서울 25개 구:", len(votes), "/ 25")
    for name, actual in totals.items():
        print(f"  {name}: 집계 {actual:,}표 / 기준 {EXPECTED_VOTES[name]:,}표")
    if unknown_candidate:
        print("인식하지 못한 항목:", sorted(unknown_candidate)[:15])
        raise SystemExit("미확인 후보·집계 항목이 있어 집계를 중단했습니다. 원본의 후보자 컬럼을 확인하세요.")
    print("서울 내 비자치구 요약·기타 행:", excluded_summary)

    if set(votes) != DISTRICTS or totals != EXPECTED_VOTES:
        raise SystemExit(
            "서울 25개 구 또는 최종 후보 득표 합계가 기존 보도 집계와 일치하지 않습니다. "
            "잘못된 지역별 수치를 저장하지 않았습니다. 로그와 서울 원자료를 확인하세요."
        )

    output = []
    for district in sorted(DISTRICTS):
        candidate_votes = votes[district]
        valid_total = sum(candidate_votes.values())
        winner = max(EXPECTED_VOTES, key=lambda name: candidate_votes[name])
        second = sorted(EXPECTED_VOTES, key=lambda name: candidate_votes[name], reverse=True)[1]
        rec = {
            "자치구": district, "유효득표합계": valid_total,
            "1위후보": winner, "1위표차": candidate_votes[winner] - candidate_votes[second],
        }
        for name in EXPECTED_VOTES:
            rec[f"{name}_득표수"] = candidate_votes[name]
            rec[f"{name}_득표율"] = round(100 * candidate_votes[name] / valid_total, 4) if valid_total else 0
        output.append(rec)
    with DISTRICT_CSV.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(output[0]))
        writer.writeheader()
        writer.writerows(output)
    DISTRICT_JSON.write_text(json.dumps({
        "election": "2026-06-03 제9회 전국동시지방선거 서울특별시장",
        "record_type": "official_final",
        "source_url": SOURCE_PAGE,
        "source_note": "선거일 종료 후 최종 개표 자료; 기존 1~10단계 시연용 중간 집계와 별도",
        "districts": output,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("완료: 25개 구 공식 최종 개표 정리")
    print(DISTRICT_CSV)
    print(DISTRICT_JSON)

if __name__ == "__main__":
    main()
