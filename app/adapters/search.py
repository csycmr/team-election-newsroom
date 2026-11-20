import httpx

from app.config import Settings


async def index_document(document_id: str, payload: dict, settings: Settings) -> bool:
    if not settings.elasticsearch_enabled or not settings.elasticsearch_url:
        return False
    headers = {"Content-Type": "application/json"}
    auth = None
    if settings.elasticsearch_api_key:
        headers["Authorization"] = f"ApiKey {settings.elasticsearch_api_key}"
    elif settings.elasticsearch_username:
        auth = (settings.elasticsearch_username, settings.elasticsearch_password)
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.put(f"{settings.elasticsearch_url.rstrip('/')}/election-documents/_doc/{document_id}",
                                    json=payload, headers=headers, auth=auth)
        response.raise_for_status()
    return True

