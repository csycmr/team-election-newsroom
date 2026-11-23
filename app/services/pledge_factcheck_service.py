"""Source consistency check for candidate pledges, separate from vote checks."""
from app.models import FactCheckResult, Article


def check_pledge_article(article: Article, rag) -> FactCheckResult:
    source = {doc['evidence_id']: doc for doc in rag.documents
              if doc.get('pledge_candidate_id')}
    checks = []
    if not article.evidence:
        return FactCheckResult(status='fail', reason='연결된 공약 근거가 없습니다.', checks=[])
    candidate_ids = set()
    for ev in article.evidence:
        original = source.get(ev.evidence_id)
        matching = bool(original) and all(
            getattr(ev, field) == original[field]
            for field in ('evidence_id', 'title', 'content', 'candidate_name', 'source', 'source_url')
        )
        checks.append({'field': f'근거 원본 일치:{ev.evidence_id}', 'passed': matching})
        if original:
            candidate_ids.add(original['pledge_candidate_id'])
            pledge_title = original['title'].split(' 후보 공약: ', 1)[-1]
            checks.append({'field': f'공약 제목:{ev.evidence_id}',
                           'passed': pledge_title in article.body})
            checks.append({'field': f'근거 ID:{ev.evidence_id}',
                           'passed': ev.evidence_id in article.body})
    checks.append({'field': '후보자 단일성', 'passed': len(candidate_ids) == 1})
    checks.append({'field': '출처 명시', 'passed': all(ev.source in article.body for ev in article.evidence)})
    checks.append({'field': '후보자의 제안임을 명시',
                   'passed': '후보' in article.body and '공약' in article.body})
    failed = [row for row in checks if not row['passed']]
    return FactCheckResult(
        status='fail' if failed else 'pass',
        reason='근거 원본·후보·공약 제목·출처가 일치합니다. 내용의 맥락과 추가 주장은 사람 검토가 필요합니다.'
               if not failed else '공약 근거 또는 원고에 불일치가 있습니다.',
        checks=checks,
        llm_review={'mode': 'disabled', 'issues': [],
                    'note': '공약 기사 자동 검사는 원본 일치만 확인합니다. 미검증 추가 주장과 해석은 사람 검토가 필요합니다.'},
    )
