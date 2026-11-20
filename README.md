# 서울선거라이브 | 프로젝트 1 초안

2026년 6월 3일 제9회 전국동시지방선거 중 서울시장 선거를 대상으로 한 개표 재생 시연이다. 프로젝트 2 서울교통라이브의 남색 뉴스룸, 상단 속보 띠, 2×2 전광판, 막대그래프 구성을 적용했다.

## Windows 11에서 실행

압축을 풀고 VS Code로 이 폴더를 연다. PowerShell 터미널에서 순서대로 실행한다.

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py
```

브라우저에서 http://127.0.0.1:8000 을 열고 **개표 재생**을 누른다. 첫 집계는 즉시 도착하고, 5초마다 다음 집계가 들어와 약 55초 뒤 100%에서 끝난다. 일시정지는 화면만 고정하며 다시 누르면 최신 집계로 이동한다. 파이썬 패키지 설치에는 인터넷 연결이 필요하다.

## 데이터와 출처

| 파일 | 내용 |
|---|---|
| `data/replay/reported_results.csv` | 연합뉴스가 보도한 99.54%, 100% 시점의 후보 5명 집계 10행. 시각은 기사 송고 시각(KST) |
| `data/replay/snapshots.json` | WebSocket 입력용 12단계 프레임. 1~10은 재구성, 11~12는 보도 수치 |
| `data/replay/rag_documents.json` | 보도 집계와 시연 데이터 설명을 찾는 검색 색인 |

- [중앙선거관리위원회 시·도지사선거 개표결과 CSV 안내](https://www.data.go.kr/data/15162288/fileData.do). 포털 원본 CSV 직접 다운로드는 접속 오류로 완료하지 못했다. 데이터는 당시 보도 표에서 확보했다.
- [연합뉴스 99.54% 보도 집계](https://www.yna.co.kr/amp/view/AKR20260604181600004) · [연합뉴스 100% 보도 집계](https://www.yna.co.kr/amp/view/AKR20260605106300004) · [선관위 자료를 사용한 오마이뉴스 개표 현황](https://www.ohmynews.com/NWS_Web/Event/Elect/2026/counting.aspx).
- 가상 시각·개표 진행률·중간 득표수는 시연용이다. 재구성 프레임의 득표율은 해당 프레임의 후보 득표 합계 기준으로 소수점 두 자리까지 절사했다. 보도 프레임의 득표율은 당시 보도값을 저장했다. 개표 진행률과 후보 득표율은 계산 기준이 서로 다르다.
- 1차 시연은 서울시장 후보 5명의 서울 전체 집계로 제한했다. 자치구별·전국 단위 집계, 후보 공약 원문은 추가 수집 항목이다.

## 편집 데스크 시연

1. 개표 재생 첫 집계가 오면 템플릿 기사 초안이 자동으로 작성된다. 이후 집계는 **현재 집계로 초안**을 눌러 기사화한다.
2. 단계마다 연결된 근거 ID와 출처를 초안에서 확인한다. **근거 검색**에서는 당시 집계와 시연 기준을 검색할 수 있다.
3. **팩트체크 → 사람 검토 → 편집장 승인** 순서로 진행한다. 검토자 이름은 화면에 입력한다. 변조된 재생 프레임은 서버에서 차단하며 승인 전후의 작업은 SQLite에 기록한다.
4. 시연 기사에는 외부 송고 차단이 적용된다. 초안은 템플릿 방식이고, 검색은 로컬 키워드 기반이다. 생성형 AI 기사 작성, 공약 문서 RAG, 20분 리포트는 제출본에서 확장할 항목이다.

## 데이터 구조

`ElectionSnapshot` 1 → N `CandidateResult`. 각 스냅샷은 `step_id`, `counted_rate`, `collected_at`, `source_url`, `mode=replay`, `record_type`, `evidence_id`를 가진다. 기사는 생성 당시 스냅샷과 근거를 저장하고, 기사 1건에 여러 감사 로그가 연결된다.

- `GET /api/replay` 전체 재생 데이터
- `WS /ws/replay` 5초 간격 전송
- `GET /api/rag/search?replay=true&q=서울시장` 근거 검색
- `/docs` API 명세

기반 소스는 [수업 참고 저장소](https://github.com/journal-izm/project1-rag-election-newsroom)의 `dbb8614`이며 참고용 일반 모의 API도 포함돼 있다. 시연 화면은 과거 개표 재생 API를 사용한다.

## 테스트

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```
