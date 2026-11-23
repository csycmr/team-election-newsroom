import asyncio

from app.config import Settings
from app.models import ArticleCreate
from app.services.article_service import generate_article
from app.services.demo_service import demo_snapshot
from app.services.factcheck_service import check_article


def article():
    return generate_article(ArticleCreate(snapshot=demo_snapshot(2)))


def run_check(item):
    return asyncio.run(check_article(item, Settings(openai_api_key="")))


def test_original_template_still_passes():
    assert run_check(article()).status == "pass"


def test_swapped_candidate_totals_fail():
    item = article()
    a, b = item.snapshot.candidates[:2]
    va, vb = f"{a.votes:,}", f"{b.votes:,}"
    item.body = item.body.replace(va, "SWAP_A", 1).replace(vb, va, 1).replace("SWAP_A", vb, 1)
    result = run_check(item)
    assert result.status == "fail"
    assert any(c["field"] == f"득표수:{a.candidate_name}" and not c["passed"] for c in result.checks)


def test_conflicting_ai_lead_fails_even_with_correct_template():
    item = article()
    a, b = item.snapshot.candidates[:2]
    item.body = f"{a.candidate_name} 후보는 {b.votes:,}표를 얻었다.\n\n" + item.body
    assert run_check(item).status == "fail"


def test_wrong_time_in_lead_fails():
    item = article()
    item.body = "2026-12-01T18:00:00+09:00 기준 속보.\n\n" + item.body
    result = run_check(item)
    assert result.status == "fail"
    assert any(c["field"] == "기준시각" and not c["passed"] for c in result.checks)


def test_missing_time_fails():
    item = article()
    item.body = item.body.replace(item.snapshot.collected_at.isoformat(), "기준시각 미상")
    assert run_check(item).status == "fail"
