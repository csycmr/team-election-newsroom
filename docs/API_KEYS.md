# 외부 연동 설정

실제 키는 `.env`에만 넣고 Git에 올리지 않는다. `.env.example`은 항목과 기본 URL만 제공한다.

## 선거 데이터

공공데이터포털의 중앙선거관리위원회 투·개표 정보 활용신청 후 일반 인증키를 `ELECTION_DATA_API_KEY`에 넣는다. 공식 서비스는 선거 당일 실시간 스트림을 보장하지 않으므로 교육용 실시간 시연은 `ELECTION_STREAM_MODE=mock`을 사용한다. 승인 후 받은 최신 활용가이드에서 선거별 조회 operation과 필수 파라미터를 확인해야 한다.

## Google Fact Check Tools

Google Cloud 프로젝트에서 Fact Check Tools API를 활성화하고 API 키를 생성한다. 검색 결과는 기존 팩트체크 보도이며 새로운 주장의 자동 판정 결과가 아니다.

## Elasticsearch

Elastic Cloud 배포의 Elasticsearch endpoint를 URL로 사용한다. 운영 환경은 사용자·비밀번호보다 Elasticsearch API Key를 권장한다. 설정하지 않으면 로컬 RAG 검색이 사용된다.

## CMS

CMS 담당자가 기사 등록 endpoint, 인증 토큰, 임시저장·발행 규격을 제공해야 한다. 설정하지 않으면 로컬 승인과 감사 로그까지만 수행한다. CMS 전송은 승인 상태 기사만 허용된다.

