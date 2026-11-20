import json
import re
from pathlib import Path

from app.models import Evidence


class LocalRAG:
    def __init__(self, path: Path):
        self.documents = json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def tokens(text: str) -> set[str]:
        return set(re.findall(r"[가-힣A-Za-z0-9]{2,}", text.lower()))

    def search(self, query: str, limit: int = 5) -> list[Evidence]:
        query_tokens = self.tokens(query)
        scored = []
        for document in self.documents:
            haystack = f"{document['title']} {document['content']} {document.get('candidate_name', '')}"
            score = len(query_tokens & self.tokens(haystack)) / max(len(query_tokens), 1)
            scored.append((score, document))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [Evidence(**doc, score=round(score, 3)) for score, doc in scored[:limit] if score > 0]

