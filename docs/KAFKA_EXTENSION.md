# Kafka 확장 인터페이스

기본 구현은 브라우저와 서버 사이의 FastAPI WebSocket 스트림이다. Kafka는 여러 수집기·처리기·뉴스룸 서버를 분리해야 할 때 추가한다.

## 연결 지점

- 추상 경계: `app/adapters/stream.py`의 `ElectionStream`
- 토픽 기본값: `election-results`
- 메시지 계약: `ElectionSnapshot.model_dump_json()`
- 필수 키: `election_id`, `region`, `step_id`, `collected_at`, `source`, `mode`, `candidates`

## 구현 절차

1. `aiokafka`를 별도 고도화 requirements에 추가한다.
2. `KafkaStreamAdapter.subscribe()`에 `AIOKafkaConsumer`를 주입한다.
3. 메시지를 `ElectionSnapshot.model_validate_json()`으로 검증한다.
4. offset은 화면 전송이 아니라 저장·검증 완료 후 commit한다.
5. 동일한 `election_id + region + step_id + collected_at`을 멱등키로 사용한다.
6. 실패 메시지는 DLQ 토픽으로 보내고 원문·오류·재시도 횟수를 기록한다.

Kafka가 없어도 필수 수집·RAG·팩트체크·승인 흐름과 자동 테스트는 모두 동작한다.

