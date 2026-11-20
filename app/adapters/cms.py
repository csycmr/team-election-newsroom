import httpx

from app.config import Settings
from app.models import Article


async def publish(article: Article, settings: Settings) -> dict:
    if article.status != "approved":
        raise ValueError("사람이 최종 승인한 기사만 CMS로 전송할 수 있습니다.")
    if not settings.cms_enabled or not settings.cms_api_url:
        return {"published": False, "mode": "local", "message": "CMS가 비활성화되어 로컬 승인만 완료했습니다."}
    headers = {"Authorization": f"Bearer {settings.cms_api_token}"}
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(settings.cms_api_url, json={"title": article.title, "body": article.body}, headers=headers)
        response.raise_for_status()
        return {"published": True, "mode": "cms", "response": response.json()}

