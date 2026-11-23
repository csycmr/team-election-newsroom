from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class CandidateResult(BaseModel):
    candidate_id: str
    candidate_name: str
    party: str
    votes: int = Field(ge=0)
    vote_rate: float = Field(ge=0, le=100)


class ElectionSnapshot(BaseModel):
    election_id: str
    election_name: str
    region: str
    step_id: int = Field(ge=0)
    counted_rate: float = Field(ge=0, le=100)
    collected_at: datetime
    source: str
    source_url: str
    mode: Literal["demo", "replay", "live"]
    record_type: Literal["reported", "simulated"] | None = None
    evidence_id: str | None = None
    candidates: list[CandidateResult]


class Evidence(BaseModel):
    evidence_id: str
    title: str
    content: str
    source: str
    source_url: str
    published_at: str
    candidate_name: str | None = None
    score: float = 0


class ArticleCreate(BaseModel):
    snapshot: ElectionSnapshot
    evidence: list[Evidence] = []


class Article(BaseModel):
    article_id: str
    title: str
    body: str
    status: Literal["draft", "fact_checked", "human_reviewed", "approved", "rejected"]
    snapshot: ElectionSnapshot
    evidence: list[Evidence]
    created_at: datetime
    updated_at: datetime


class ArticleUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    body: str = Field(min_length=1)


class ReviewRequest(BaseModel):
    reviewer: str = Field(min_length=1)
    note: str = ""


class FactCheckResult(BaseModel):
    status: Literal["pass", "review_required", "fail"]
    reason: str
    checks: list[dict]
    external_claims: list[dict] = []
    llm_review: dict = Field(default_factory=lambda: {"mode": "disabled", "issues": []})
