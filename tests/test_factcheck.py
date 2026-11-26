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



def test_election_prose_passes_without_internal_metadata():
    from app.services.replay_service import TIMELINE_SNAPSHOTS

    snapshot = TIMELINE_SNAPSHOTS[-1]
    article = generate_article(ArticleCreate(snapshot=snapshot))
    assert "서울시장 개표 완료" in article.title
    assert "15단계" not in article.body
    assert snapshot.collected_at.isoformat() not in article.body
    assert "출처:" not in article.body
    assert "초안은 팩트체크" not in article.body
    assert asyncio.run(check_article(article, Settings())).status == "pass"


def test_mentioned_candidate_number_must_match_original():
    from app.services.replay_service import TIMELINE_SNAPSHOTS

    article = generate_article(ArticleCreate(snapshot=TIMELINE_SNAPSHOTS[-1]))
    assert asyncio.run(check_article(article, Settings())).status == "pass"
    article.body = article.body.replace("2,575,819표", "2,575,818표")
    result = asyncio.run(check_article(article, Settings()))
    assert result.status == "fail"
    assert any("오세훈" in item["field"] for item in result.checks if not item["passed"])


def test_not_every_candidate_needs_to_appear():
    from app.services.replay_service import TIMELINE_SNAPSHOTS

    article = generate_article(ArticleCreate(snapshot=TIMELINE_SNAPSHOTS[-1]))
    article.body = article.body.split("\n\n이 밖에")[0]
    assert asyncio.run(check_article(article, Settings())).status == "pass"
