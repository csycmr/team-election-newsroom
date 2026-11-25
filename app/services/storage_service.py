import json
import sqlite3
from pathlib import Path

from app.models import Article
from app.services.time_service import now_seoul


class Storage:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init(self):
        with self.connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS articles (
              article_id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT, article_id TEXT NOT NULL,
              action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """)

    def save_article(self, article: Article):
        payload = article.model_dump_json()
        with self.connect() as db:
            db.execute("""INSERT INTO articles VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(article_id) DO UPDATE SET payload=excluded.payload,
                status=excluded.status, updated_at=excluded.updated_at""",
                (article.article_id, payload, article.status, article.created_at.isoformat(), article.updated_at.isoformat()))

    def get_article(self, article_id: str) -> Article | None:
        with self.connect() as db:
            row = db.execute("SELECT payload FROM articles WHERE article_id=?", (article_id,)).fetchone()
        return Article.model_validate_json(row["payload"]) if row else None

    def list_articles(self, status: str | None = None, limit: int = 100) -> list[Article]:
        """Return newest articles, optionally restricted to a workflow status."""
        query = "SELECT payload FROM articles"
        params: list[str | int] = []
        if status is not None:
            query += " WHERE status = ?"
            params.append(status)
        query += " ORDER BY updated_at DESC, article_id DESC LIMIT ?"
        params.append(limit)
        with self.connect() as db:
            rows = db.execute(query, params).fetchall()
        return [Article.model_validate_json(row["payload"]) for row in rows]

    def published_article_ids(self, article_ids: list[str]) -> set[str]:
        if not article_ids:
            return set()
        placeholders = ", ".join("?" for _ in article_ids)
        with self.connect() as db:
            rows = db.execute(
                f"""SELECT DISTINCT article_id FROM audit_logs
                WHERE article_id IN ({placeholders}) AND action = 'publish_requested'
                AND CASE WHEN json_valid(detail) THEN json_type(detail, '$.published') END = 'true'""",
                article_ids,
            ).fetchall()
        return {row["article_id"] for row in rows}

    def log(self, article_id: str, action: str, actor: str, detail: dict | str):
        detail_text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)
        with self.connect() as db:
            db.execute("INSERT INTO audit_logs(article_id, action, actor, detail, created_at) VALUES(?,?,?,?,?)",
                       (article_id, action, actor, detail_text, now_seoul().isoformat()))

    def logs(self, article_id: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM audit_logs WHERE article_id=? ORDER BY id DESC", (article_id,)).fetchall()
        return [dict(row) for row in rows]

