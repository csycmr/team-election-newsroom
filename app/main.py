import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from app.adapters.cms import publish
from app.config import ROOT, get_settings
from app.models import Article, ArticleCreate, ArticleUpdate, ReviewRequest, PledgeArticleCreate
from app.services.article_service import generate_article, generate_ai_article
from app.services.election_service import fetch_snapshot
from app.services.factcheck_service import check_article
from app.services.pledge_article_service import generate_pledge_article, select_pledge_documents
from app.services.pledge_factcheck_service import check_pledge_article
from app.services.rag_service import LocalRAG, answer_question
from app.services.replay_service import (
    COUNT_TIMELINE, FRAMES, REPLAY_DIR, TIMELINE_SNAPSHOTS, replay_snapshot, timeline_evidence,
)
from app.services.storage_service import Storage
from app.services.time_service import now_seoul

settings = get_settings()
storage = Storage(settings.db_path)
rag = LocalRAG(
    ROOT / "data/sample/rag_documents.json",
    pledge_path=ROOT / "data/processed/pledges/pledges_20260603_all_3-4-11.json",
    candidate_csv=ROOT / "data/processed/candidates_20260603_all_3-4-11.csv",
)

replay_rag = LocalRAG(REPLAY_DIR / "rag_documents.json")

app = FastAPI(title="RAG Election Newsroom", version="1.0.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

@app.middleware("http")
async def guard_article_writes(request, call_next):
    """Require a team token for article mutations on the public deployment."""
    if request.url.path.startswith("/api/articles") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        token = settings.newsroom_write_token
        if settings.app_mode == "production" and not token:
            return JSONResponse(status_code=503, content={"detail": "NEWSROOM_WRITE_TOKEN is missing"})
        if token and not secrets.compare_digest(request.headers.get("X-Newsroom-Token", ""), token):
            return JSONResponse(status_code=401, content={"detail": "TEAM_AUTH_REQUIRED"})
    return await call_next(request)



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



@app.get("/api/count-timeline")
def count_timeline_data():
    return COUNT_TIMELINE


@app.websocket("/ws/count-timeline")
async def count_timeline_websocket(
    websocket: WebSocket,
    start_step: int = Query(1, ge=1, le=len(COUNT_TIMELINE)),
    delay_ms: int = Query(0, ge=0, le=5000),
):
    await websocket.accept()
    try:
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000)
        for index, frame in enumerate(COUNT_TIMELINE[start_step - 1:]):
            if index:
                await asyncio.sleep(5)
            await websocket.send_json(frame)
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


@app.get("/api/rag/answer")
async def rag_answer(q: str = Query(min_length=2), replay: bool = False):
    return await answer_question(
        q, replay_rag if replay else rag,
        api_key=settings.openai_api_key,
        model=settings.openai_chat_model,
    )


@app.post("/api/articles/from-pledges")
def create_pledge_article(request: PledgeArticleCreate):
    try:
        docs = select_pledge_documents(request.query, rag)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    article = generate_pledge_article(docs)
    storage.save_article(article)
    storage.log(article.article_id, 'draft_created', 'pledge-template', {
        'article_type': 'pledge',
        'evidence_ids': [item.evidence_id for item in article.evidence],
    })
    return article


@app.post("/api/articles")
async def create_article(request: ArticleCreate):
    if request.snapshot.mode == "replay":
        step = request.snapshot.step_id
        if 1 <= step <= len(TIMELINE_SNAPSHOTS) and request.snapshot == TIMELINE_SNAPSHOTS[step - 1]:
            request.evidence = [timeline_evidence(request.snapshot)]
        elif 1 <= step <= len(FRAMES) and request.snapshot == replay_snapshot(step):
            request.evidence = [
                item for item in replay_rag.search("서울시장", 10)
                if item.evidence_id == request.snapshot.evidence_id
            ]
        else:
            raise HTTPException(409, "재생 원본과 일치하는 집계만 기사화할 수 있습니다.")
    elif request.snapshot.counted_rate is None or not request.snapshot.candidates:
        raise HTTPException(422, "개표율과 후보별 득표가 필요합니다.")
    if request.generation_mode == "ai":
        if not settings.openai_api_key:
            raise HTTPException(503, "AI 초안 생성에는 OPENAI_API_KEY가 필요합니다. generation_mode=template을 사용하세요.")
        try:
            article = await generate_ai_article(request, settings.openai_api_key, settings.openai_chat_model)
        except ValueError as exc:
            raise HTTPException(502, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, "AI 초안 생성 요청이 실패했습니다.") from exc
    else:
        article = generate_article(request)
    storage.save_article(article)
    storage.log(article.article_id, "draft_created", "AI" if request.generation_mode == "ai" else "template", {
        "generation_mode": request.generation_mode,
        "evidence_ids": [item.evidence_id for item in article.evidence],
    })
    return article


def required_article(article_id: str):
    article = storage.get_article(article_id)
    if not article:
        raise HTTPException(404, "기사를 찾을 수 없습니다.")
    return article


def article_dateline(article: Article) -> str:
    """Date shown in 보도실: the count moment for count articles, a fixed 6/2 time for pledges.

    The newsroom replays a past election, so posted articles carry the time they would
    have run, not the real click time. Pledge times are derived from the article id so
    each article keeps the same time on every load.
    """
    if article.article_type != "pledge" and article.snapshot is not None:
        return article.snapshot.collected_at.isoformat()
    seed = int(hashlib.sha256(article.article_id.encode()).hexdigest(), 16)
    hour = 9 + seed % 10
    minute = (seed // 10) % 60
    return datetime(2026, 6, 2, hour, minute, tzinfo=timezone(timedelta(hours=9))).isoformat()


@app.get("/api/articles")
def list_articles(
    status: str | None = Query(default=None, pattern="^(draft|fact_checked|human_reviewed|approved|rejected)$"),
    limit: int = Query(default=100, ge=1, le=100),
):
    articles = storage.list_articles(status=status, limit=limit)
    approved_ids = [article.article_id for article in articles if article.status == "approved"]
    published_ids = storage.published_article_ids(approved_ids)
    posted = storage.posted_details(approved_ids)
    return {
        "articles": [
            {
                **article.model_dump(mode="json"),
                "published": article.article_id in published_ids,
                "posted": article.article_id in posted,
                "posted_at": posted.get(article.article_id, {}).get("posted_at"),
                "author": posted.get(article.article_id, {}).get("author"),
                "dated_at": article_dateline(article),
            }
            for article in articles
        ],
        "count": len(articles),
    }


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
    result = (check_pledge_article(article, rag) if article.article_type == "pledge"
              else await check_article(article, settings))
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


@app.post("/api/articles/{article_id}/reject")
def reject(article_id: str, request: ReviewRequest):
    article = required_article(article_id)
    if article.status != "human_reviewed":
        raise HTTPException(409, "사람 검토를 마친 기사만 반려할 수 있습니다.")
    article.status = "rejected"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "rejected", request.reviewer, request.note)
    return article


@app.post("/api/articles/{article_id}/post")
def post_to_newsroom(article_id: str):
    article = required_article(article_id)
    if article.status != "approved":
        raise HTTPException(409, "편집장 승인을 마친 기사만 보도실에 게시할 수 있습니다.")
    if article_id not in storage.posted_article_ids([article_id]):
        storage.log(article_id, "posted", "editor", "보도실 게시")
    return {**article.model_dump(mode="json"), "posted": True}


@app.post("/api/articles/{article_id}/revise")
def revise_posted_article(article_id: str):
    """Take an approved article back to draft so it can be edited and re-approved."""
    article = required_article(article_id)
    if article.status != "approved":
        raise HTTPException(409, "편집장 승인을 마친 기사만 수정으로 되돌릴 수 있습니다.")
    if article_id in storage.posted_article_ids([article_id]):
        storage.log(article_id, "unposted", "editor", "수정을 위해 보도실 게시 취소")
    article.status = "draft"
    article.updated_at = now_seoul()
    storage.save_article(article)
    storage.log(article_id, "revision_requested", "editor", "보도실에서 수정 요청")
    return article


@app.delete("/api/articles/{article_id}")
def delete_article(article_id: str):
    required_article(article_id)
    storage.log(article_id, "deleted", "editor", "기사 삭제")
    storage.delete_article(article_id)
    return {"deleted": True, "article_id": article_id}


@app.get("/api/articles/{article_id}/audit")
def audit(article_id: str):
    required_article(article_id)
    return storage.logs(article_id)


@app.post("/api/articles/{article_id}/publish")
async def publish_article(article_id: str):
    article = required_article(article_id)
    if article.snapshot is not None and article.snapshot.mode == "replay":
        raise HTTPException(409, "과거 선거 재생 시연 기사는 외부 전송할 수 없습니다.")
    try:
        result = await publish(article, settings)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    storage.log(article_id, "publish_requested", "system", result)
    return result

