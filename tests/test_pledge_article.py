from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_pledge_article_end_to_end():
    response = client.post('/api/articles/from-pledges', json={'query': '서울시장 정원오 공약'})
    assert response.status_code == 200, response.text
    article = response.json()
    assert article['article_type'] == 'pledge'
    assert article['snapshot'] is None
    assert article['status'] == 'draft'
    assert len(article['evidence']) == 5
    assert all(e['evidence_id'].startswith('NEC-PRMS-20260603-3-100157144-')
               for e in article['evidence'])
    assert '30분 통근도시' in article['body']
    assert client.get(f"/api/articles/{article['article_id']}").status_code == 200
    path = f"/api/articles/{article['article_id']}"
    assert client.post(path + '/approve', json={'reviewer': '편집장'}).status_code == 409
    check = client.post(path + '/fact-check')
    assert check.status_code == 200, check.text
    assert check.json()['result']['status'] == 'pass'
    assert client.post(path + '/human-review', json={'reviewer': '기자'}).status_code == 200
    assert client.post(path + '/approve', json={'reviewer': '편집장'}).status_code == 200
    assert {event['action'] for event in client.get(path + '/audit').json()} >= {
        'draft_created', 'fact_checked', 'human_reviewed', 'approved'}


def test_missing_candidate_pledge_is_not_fabricated():
    response = client.post('/api/articles/from-pledges', json={'query': '존재하지않는후보 공약'})
    assert response.status_code == 404


def test_pledge_article_factcheck_rejects_removed_title():
    article = client.post('/api/articles/from-pledges',
                          json={'query': '서울시장 정원오 공약'}).json()
    title = article['evidence'][0]['title'].split(' 후보 공약: ', 1)[-1]
    updated_body = article['body'].replace(title, '다른 내용')
    path = f"/api/articles/{article['article_id']}"
    assert client.put(path, json={'title': article['title'], 'body': updated_body}).status_code == 200
    check = client.post(path + '/fact-check')
    assert check.json()['result']['status'] == 'fail'
    assert check.json()['article']['status'] == 'draft'
