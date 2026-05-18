"""Websearch client powered by Exa and Claude."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

import httpx

try:
    from anthropic import AsyncAnthropic
except ImportError:  # pragma: no cover - optional until tool deps are installed
    AsyncAnthropic = None  # type: ignore[assignment]

from centaur_sdk import secret

from .models import (
    DeepResearchIteration,
    DeepResearchResponse,
    ResponseMeta,
    SearchResponse,
    SourceDocument,
)
from .prompts import (
    EVIDENCE_REVIEWER_SYSTEM,
    QUERY_PLANNER_SYSTEM,
    REPORT_REPAIR_SYSTEM,
    REPORT_WRITER_SYSTEM,
)


class WebSearchClient:
    """Web search and deep research via Exa and Claude."""

    EXA_MAX_PARALLEL_CALLS = 6
    REVIEW_SOURCE_CHAR_LIMIT = 3500
    REVIEW_TOTAL_CHAR_BUDGET = 120000
    WRITE_SOURCE_CHAR_LIMIT = 7000
    WRITE_TOTAL_CHAR_BUDGET = 220000
    SNIPPET_CHAR_LIMIT = 7000

    def __init__(
        self,
        exa_api_key: str | None = None,
        anthropic_api_key: str | None = None,
        deep_research_model: str | None = None,
        exa_base_url: str = "https://api.exa.ai",
        max_retries: int = 3,
    ):
        self._exa_api_key = exa_api_key or self._optional_secret("EXA_API_KEY")
        self._anthropic_api_key = anthropic_api_key or self._optional_secret("ANTHROPIC_API_KEY")
        self._deep_research_model = deep_research_model or self._optional_secret(
            "DEEP_RESEARCH_MODEL", "claude-opus-4-6"
        )
        self._exa_base_url = exa_base_url.rstrip("/")
        self._max_retries = max_retries
        self._progress_callback: Callable[[str], None] | None = None

    def _set_progress_callback(self, callback: Callable[[str], None] | None) -> None:
        self._progress_callback = callback

    def _emit_progress(self, stage: str) -> None:
        if self._progress_callback is not None:
            self._progress_callback(stage)

    def _optional_secret(self, key: str, default: str | None = None) -> str | None:
        try:
            return secret(key)
        except KeyError:
            return default

    def _require_exa_api_key(self) -> str:
        if not self._exa_api_key:
            raise RuntimeError("EXA_API_KEY not set.")
        return self._exa_api_key

    def _require_anthropic_api_key(self) -> str:
        if not self._anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set.")
        return self._anthropic_api_key

    def _require_deep_research_model(self) -> str:
        if not self._deep_research_model:
            raise RuntimeError("DEEP_RESEARCH_MODEL not set.")
        return self._deep_research_model

    def _is_retryable_status(self, status_code: int) -> bool:
        return status_code == 429 or status_code >= 500

    def _backoff_seconds(self, attempt: int) -> float:
        # Small bounded backoff keeps CLI responsive while handling transient API failures.
        return min(8.0, 2**attempt)

    def _exa_headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._require_exa_api_key(),
            "Content-Type": "application/json",
        }

    def _build_search_payload(
        self,
        query: str,
        num_results: int,
        search_type: str,
        include_domains: list[str] | None,
        exclude_domains: list[str] | None,
        max_age_hours: int | None,
        text_chars: int | None,
        highlights_chars: int | None,
        additional_queries: list[str] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "query": query,
            "numResults": num_results,
            "type": search_type,
        }
        contents: dict[str, Any] = {}
        if text_chars is not None:
            contents["text"] = {"maxCharacters": text_chars}
        if highlights_chars is not None:
            contents["highlights"] = {"maxCharacters": highlights_chars}
        if contents:
            payload["contents"] = contents
        if include_domains:
            payload["includeDomains"] = include_domains
        if exclude_domains:
            payload["excludeDomains"] = exclude_domains
        if max_age_hours is not None:
            payload["maxAgeHours"] = max_age_hours
        if additional_queries:
            payload["additionalQueries"] = additional_queries
        return payload

    def _extract_cost(self, payload: dict[str, Any]) -> float:
        cost = payload.get("costDollars")
        if isinstance(cost, (int, float)):
            return float(cost)
        if isinstance(cost, dict):
            total = cost.get("total")
            if isinstance(total, (int, float)):
                return float(total)
            subtotal = 0.0
            found = False
            for value in cost.values():
                if isinstance(value, (int, float)):
                    found = True
                    subtotal += float(value)
            if found:
                return subtotal
        return 0.0

    def _extract_snippet(self, item: dict[str, Any], max_chars: int | None = None) -> str:
        char_limit = max_chars or self.SNIPPET_CHAR_LIMIT
        highlights = item.get("highlights")
        if isinstance(highlights, list) and highlights:
            joined = "\n".join(str(part) for part in highlights if part)
            return joined[:char_limit]
        text = item.get("text")
        if isinstance(text, str) and text:
            return text[:char_limit]
        summary = item.get("summary")
        if isinstance(summary, str):
            return summary[:char_limit]
        return ""

    def _normalize_source(
        self,
        item: dict[str, Any],
        source_id: int,
        snippet_chars: int | None = None,
    ) -> SourceDocument | None:
        url = str(item.get("url", "")).strip()
        if not url:
            return None
        parsed = urlparse(url)
        title = str(item.get("title", "")).strip() or url
        published_date = item.get("publishedDate")
        if published_date is not None:
            published_date = str(published_date)
        return SourceDocument(
            source_id=source_id,
            title=title,
            url=url,
            snippet=self._extract_snippet(item, max_chars=snippet_chars),
            published_date=published_date,
            domain=parsed.netloc or None,
        )

    def _dedupe_queries(self, queries: list[str], limit: int) -> list[str]:
        deduped: list[str] = []
        seen: set[str] = set()
        for query in queries:
            normalized = query.strip()
            key = normalized.casefold()
            if not normalized or key in seen:
                continue
            seen.add(key)
            deduped.append(normalized)
            if len(deduped) >= limit:
                break
        return deduped

    def _trim_sources_for_budget(
        self,
        sources: list[SourceDocument],
        *,
        per_source_chars: int,
        total_chars: int,
    ) -> list[dict[str, Any]]:
        selected: list[dict[str, Any]] = []
        consumed = 0
        ranked_sources = sorted(sources, key=self._source_quality_score, reverse=True)
        for source in ranked_sources:
            snippet = source.snippet[:per_source_chars]
            if not snippet:
                snippet = source.title
            projected = consumed + len(snippet)
            if selected and projected > total_chars:
                break
            selected.append(
                {
                    "source_id": source.source_id,
                    "title": source.title,
                    "url": source.url,
                    "snippet": snippet,
                    "published_date": source.published_date,
                    "domain": source.domain,
                }
            )
            consumed = projected
        return selected

    def _normalize_thread_context(
        self,
        thread_context: list[str] | None,
        *,
        max_items: int = 20,
        max_chars_per_item: int = 1200,
    ) -> list[str]:
        if not thread_context:
            return []
        normalized: list[str] = []
        for item in thread_context:
            text = str(item).strip()
            if not text:
                continue
            normalized.append(text[:max_chars_per_item])
            if len(normalized) >= max_items:
                break
        return normalized

    def _source_quality_score(self, source: SourceDocument) -> int:
        score = 0
        snippet_lower = source.snippet.lower()
        domain = (source.domain or "").lower()

        if source.published_date:
            score += 1
        if len(source.snippet) > 600:
            score += 1
        if domain.endswith(".gov") or domain.endswith(".edu"):
            score += 3
        if any(token in domain for token in ("nist", "pci", "fidelity", "iacr")):
            score += 2

        low_signal_tokens = [
            "book now",
            "free 30-min",
            "cookie policy",
            "skip to content",
            "all protocols",
        ]
        if any(token in snippet_lower for token in low_signal_tokens):
            score -= 2
        if "linkedin.com" in domain:
            score -= 2
        return score

    def _extract_sources_section_ids(self, text: str) -> set[int]:
        match = re.search(r"##\s*Sources\s*(.*)$", text, flags=re.IGNORECASE | re.DOTALL)
        if not match:
            return set()
        ids: set[int] = set()
        for source_id in re.findall(r"^\s*\[\s*(\d+)\s*\]\s+", match.group(1), flags=re.MULTILINE):
            ids.add(int(source_id))
        return ids

    def _normalize_claims(
        self,
        claims: list[Any],
        valid_source_ids: set[int],
    ) -> list[dict[str, Any]]:
        normalized_claims: list[dict[str, Any]] = []
        seen_claims: set[str] = set()
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            claim_text = str(claim.get("claim", "")).strip()
            if not claim_text:
                continue
            claim_key = claim_text.casefold()
            if claim_key in seen_claims:
                continue

            source_ids_raw = claim.get("source_ids", [])
            source_ids: list[int] = []
            if isinstance(source_ids_raw, list):
                for raw_id in source_ids_raw:
                    if isinstance(raw_id, int) and raw_id in valid_source_ids:
                        source_ids.append(raw_id)
            source_ids = sorted(set(source_ids))
            support_level = str(claim.get("support_level", "none")).strip().lower()
            if support_level not in {"strong", "partial", "weak", "none"}:
                support_level = "none"

            normalized_claims.append(
                {
                    "claim": claim_text,
                    "source_ids": source_ids,
                    "support_level": support_level,
                }
            )
            seen_claims.add(claim_key)
        return normalized_claims

    def _normalize_contradictions(
        self,
        contradictions: list[Any],
        valid_source_ids: set[int],
    ) -> list[dict[str, Any]]:
        normalized_items: list[dict[str, Any]] = []
        seen_summaries: set[str] = set()
        for contradiction in contradictions:
            if not isinstance(contradiction, dict):
                continue
            summary = str(contradiction.get("summary", "")).strip()
            if not summary:
                continue
            summary_key = summary.casefold()
            if summary_key in seen_summaries:
                continue

            source_ids_raw = contradiction.get("source_ids", [])
            source_ids: list[int] = []
            if isinstance(source_ids_raw, list):
                for raw_id in source_ids_raw:
                    if isinstance(raw_id, int) and raw_id in valid_source_ids:
                        source_ids.append(raw_id)
            normalized_items.append(
                {"summary": summary, "source_ids": sorted(set(source_ids))}
            )
            seen_summaries.add(summary_key)
        return normalized_items

    def _extract_text_content(self, response: Any) -> str:
        blocks = getattr(response, "content", None)
        if not isinstance(blocks, list):
            return ""
        parts: list[str] = []
        for block in blocks:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts).strip()

    def _coerce_json(self, raw_text: str) -> Any:
        stripped = raw_text.strip()
        if stripped.startswith("```"):
            stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
            stripped = re.sub(r"\s*```$", "", stripped)
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        object_match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if object_match:
            return json.loads(object_match.group(0))
        array_match = re.search(r"\[.*\]", stripped, flags=re.DOTALL)
        if array_match:
            return json.loads(array_match.group(0))
        raise ValueError("Model response did not contain valid JSON.")

    def _extract_citation_ids(self, text: str) -> set[int]:
        ids: set[int] = set()
        for match in re.findall(r"\[\s*(\d+)\s*\]", text):
            ids.add(int(match))
        return ids

    def _invalid_citation_ids(self, text: str, sources: list[SourceDocument]) -> set[int]:
        valid = {source.source_id for source in sources}
        citations = self._extract_citation_ids(text)
        return {citation for citation in citations if citation not in valid}

    def _exa_search_sync(self, payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
        with httpx.Client(base_url=self._exa_base_url, timeout=timeout_seconds) as client:
            for attempt in range(self._max_retries):
                response: httpx.Response | None = None
                try:
                    response = client.post("/search", headers=self._exa_headers(), json=payload)
                    if (
                        self._is_retryable_status(response.status_code)
                        and attempt < self._max_retries - 1
                    ):
                        time.sleep(self._backoff_seconds(attempt))
                        continue
                    response.raise_for_status()
                    return response.json()
                except httpx.HTTPStatusError as exc:
                    if (
                        response is not None
                        and self._is_retryable_status(response.status_code)
                        and attempt < self._max_retries - 1
                    ):
                        time.sleep(self._backoff_seconds(attempt))
                        continue
                    body = exc.response.text if exc.response is not None else ""
                    raise RuntimeError(
                        f"Exa search failed ({exc.response.status_code}): {body}"
                    ) from exc
                except httpx.RequestError as exc:
                    if attempt < self._max_retries - 1:
                        time.sleep(self._backoff_seconds(attempt))
                        continue
                    raise RuntimeError(f"Exa request failed: {exc}") from exc
        raise RuntimeError("Exa search failed after retries.")

    async def _exa_search_async(
        self, payload: dict[str, Any], timeout_seconds: float
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(
            base_url=self._exa_base_url, timeout=timeout_seconds
        ) as client:
            for attempt in range(self._max_retries):
                response: httpx.Response | None = None
                try:
                    response = await client.post(
                        "/search", headers=self._exa_headers(), json=payload
                    )
                    if (
                        self._is_retryable_status(response.status_code)
                        and attempt < self._max_retries - 1
                    ):
                        await asyncio.sleep(self._backoff_seconds(attempt))
                        continue
                    response.raise_for_status()
                    return response.json()
                except httpx.HTTPStatusError as exc:
                    if (
                        response is not None
                        and self._is_retryable_status(response.status_code)
                        and attempt < self._max_retries - 1
                    ):
                        await asyncio.sleep(self._backoff_seconds(attempt))
                        continue
                    body = exc.response.text if exc.response is not None else ""
                    raise RuntimeError(
                        f"Exa search failed ({exc.response.status_code}): {body}"
                    ) from exc
                except httpx.RequestError as exc:
                    if attempt < self._max_retries - 1:
                        await asyncio.sleep(self._backoff_seconds(attempt))
                        continue
                    raise RuntimeError(f"Exa request failed: {exc}") from exc
        raise RuntimeError("Exa search failed after retries.")

    async def _run_iteration_search(
        self,
        *,
        queries: list[str],
        num_results_per_query: int,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        deduped_queries = self._dedupe_queries(queries, limit=16)
        if not deduped_queries:
            return {
                "results": [],
                "requestIds": [],
                "partialFailures": [],
                "costDollars": {"total": 0.0},
            }

        max_parallel = max(1, min(self.EXA_MAX_PARALLEL_CALLS, len(deduped_queries)))
        semaphore = asyncio.Semaphore(max_parallel)

        async def run_query(query: str) -> dict[str, Any]:
            async with semaphore:
                payload = self._build_search_payload(
                    query=query,
                    num_results=min(20, max(num_results_per_query, 1)),
                    search_type="deep",
                    include_domains=None,
                    exclude_domains=None,
                    max_age_hours=None,
                    text_chars=12000,
                    highlights_chars=4000,
                    additional_queries=None,
                )
                return await self._exa_search_async(payload=payload, timeout_seconds=timeout_seconds)

        batch_results = await asyncio.gather(
            *(run_query(query) for query in deduped_queries), return_exceptions=True
        )

        merged_results: list[dict[str, Any]] = []
        request_ids: list[str] = []
        partial_failures: list[dict[str, str]] = []
        total_cost = 0.0
        for query, result in zip(deduped_queries, batch_results, strict=True):
            if isinstance(result, Exception):
                partial_failures.append({"query": query, "error": str(result)})
                continue
            request_id = result.get("requestId")
            if request_id:
                request_ids.append(str(request_id))
            total_cost += self._extract_cost(result)
            for item in result.get("results", []):
                if isinstance(item, dict):
                    merged_results.append(item)

        return {
            "results": merged_results,
            "requestIds": request_ids,
            "partialFailures": partial_failures,
            "costDollars": {"total": total_cost},
        }

    async def _call_claude_text(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 4096,
    ) -> str:
        if AsyncAnthropic is None:
            raise RuntimeError("anthropic dependency is not installed.")
        client = AsyncAnthropic(api_key=self._require_anthropic_api_key())
        try:
            message = await client.messages.create(
                model=self._require_deep_research_model(),
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
        except Exception as exc:
            message = str(exc).lower()
            if "authentication_error" in message or "invalid x-api-key" in message:
                raise RuntimeError(
                    "Anthropic authentication failed. Check ANTHROPIC_API_KEY in .env or env injection."
                ) from exc
            raise
        text = self._extract_text_content(message)
        if not text:
            raise RuntimeError("Claude returned empty content.")
        return text

    async def _call_claude_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 2048,
    ) -> Any:
        raw = await self._call_claude_text(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
        )
        return self._coerce_json(raw)

    async def _plan_queries(
        self,
        *,
        question: str,
        prior_queries: list[str],
        prior_gaps: list[str],
        thread_context: list[str],
        query_limit: int,
    ) -> dict[str, Any]:
        user_prompt = json.dumps(
            {
                "question": question,
                "prior_queries": prior_queries,
                "prior_gaps": prior_gaps,
                "thread_context": thread_context,
            },
            indent=2,
        )
        payload = await self._call_claude_json(
            system_prompt=QUERY_PLANNER_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=1600,
        )
        if not isinstance(payload, dict):
            raise RuntimeError("Planner output must be a JSON object.")

        raw_queries = payload.get("queries", [])
        raw_queries = [str(query) for query in raw_queries] if isinstance(raw_queries, list) else []
        queries = self._dedupe_queries(raw_queries, limit=query_limit)
        decision = str(payload.get("decision", "continue")).strip().lower()
        if decision not in {"continue", "stop"}:
            decision = "continue"
        return {
            "decision": decision,
            "reason": str(payload.get("reason", "")).strip(),
            "queries": queries,
            "gaps": [str(gap).strip() for gap in payload.get("gaps", []) if str(gap).strip()],
        }

    async def _review_evidence(
        self,
        *,
        question: str,
        sources: list[SourceDocument],
        iteration: int,
        max_iterations: int,
        thread_context: list[str],
    ) -> dict[str, Any]:
        compact_sources = self._trim_sources_for_budget(
            sources,
            per_source_chars=self.REVIEW_SOURCE_CHAR_LIMIT,
            total_chars=self.REVIEW_TOTAL_CHAR_BUDGET,
        )
        user_prompt = json.dumps(
            {
                "question": question,
                "iteration": iteration,
                "max_iterations": max_iterations,
                "thread_context": thread_context,
                "sources": compact_sources,
            },
            indent=2,
        )
        payload = await self._call_claude_json(
            system_prompt=EVIDENCE_REVIEWER_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=3600,
        )
        if not isinstance(payload, dict):
            raise RuntimeError("Evidence reviewer output must be a JSON object.")

        followup_raw = payload.get("followup_queries", [])
        if isinstance(followup_raw, list):
            followup_raw = [str(query) for query in followup_raw]
        else:
            followup_raw = []
        followup = self._dedupe_queries(followup_raw, limit=8)

        valid_source_ids = {source.source_id for source in sources}
        claims = self._normalize_claims(
            claims=payload.get("claims", []) if isinstance(payload.get("claims"), list) else [],
            valid_source_ids=valid_source_ids,
        )
        contradictions = self._normalize_contradictions(
            contradictions=payload.get("contradictions", [])
            if isinstance(payload.get("contradictions"), list)
            else [],
            valid_source_ids=valid_source_ids,
        )
        continue_research = bool(payload.get("continue_research", False))
        return {
            "claims": claims,
            "contradictions": contradictions,
            "continue_research": continue_research,
            "followup_queries": followup,
        }

    async def _write_report(
        self,
        *,
        question: str,
        sources: list[SourceDocument],
        claims: list[dict[str, Any]],
        contradictions: list[dict[str, Any]],
        thread_context: list[str],
        max_report_chars: int,
    ) -> str:
        selected_sources = self._trim_sources_for_budget(
            sources,
            per_source_chars=self.WRITE_SOURCE_CHAR_LIMIT,
            total_chars=self.WRITE_TOTAL_CHAR_BUDGET,
        )
        source_map = {source["source_id"]: source for source in selected_sources}
        user_prompt = json.dumps(
            {
                "question": question,
                "claims": claims,
                "contradictions": contradictions,
                "thread_context": thread_context,
                "source_map": source_map,
            },
            indent=2,
        )
        report = await self._call_claude_text(
            system_prompt=REPORT_WRITER_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=8000,
        )
        return report[:max_report_chars]

    async def _repair_report_citations(
        self,
        *,
        report: str,
        invalid_ids: list[int],
        missing_sources_ids: list[int],
        sources: list[SourceDocument],
        max_report_chars: int,
    ) -> str:
        source_map = {
            source.source_id: {
                "title": source.title,
                "url": source.url,
                "snippet": source.snippet[: self.REVIEW_SOURCE_CHAR_LIMIT],
            }
            for source in sources
        }
        user_prompt = json.dumps(
            {
                "invalid_citation_ids": invalid_ids,
                "missing_sources_section_ids": missing_sources_ids,
                "source_map": source_map,
                "report": report,
            },
            indent=2,
        )
        repaired = await self._call_claude_text(
            system_prompt=REPORT_REPAIR_SYSTEM,
            user_prompt=user_prompt,
            max_tokens=7000,
        )
        return repaired[:max_report_chars]

    async def _validate_and_repair_citations(
        self,
        *,
        report: str,
        sources: list[SourceDocument],
        max_report_chars: int,
    ) -> str:
        max_repair_attempts = 2
        invalid_ids = sorted(self._invalid_citation_ids(report, sources))
        cited_ids = self._extract_citation_ids(report)
        source_section_ids = self._extract_sources_section_ids(report)
        missing_sources_ids = sorted(cited_ids - source_section_ids)
        attempt = 0
        while (invalid_ids or missing_sources_ids) and attempt < max_repair_attempts:
            attempt += 1
            report = await self._repair_report_citations(
                report=report,
                invalid_ids=invalid_ids,
                missing_sources_ids=missing_sources_ids,
                sources=sources,
                max_report_chars=max_report_chars,
            )
            invalid_ids = sorted(self._invalid_citation_ids(report, sources))
            cited_ids = self._extract_citation_ids(report)
            source_section_ids = self._extract_sources_section_ids(report)
            missing_sources_ids = sorted(cited_ids - source_section_ids)
        if invalid_ids:
            raise RuntimeError(f"Citation validation failed. Invalid source IDs in report: {invalid_ids}")
        if missing_sources_ids:
            raise RuntimeError(
                "Citation validation failed. Sources section missing cited IDs: "
                f"{missing_sources_ids}"
            )
        if not self._extract_citation_ids(report):
            raise RuntimeError("Citation validation failed. Report did not include source citations.")
        return report

    async def search(
        self,
        query: str,
        *,
        num_results: int = 10,
        search_type: str = "auto",
        include_domains: list[str] | None = None,
        exclude_domains: list[str] | None = None,
        max_age_hours: int | None = None,
        timeout_seconds: float = 30.0,
        synthesize: bool = True,
        thread_context: list[str] | None = None,
        max_report_chars: int = 12000,
    ) -> dict:
        """Search the web via Exa and optionally synthesize a cited answer."""
        self._require_exa_api_key()
        started = time.perf_counter()
        normalized_query = query.strip()
        normalized_thread_context = self._normalize_thread_context(thread_context)
        if not normalized_query:
            raise RuntimeError("query cannot be empty.")
        payload = self._build_search_payload(
            query=normalized_query,
            num_results=num_results,
            search_type=search_type,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            max_age_hours=max_age_hours,
            text_chars=None,
            highlights_chars=2000,
        )
        response = await self._exa_search_async(payload, timeout_seconds=timeout_seconds)
        results: list[SourceDocument] = []
        seen_urls: set[str] = set()
        for item in response.get("results", []):
            if not isinstance(item, dict):
                continue
            source = self._normalize_source(item, len(results))
            if source is None or source.url in seen_urls:
                continue
            seen_urls.add(source.url)
            results.append(source)

        partial_failures: list[dict[str, str]] = []
        answer_markdown: str | None = None
        if synthesize and results:
            try:
                self._require_anthropic_api_key()
                self._require_deep_research_model()
                reviewer = await self._review_evidence(
                    question=normalized_query,
                    sources=results,
                    iteration=1,
                    max_iterations=1,
                    thread_context=normalized_thread_context,
                )
                answer_markdown = await self._write_report(
                    question=normalized_query,
                    sources=results,
                    claims=reviewer["claims"],
                    contradictions=reviewer["contradictions"],
                    thread_context=normalized_thread_context,
                    max_report_chars=max_report_chars,
                )
                answer_markdown = await self._validate_and_repair_citations(
                    report=answer_markdown,
                    sources=results,
                    max_report_chars=max_report_chars,
                )
            except Exception as exc:
                partial_failures.append({"query": normalized_query, "error": f"synthesis failed: {exc}"})

        meta = ResponseMeta(
            duration_ms=int((time.perf_counter() - started) * 1000),
            exa_request_ids=[str(response.get("requestId", ""))]
            if response.get("requestId")
            else [],
            partial_failures=partial_failures,
            estimated_cost_usd=self._extract_cost(response) or None,
        )
        return SearchResponse(
            query=normalized_query,
            results=results,
            answer_markdown=answer_markdown,
            meta=meta,
        ).model_dump()

    async def deep_research(
        self,
        question: str,
        *,
        max_iterations: int = 1,
        num_queries_per_iteration: int = 4,
        num_results_per_query: int = 5,
        thread_context: list[str] | None = None,
        max_report_chars: int = 50000,
        timeout_seconds: float = 300.0,
    ) -> dict:
        """Run iterative deep research with citation validation."""
        self._require_exa_api_key()
        self._require_anthropic_api_key()
        self._require_deep_research_model()
        if max_iterations < 1:
            raise RuntimeError("max_iterations must be >= 1.")
        if num_queries_per_iteration < 1:
            raise RuntimeError("num_queries_per_iteration must be >= 1.")
        if num_results_per_query < 1:
            raise RuntimeError("num_results_per_query must be >= 1.")
        started = time.perf_counter()

        normalized_question = question.strip()
        normalized_thread_context = self._normalize_thread_context(thread_context)
        if not normalized_question:
            raise RuntimeError("question cannot be empty.")

        all_sources: list[SourceDocument] = []
        seen_urls: set[str] = set()
        iteration_summaries: list[DeepResearchIteration] = []
        request_ids: list[str] = []
        partial_failures: list[dict[str, str]] = []
        estimated_cost_usd = 0.0

        self._emit_progress("planning")
        planner = await self._plan_queries(
            question=normalized_question,
            prior_queries=[],
            prior_gaps=[],
            thread_context=normalized_thread_context,
            query_limit=num_queries_per_iteration,
        )
        current_queries = planner["queries"]
        if planner["decision"] == "stop":
            current_queries = []
        if not current_queries:
            current_queries = [normalized_question]

        reviewer_claims: list[dict[str, Any]] = []
        reviewer_contradictions: list[dict[str, Any]] = []

        for iteration_index in range(1, max_iterations + 1):
            self._emit_progress(f"searching iteration {iteration_index}")
            deduped_current_queries = self._dedupe_queries(
                current_queries, limit=num_queries_per_iteration
            )
            try:
                batch_result = await self._run_iteration_search(
                    queries=deduped_current_queries,
                    num_results_per_query=num_results_per_query,
                    timeout_seconds=timeout_seconds / max_iterations,
                )
                batch_results: list[Any] = [batch_result]
            except Exception as exc:  # pragma: no cover - network path
                batch_results = [exc]

            added_in_iteration = 0
            for query, result in zip(["; ".join(deduped_current_queries)], batch_results, strict=True):
                if isinstance(result, Exception):
                    partial_failures.append({"query": query, "error": str(result)})
                    continue
                request_id_list = result.get("requestIds")
                if isinstance(request_id_list, list):
                    request_ids.extend(str(request_id) for request_id in request_id_list if request_id)
                elif result.get("requestId"):
                    request_ids.append(str(result.get("requestId")))
                result_partial_failures = result.get("partialFailures", [])
                if isinstance(result_partial_failures, list):
                    for failure in result_partial_failures:
                        if (
                            isinstance(failure, dict)
                            and isinstance(failure.get("query"), str)
                            and isinstance(failure.get("error"), str)
                        ):
                            partial_failures.append(
                                {"query": failure["query"], "error": failure["error"]}
                            )
                estimated_cost_usd += self._extract_cost(result)

                for item in result.get("results", []):
                    if not isinstance(item, dict):
                        continue
                    source = self._normalize_source(
                        item,
                        len(all_sources),
                        snippet_chars=self.SNIPPET_CHAR_LIMIT,
                    )
                    if source is None or source.url in seen_urls:
                        continue
                    seen_urls.add(source.url)
                    all_sources.append(source)
                    added_in_iteration += 1

            if not all_sources:
                partial_failures.append(
                    {
                        "query": "; ".join(deduped_current_queries),
                        "error": "No evidence retrieved from Exa in this iteration.",
                    }
                )
                continue

            self._emit_progress(f"reviewing iteration {iteration_index}")
            reviewer = await self._review_evidence(
                question=normalized_question,
                sources=all_sources,
                iteration=iteration_index,
                max_iterations=max_iterations,
                thread_context=normalized_thread_context,
            )
            reviewer_claims = self._normalize_claims(
                claims=reviewer_claims + reviewer["claims"],
                valid_source_ids={source.source_id for source in all_sources},
            )
            reviewer_contradictions = self._normalize_contradictions(
                contradictions=reviewer_contradictions + reviewer["contradictions"],
                valid_source_ids={source.source_id for source in all_sources},
            )

            continue_reason = planner.get("reason", "") if iteration_index == 1 else ""
            if reviewer["continue_research"]:
                continue_reason = "reviewer requested follow-up queries"
            iteration_summaries.append(
                DeepResearchIteration(
                    iteration=iteration_index,
                    queries=deduped_current_queries,
                    results_count=added_in_iteration,
                    continue_reason=continue_reason,
                )
            )

            should_continue = (
                reviewer["continue_research"]
                and iteration_index < max_iterations
                and len(reviewer["followup_queries"]) > 0
            )
            if not should_continue:
                break
            current_queries = self._dedupe_queries(
                reviewer["followup_queries"], limit=num_queries_per_iteration
            )

        if not all_sources:
            detail = "; ".join(item["error"] for item in partial_failures) or "No sources found."
            raise RuntimeError(f"Unable to produce grounded synthesis. {detail}")

        self._emit_progress("writing report")
        report = await self._write_report(
            question=normalized_question,
            sources=all_sources,
            claims=reviewer_claims,
            contradictions=reviewer_contradictions,
            thread_context=normalized_thread_context,
            max_report_chars=max_report_chars,
        )
        self._emit_progress("validating citations")
        report = await self._validate_and_repair_citations(
            report=report,
            sources=all_sources,
            max_report_chars=max_report_chars,
        )

        meta = ResponseMeta(
            duration_ms=int((time.perf_counter() - started) * 1000),
            exa_request_ids=request_ids,
            partial_failures=partial_failures,
            estimated_cost_usd=estimated_cost_usd if estimated_cost_usd > 0 else None,
        )
        payload = DeepResearchResponse(
            question=normalized_question,
            answer_markdown=report,
            sources=all_sources,
            iterations=iteration_summaries,
            meta=meta,
        )
        return payload.model_dump()


def _client() -> WebSearchClient:
    """Factory for tool loader."""
    return WebSearchClient()
