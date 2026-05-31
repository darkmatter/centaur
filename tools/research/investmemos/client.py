"""Investment memo retrieval client backed by the API broker.

This tool runs in the sandbox, which has no route to the core DB. All memo data
is fetched over HTTP from the API's brokered endpoints under
``/agent/tools-data/investmemos`` — the API runs the SQL (including the
grouping/ranking) and returns the results. ``build_miq_context`` is pure
client-side orchestration over ``search_memos``.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

from centaur_sdk.tool_sdk import secret

DEFAULT_MEMO_SOURCE = "invest_memo_corpus"
DEFAULT_MEMO_KIND = "invest_memo_chunk"


def _clip(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def _post_tools_data(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """POST to a brokered tools-data endpoint and return the JSON body.

    Mirrors ``centaur_sdk.tool_sdk.save_attachment``: base URL + bearer token come
    from sandbox-provided secrets. Raises on a non-2xx / connection error so the
    caller's ``except`` turns it into the standard tool error envelope.
    """
    base = secret("CENTAUR_API_URL", "http://api:8000").rstrip("/")
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    api_key = secret("CENTAUR_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        f"{base}/agent/tools-data/{path}",
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.loads(response.read())


class InvestmemosClient:
    """Search and read investment memos (via the API broker)."""

    def __init__(self) -> None:
        # Source/kind defaults stay tool-side so the agent-facing tool surface is
        # unchanged; the server re-resolves and re-clamps everything it receives.
        self._default_source = (
            os.getenv("INVEST_MEMO_SOURCE") or DEFAULT_MEMO_SOURCE  # noqa: TID251
        ).strip()
        self._default_kind = (
            os.getenv("INVEST_MEMO_KIND") or DEFAULT_MEMO_KIND  # noqa: TID251
        ).strip()

    def list_memos(self, query: str | None = None, limit: int = 50, source: str | None = None) -> dict:
        """List memo documents from the indexed memo corpus."""
        try:
            return _post_tools_data(
                "investmemos/list-memos",
                {
                    "query": query,
                    "limit": limit,
                    "source": (source or self._default_source).strip(),
                },
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def search_memos(
        self,
        query: str,
        limit: int = 12,
        stage: str | None = None,
        company_type: str | None = None,
        source: str | None = None,
        kind: str | None = None,
    ) -> dict:
        """Search indexed memo chunks and aggregate top documents."""
        if not query.strip():
            return {"status": "error", "error": "query cannot be empty"}
        try:
            return _post_tools_data(
                "investmemos/search-memos",
                {
                    "query": query,
                    "limit": limit,
                    "stage": stage,
                    "company_type": company_type,
                    "source": (source or self._default_source).strip(),
                    "kind": (kind or self._default_kind).strip(),
                },
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def read_memo(
        self,
        memo: str,
        max_chars: int = 12000,
        source: str | None = None,
        kind: str | None = None,
    ) -> dict:
        """Read memo content from indexed chunk corpus by document ID or memo name."""
        if not memo.strip():
            return {"status": "error", "error": "memo cannot be empty"}
        try:
            return _post_tools_data(
                "investmemos/read-memo",
                {
                    "memo": memo.strip(),
                    "max_chars": max_chars,
                    "source": (source or self._default_source).strip(),
                    "kind": (kind or self._default_kind).strip(),
                },
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def build_miq_context(
        self,
        opportunity: str,
        miqs: list[str],
        memos_per_miq: int = 2,
        excerpt_chars: int = 1200,
        stage: str | None = None,
        company_type: str | None = None,
        source: str | None = None,
        kind: str | None = None,
    ) -> dict:
        """Build MIQ-indexed memo priors from indexed corpus search."""
        if not miqs:
            return {"status": "error", "error": "miqs must be non-empty"}

        out: list[dict[str, Any]] = []
        for miq in miqs:
            combined_query = f"{opportunity} {miq}".strip()
            search = self.search_memos(
                query=combined_query,
                limit=max(1, min(memos_per_miq, 6)),
                stage=stage,
                company_type=company_type,
                source=source,
                kind=kind,
            )
            if search.get("status") != "ok":
                out.append({"miq": miq, "matches": [], "error": search.get("error")})
                continue
            matches = []
            for result in search.get("results", []):
                excerpts = [str(x) for x in (result.get("excerpts") or [])]
                excerpt = "\n\n".join(excerpts)
                matches.append(
                    {
                        "document_id": result.get("document_id"),
                        "memo_name": result.get("memo_name"),
                        "score": result.get("score"),
                        "stage_hint": result.get("stage_hint"),
                        "type_hint": result.get("type_hint"),
                        "matched_chunks": result.get("matched_chunks"),
                        "source_ids": result.get("source_ids"),
                        "excerpt": _clip(excerpt, max(400, min(excerpt_chars, 6000))),
                    }
                )
            out.append({"miq": miq, "matches": matches})

        return {
            "status": "ok",
            "source": (source or self._default_source).strip(),
            "kind": (kind or self._default_kind).strip(),
            "opportunity": opportunity,
            "miq_context": out,
        }


def _client() -> InvestmemosClient:
    return InvestmemosClient()
