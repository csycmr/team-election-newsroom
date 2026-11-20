from abc import ABC, abstractmethod
from typing import AsyncIterator

from app.models import ElectionSnapshot


class ElectionStream(ABC):
    """WebSocket과 Kafka가 공유하는 메시지 스트림 경계."""

    @abstractmethod
    async def subscribe(self) -> AsyncIterator[ElectionSnapshot]:
        if False:
            yield  # pragma: no cover


class KafkaStreamAdapter(ElectionStream):
    """확장 인터페이스. 실제 연결 시 aiokafka 의존성과 consumer를 주입한다."""

    async def subscribe(self) -> AsyncIterator[ElectionSnapshot]:
        raise NotImplementedError("Kafka는 확장 기능입니다. docs/KAFKA_EXTENSION.md를 참고하세요.")

