"""Pydantic models for websearch tool contracts."""

from __future__ import annotations

from pydantic import BaseModel, Field


class SourceDocument(BaseModel):
    source_id: int
    title: str
    url: str
    snippet: str = ""
    published_date: str | None = None
    domain: str | None = None


class ResponseMeta(BaseModel):
    duration_ms: int
    exa_request_ids: list[str] = Field(default_factory=list)
    partial_failures: list[dict[str, str]] = Field(default_factory=list)
    estimated_cost_usd: float | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SourceDocument]
    answer_markdown: str | None = None
    meta: ResponseMeta


class DeepResearchIteration(BaseModel):
    iteration: int
    queries: list[str]
    results_count: int
    continue_reason: str = ""


class DeepResearchResponse(BaseModel):
    question: str
    answer_markdown: str
    sources: list[SourceDocument]
    iterations: list[DeepResearchIteration]
    meta: ResponseMeta
