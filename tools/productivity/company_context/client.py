"""Fetch historical company context documents.

This tool runs in the sandbox, which has no route to the core DB. All document
data is fetched over HTTP from the API's brokered endpoints under
``/agent/tools-data/company-context`` — the API runs the SQL and returns indexed
rows. The live-Slack merge runs here in the tool: it egresses over the iron-proxy
(not the DB), so the server only ever returns indexed rows plus the cutoff.
"""

from __future__ import annotations

import importlib.util
import json
import re
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from centaur_sdk.logging import stderr_json_logger
from centaur_sdk.tool_sdk import secret

log = stderr_json_logger()

DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50
MAX_RELATED_CHILDREN = 25
SLACK_LIVE_SOURCE_TYPE = "slack_live_message"
_SLACK_AFTER_RE = re.compile(r"\bafter:\d{4}-\d{2}-\d{2}\b", re.IGNORECASE)


def _clamp(value: int, *, minimum: int, maximum: int) -> int:
    """Clamp an integer tool input to predictable bounds before sending."""
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = minimum
    return max(minimum, min(value, maximum))


def _slack_ts_to_iso(ts: str | None) -> str | None:
    """Convert a Slack timestamp string to ISO 8601 when possible."""
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=UTC).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _slack_after_query(query_text: str, latest_date: str | None) -> str:
    """Append a Slack after:YYYY-MM-DD modifier unless the query already has one."""
    if not latest_date or _SLACK_AFTER_RE.search(query_text):
        return query_text
    return f"{query_text} after:{latest_date[:10]}"


def _load_slack_client() -> Any:
    """Load the sibling Slack tool client without making company_context import it eagerly."""
    candidate_roots = [
        Path("/app/tools/productivity/slack"),
        Path(__file__).resolve().parent.parent / "slack",
    ]
    slack_dir = next((path for path in candidate_roots if (path / "client.py").exists()), None)
    if slack_dir is None:
        raise RuntimeError("slack tool client not found")

    module_name = "_company_context_slack_client"
    spec = importlib.util.spec_from_file_location(module_name, slack_dir / "client.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("failed to load slack tool client")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._client()


def _live_slack_result(message: dict[str, Any]) -> dict[str, Any]:
    """Normalize slack.search_messages results into company_context search result shape."""
    channel = str(message.get("channel") or "")
    user = str(message.get("user") or "")
    timestamp = str(message.get("timestamp") or "")
    title_bits = []
    if channel:
        title_bits.append(f"#{channel}")
    if user:
        title_bits.append(f"from {user}")
    return {
        "document_id": "",
        "source": "slack",
        "source_type": SLACK_LIVE_SOURCE_TYPE,
        "source_document_id": str(message.get("thread_ts") or timestamp),
        "source_chunk_id": timestamp,
        "parent_document_id": None,
        "title": " ".join(title_bits) or "Slack message",
        "url": str(message.get("permalink") or ""),
        "author_name": user,
        "access_scope": "",
        "score": None,
        "preview": str(message.get("text") or ""),
        "occurred_at": _slack_ts_to_iso(timestamp),
        "source_updated_at": None,
        "lane": "live",
        "result_type": SLACK_LIVE_SOURCE_TYPE,
        "metadata": {
            "channel_name": channel,
            "channel_id": str(message.get("channel_id") or ""),
            "user_name": user,
            "user_id": str(message.get("user_id") or ""),
            "message_ts": timestamp,
            "thread_ts": message.get("thread_ts"),
            "reply_count": int(message.get("reply_count") or 0),
        },
    }


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
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


class CompanyContextClient:
    """Query the shared company context document table (via the API broker)."""

    def _merge_live_slack(
        self,
        payload: dict[str, Any],
        *,
        query_text: str,
        limit: int,
        source: str | None,
        source_type: str | None,
    ) -> dict[str, Any]:
        """Merge live Slack search results into an indexed-only search payload."""
        should_search_live_slack = source == "slack" and (
            source_type is None or source_type.startswith("slack")
        )
        if not should_search_live_slack:
            return payload

        live_results: list[dict[str, Any]] = []
        live_error = None
        try:
            live_query = _slack_after_query(query_text, payload.get("indexed_cutoff"))
            live_messages = _load_slack_client().search_messages(live_query, max_results=limit)
            live_results = [_live_slack_result(message) for message in live_messages]
        except Exception as exc:
            live_error = str(exc)
            # Surfaced to the caller via `live_error`, but also log so the
            # failure is visible in the agent's JSON logs, not just the payload.
            log.warning(
                "company_context live slack merge failed",
                extra={"event": "company_context_live_slack_failed", "source": source},
                exc_info=True,
            )

        indexed = list(payload.get("results", []))
        indexed_count = int(payload.get("indexed_count", len(indexed)))
        merged = dict(payload)
        merged["live_count"] = len(live_results)
        merged["count"] = indexed_count + len(live_results)
        merged["live_error"] = live_error
        merged["results"] = [*indexed, *live_results]
        return merged

    def search(
        self,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        source: str | None = None,
        source_type: str | None = None,
    ) -> dict:
        """Search company context documents and return candidate document ids."""
        normalized_query = query.strip()
        if not normalized_query:
            return {"status": "error", "error": "query cannot be empty"}

        clamped_limit = _clamp(limit, minimum=1, maximum=MAX_SEARCH_LIMIT)
        norm_source = source.strip() if source else None
        norm_source_type = source_type.strip() if source_type else None

        try:
            payload = _post_tools_data(
                "company-context/search",
                {
                    "query": normalized_query,
                    "limit": clamped_limit,
                    "source": norm_source,
                    "source_type": norm_source_type,
                },
            )
            if payload.get("status") != "ok":
                return payload
            return self._merge_live_slack(
                payload,
                query_text=normalized_query,
                limit=clamped_limit,
                source=norm_source,
                source_type=norm_source_type,
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def latest_date(self, source: str | None = None, source_type: str | None = None) -> dict:
        """Return the latest indexed timestamp for company context documents."""
        try:
            return _post_tools_data(
                "company-context/latest-date",
                {
                    "source": source.strip() if source else None,
                    "source_type": source_type.strip() if source_type else None,
                },
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def read_document(
        self,
        document_id: str,
        max_chars: int = 0,
        include_related: bool = False,
        max_related_children: int = MAX_RELATED_CHILDREN,
    ) -> dict:
        """Read a company context document by id, returning full content by default."""
        normalized_document_id = document_id.strip()
        if not normalized_document_id:
            return {"status": "error", "error": "document_id cannot be empty"}

        try:
            return _post_tools_data(
                "company-context/read-document",
                {
                    "document_id": normalized_document_id,
                    "max_chars": max_chars,
                    "include_related": include_related,
                    "max_related_children": _clamp(
                        max_related_children, minimum=1, maximum=MAX_RELATED_CHILDREN
                    ),
                },
            )
        except Exception as exc:
            return {"status": "error", "error": str(exc)}


def _client() -> CompanyContextClient:
    return CompanyContextClient()
