"""Source consistency check for candidate pledges, separate from vote checks."""
from app.models import FactCheckResult, Article


def _issue(field, message, suggestion=None):
    return {"field": field, "message": message, "original": None, "suggestion": suggestion,
            "target": "body", "action": "insert" if suggestion else None}


def check_pledge_article(article: Article, rag) -> FactCheckResult:
    source = {doc['evidence_id']: doc for doc in rag.documents
              if doc.get('pledge_candidate_id')}
    checks = []
    if not article.evidence:
        return FactCheckResult(status='fail', reason='연결된 공약 근거가 없습니다.', checks=[], issues=[
            _issue('공약 근거', '기사에 연결된 공약 근거가 없습니다. 공약 기사를 새로 생성해 주세요.')])
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
    issues = []
    candidate_name = article.evidence[0].candidate_name
    for row in failed:
        field = row['field']
        ev_id = field.split(':', 1)[-1]
        ev = next((e for e in article.evidence if e.evidence_id == ev_id), None)
        original = source.get(ev_id)
        if field.startswith('공약 제목:') and original:
            title = original['title'].split(' 후보 공약: ', 1)[-1]
            issues.append(_issue(field, f'원문에 선관위 등록 공약 제목 「{title}」이 없습니다.',
                                 f'{candidate_name} 후보 공약: {title}'))
        elif field.startswith('근거 ID:') and ev:
            issues.append(_issue(field, f'원문에 근거 ID({ev_id})가 없습니다.', f'근거 ID: {ev_id}'))
        elif field == '출처 명시':
            for item in article.evidence:
                if item.source not in article.body:
                    issues.append(_issue(field, f'원문에 출처({item.source})가 없습니다.', f'출처: {item.source}'))
        elif field == '후보자의 제안임을 명시':
            issues.append(_issue(field, "원문에 '후보'의 '공약'이라는 표현이 없습니다.",
                                 f'{candidate_name} 후보가 제시한 공약이다.'))
        elif field.startswith('근거 원본 일치:'):
            issues.append(_issue(field, '연결된 근거가 선관위 원본과 다릅니다. 기사를 새로 생성해 주세요.'))
        elif field == '후보자 단일성':
            issues.append(_issue(field, '한 기사에 여러 후보의 공약이 섞여 있습니다. 후보별로 기사를 나눠 주세요.'))
    return FactCheckResult(
        status='fail' if failed else 'pass',
        reason='근거 원본·후보·공약 제목·출처가 일치합니다. 내용의 맥락과 추가 주장은 사람 검토가 필요합니다.'
               if not failed else '공약 근거 또는 원고에 불일치가 있습니다.',
        checks=checks,
        llm_review={'mode': 'disabled', 'issues': [],
                    'note': '공약 기사 자동 검사는 원본 일치만 확인합니다. 미검증 추가 주장과 해석은 사람 검토가 필요합니다.'},
        issues=issues,
    )
