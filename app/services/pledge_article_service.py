"""Candidate proposal article drafts. No live election snapshot is fabricated."""
import re
from uuid import uuid4

from app.models import Article, Evidence
from app.services.time_service import now_seoul


def goal_excerpt(content: str) -> str:
    # Raw NEC text usually begins with '□ 목 표', then '○ ...'.
    for line in content.splitlines():
        text = line.strip()
        if text.startswith('○'):
            return text.lstrip('○ ').strip()[:180]
    return re.sub(r"\s+", " ", content.removeprefix('공약 내용:').strip())[:180]


def generate_pledge_article(docs: list[dict]) -> Article:
    if not docs:
        raise ValueError('공약 근거가 없습니다.')
    first = docs[0]
    candidate = first['candidate_name']
    province = first.get('province', '')
    district = first.get('district', '')
    area = province if not district or district == province else f'{province} {district}'
    evidence = [Evidence.model_validate(doc) for doc in docs]
    body = (
        f'[후보자 공약 소개 · 당선 이후 시행 여부와 별개] {area} {candidate} 후보가 '
        f'중앙선거관리위원회에 제출한 공약 {len(evidence)}건은 다음과 같다.\n\n'
    )
    for idx, (doc, ev) in enumerate(zip(docs, evidence, strict=True), 1):
        heading = doc['title'].split(' 후보 공약: ', 1)[-1]
        content = doc['content'].split('공약 내용: ', 1)[-1]
        excerpt = goal_excerpt(content)
        body += f'{idx}. {heading}\n'
        if excerpt:
            body += f'   공약 원문 발췌: {excerpt}\n'
        body += f'   근거 ID: [{ev.evidence_id}]\n\n'
    body += f'출처: {first["source"]} ({first["source_url"]})\n'
    body += '※ 후보자가 제시한 계획이며 실제 이행 여부를 검증한 기사가 아니다.'
    now = now_seoul()
    return Article(
        article_id=uuid4().hex,
        article_type='pledge',
        title=f'{area} {candidate} 후보, 선관위 등록 공약 {len(evidence)}건 제시',
        body=body,
        snapshot=None,
        evidence=evidence,
        status='draft',
        created_at=now,
        updated_at=now,
    )


def select_pledge_documents(query: str, rag) -> list[dict]:
    # Require an explicit candidate in the question; do not silently produce
    # an article about some other high-scoring name.
    candidate_names = [name for name in rag.candidate_names if name in query]
    if not candidate_names:
        raise LookupError('질문에 후보자 이름을 포함해 주세요. 예: 서울시장 정원오 공약')
    matches = rag.search(query if '공약' in query else query + ' 공약', limit=10)
    ids = {ev.evidence_id for ev in matches if ev.evidence_id.startswith('NEC-PRMS-')}
    matched = [doc for doc in rag.documents if doc.get('evidence_id') in ids
               and doc.get('pledge_candidate_id')]
    candidate_ids = {doc['pledge_candidate_id'] for doc in matched}
    if not candidate_ids:
        raise LookupError('후보자의 공약을 찾지 못했습니다.')
    if len(candidate_ids) != 1:
        raise ValueError('동명이인 또는 여러 후보의 공약이 검색됐습니다. 지역과 선거 종류를 추가해 주세요.')
    candidate_id = next(iter(candidate_ids))
    # Retrieve ALL documented promises for the identified candidate, not
    # simply the best 5 ranked search hits.
    docs = [doc for doc in rag.documents if doc.get('pledge_candidate_id') == candidate_id
            and doc.get('content', '').split('공약 내용: ', 1)[-1].strip()]
    if not docs:
        raise LookupError('공약 제목은 있으나 본문이 복구되지 않았습니다.')
    return docs
