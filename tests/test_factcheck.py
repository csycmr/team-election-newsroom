import asyncio

from app.config import Settings
from app.models import ArticleCreate
from app.services.article_service import generate_article
from app.services.demo_service import demo_snapshot
from app.services.factcheck_service import check_article


def test_generated_article_passes_rule_check():
    article = generate_article(ArticleCreate(snapshot=demo_snapshot(2)))
    result = asyncio.run(check_article(article, Settings()))
    assert result.status == "pass"


def test_modified_vote_fails_rule_check():
    article = generate_article(ArticleCreate(snapshot=demo_snapshot(2)))
    article.body = article.body.replace(f"{article.snapshot.candidates[0].votes:,}", "999")
    result = asyncio.run(check_article(article, Settings()))
    assert result.status == "fail"

