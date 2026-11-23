import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.adapters.cms import publish
from app.config import ROOT, get_settings
from app.models import ArticleCreate, ArticleUpdate, ReviewRequest
from app.services.article_service import generate_article
from app.services.election_service import fetch_snapshot
from app.services.factcheck_service import check_article
from app.services.rag_service import LocalRAG
from app.services.replay_service import FRAMES, REPLAY_DIR, replay_snapshot
from app.services.storage_service import Storage
from app.services.time_service import now_seoul

settings = get_settings()
storage = Storage(settings.db_path)
rag = LocalRAG(ROOT / "data/sample/rag_documents.json")

replay_rag = LocalRAG(REPLAY_DIR / "rag_documents.json")

app = FastAPI(title="RAG Election Newsroom", version="1.0.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(ROOT / "static/index.html")


@app.get("/health")
def health():
    return {
        "status": "ok", "mode": settings.app_mode, "time": now_seoul(),
        "integrations": {
            "election_api": bool(settings.election_data_api_key),
            "openai": bool(settings.openai_api_key),
            "google_fact_check": settings.google_fact_check_enabled and bool(settings.google_fact_check_api_key),
            "elasticsearch": settings.elasticsearch_enabled and bool(settings.elasticsearch_url),
            "cms": settings.cms_enabled and bool(settings.cms_api_url),
            "kafka": "extension-only",
        },
    }


@app.get("/api/election/snapshot")
async def snapshot(region: str = "중구", step: int = Query(1, ge=1, le=12)):
    return await fetch_snapshot(settings, region, step)


@app.get("/api/replay")
def replay_data():
    return FRAMES


@app.websocket("/ws/replay")
async def replay_websocket(websocket: WebSocket):
    await websocket.accept()
    try:
        for frame in FRAMES:
            await websocket.send_json(frame.model_dump(mode="json"))
            if frame.step_id < len(FRAMES):
                await asyncio.sleep(5)
        await websocket.close()
    except WebSocketDisconnect:
        return


@app.websocket("/ws/election")
async def election_websocket(websocket: WebSocket):
    await websocket.accept()
    region = websocket.query_params.get("region", "중구")
    step = 1
    try:
        while True:
            data = await fetch_snapshot(settings, region, step)
            await websocket.send_json(data.model_dump(mode="json"))
            step = 1 if step >= 12 else step + 1
            await asyncio.sleep(max(settings.websocket_refresh_seconds, 0.2))
    except WebSocketDisconnect:
        return


@app.get("/api/rag/search")
def rag_search(q: str = Query(min_length=2), limit: int = Query(5, ge=1, le=10), replay: bool = False):
    return {"query": q, "results": (replay_rag if replay else rag).search(q, limit), "engine": "local-keyword"}


@app.post("/api/articles")
def create_article(request: ArticleCreate):
    if request.snapshot.mode == "replay":
        step = request.snapshot.step_id
        if not 1 <= step <= len(FRAMES) or request.snapshot != replay_snapshot(step):
            raise HTTPException(409, "재생 원본과 일치하는 집계만 기사화할 수 있습니다.")
        request.evidence = [
            item for item in replay_rag.search("서울시장", 10)
            if item.evidence_id == request.snapshot.evidence_id
        ]
    article = generate_article(request)
    storage.save_article(article)
    storage.log(article.article_id, "draft_created", "AI", {"evidence_ids": [item.evidence_id for item in article.evidence]})
    return article


def required_article(article_id: str):
    article = storage.get_article(article_id)
    if not article:
        raise HTTPException(404, "기사를 찾을 수 없습니다.")
    return article


@app.get("/api/articles/{article_id}")
def get_article(article_id: str):
    return required_article(article_id)


@app.put("/api/articles/{article_id}")
def update_article(article_id: str, request: ArticleUpdate):
    article = required_article(article_id)
    if article.status not in {"draft", "fact_checked"}:
        raise HTTPException(409, "초안 또는 팩트체크 통과 상태에서만 기사를 수정할 수 있습니다.")

    title = request.title.strip()
    body = request.body.strip()
    if not title or not body or "\n" in title or "\r" in title:
        raise HTTPException(422, "제목은 한 줄, 본문은 비어 있지 않아야 합니다.")

    # 수정 전 팩트체크 결과로 사람 검토·승인하지 못하게 한다.
    previous_status = article.status
    article.title = title
    article.body = body
    article.status = "draft"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "article_updated", "system", {
        "previous_status": previous_status,
        "new_status": "draft",
    })
    return article


@app.post("/api/articles/{article_id}/fact-check")
async def fact_check(article_id: str):
    article = required_article(article_id)
    result = await check_article(article, settings)
    article.status = "fact_checked" if result.status == "pass" else "draft"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "fact_checked", "rules+external", result.model_dump())
    return {"article": article, "result": result}


@app.post("/api/articles/{article_id}/human-review")
def human_review(article_id: str, request: ReviewRequest):
    article = required_article(article_id)
    if article.status != "fact_checked":
        raise HTTPException(409, "팩트체크 통과 후 사람 검토를 진행할 수 있습니다.")
    article.status = "human_reviewed"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "human_reviewed", request.reviewer, request.note)
    return article


@app.post("/api/articles/{article_id}/approve")
def approve(article_id: str, request: ReviewRequest):
    article = required_article(article_id)
    if article.status != "human_reviewed":
        raise HTTPException(409, "사람 검토 완료 전에는 최종 승인할 수 없습니다.")
    article.status = "approved"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "approved", request.reviewer, request.note)
    return article


@app.get("/api/articles/{article_id}/audit")
def audit(article_id: str):
    required_article(article_id)
    return storage.logs(article_id)


@app.post("/api/articles/{article_id}/publish")
async def publish_article(article_id: str):
    article = required_article(article_id)
    if article.snapshot.mode == "replay":
        raise HTTPException(409, "과거 선거 재생 시연 기사는 외부 전송할 수 없습니다.")
    try:
        result = await publish(article, settings)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    storage.log(article_id, "publish_requested", "system", result)
    return result

