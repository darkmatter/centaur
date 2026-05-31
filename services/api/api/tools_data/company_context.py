"""SQL query functions for company-context data, owned by the API service.

The ``company_context`` tool runs in the sandbox, which has no route to the core
DB, so it reaches this data over HTTP through ``routers/tools_data.py``. These
functions are the sole DB-query path: the router runs them on
``request.app.state.db_pool`` (which exposes ``.fetch``/``.fetchrow``).

They hold **no Slack** logic — the live-Slack merge runs client-side in the tool,
over the egress proxy — and take a connection-like ``conn`` argument rather than
opening their own. The clamp helper lives here; the router re-clamps every input
because the sandbox is a hostile boundary.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50
TITLE_MATCH_BOOST = 4
EXACT_QUERY_TITLE_BOOST = 8
EXACT_QUERY_BODY_BOOST = 2
THREAD_SCORE_MULTIPLIER = 1.25
CHANNEL_DAY_SCORE_MULTIPLIER = 0.75
DEFAULT_PREVIEW_CHARS = 280
MAX_RELATED_CHILDREN = 25

_SEARCH_TERM_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]*")
_STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "their",
    "there",
    "these",
    "they",
    "this",
    "to",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
}


def clamp(value: int, *, minimum: int, maximum: int) -> int:
    """Clamp integer tool inputs to predictable output bounds."""
    return max(minimum, min(int(value), maximum))


def _as_dict(value: Any) -> dict[str, Any]:
    """Decode asyncpg JSON/JSONB values into a dict."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _isoformat(value: Any) -> str | None:
    """Serialize datetimes while leaving absent values explicit."""
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _normalize_text(value: str) -> str:
    """Collapse whitespace so previews stay compact and readable."""
    return re.sub(r"\s+", " ", value).strip()


def _search_terms(query: str) -> list[str]:
    """Extract unique content terms, falling back when filtering removes everything."""
    seen: set[str] = set()
    all_terms: list[str] = []
    filtered_terms: list[str] = []
    for match in _SEARCH_TERM_RE.finditer(query):
        term = match.group(0).strip()
        if len(term) < 2:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        all_terms.append(term)
        if key not in _STOP_WORDS:
            filtered_terms.append(term)
    return filtered_terms or all_terms or [query]


def _search_where_clause(term_count: int) -> str:
    """Build a ParadeDB query that boosts exact matches and falls back to OR term matching."""
    clauses = [
        "("
        f"title ||| $1::text::pdb.boost({EXACT_QUERY_TITLE_BOOST}) "
        f"OR body ||| $1::text::pdb.boost({EXACT_QUERY_BODY_BOOST})"
        ")"
    ]
    for index in range(2, term_count + 2):
        clauses.append(
            f"(title ||| ${index}::text::pdb.boost({TITLE_MATCH_BOOST}) OR body ||| ${index})"
        )
    return " OR ".join(clauses)


def _body_preview(body: str, *, query: str, max_chars: int = DEFAULT_PREVIEW_CHARS) -> str:
    """Build a compact preview centered on the first query-term hit when possible."""
    normalized = _normalize_text(body)
    if not normalized:
        return ""
    if len(normalized) <= max_chars:
        return normalized

    terms = _search_terms(query)
    start = 0
    lowered = normalized.lower()
    for term in terms:
        index = lowered.find(term.lower())
        if index >= 0:
            start = max(0, index - max_chars // 3)
            break

    end = min(len(normalized), start + max_chars)
    snippet = normalized[start:end].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(normalized):
        snippet = f"{snippet}..."
    return snippet


def _row_value(row: Any, key: str, default: Any = None) -> Any:
    """Read values from asyncpg rows while tolerating sparse test doubles."""
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def _document_summary(row: Any) -> dict[str, Any]:
    """Return the common metadata we expose for document records."""
    return {
        "document_id": str(_row_value(row, "document_id", "")),
        "source": str(_row_value(row, "source", "")),
        "source_type": str(_row_value(row, "source_type", "")),
        "source_document_id": str(_row_value(row, "source_document_id", "")),
        "source_chunk_id": str(_row_value(row, "source_chunk_id", "")),
        "parent_document_id": str(_row_value(row, "parent_document_id", "") or "") or None,
        "title": str(_row_value(row, "title", "")),
        "url": str(_row_value(row, "url", "")),
        "author_name": str(_row_value(row, "author_name", "")),
        "access_scope": str(_row_value(row, "access_scope", "")),
        "occurred_at": _isoformat(_row_value(row, "occurred_at")),
        "source_updated_at": _isoformat(_row_value(row, "source_updated_at")),
        "metadata": _as_dict(_row_value(row, "metadata", {})),
    }


async def latest_date(
    conn: Any,
    *,
    source: str | None,
    source_type: str | None,
) -> dict[str, Any]:
    """Return latest indexed date for company context documents using ``conn``."""
    row = await conn.fetchrow(
        """
        SELECT
            MAX(COALESCE(source_updated_at, occurred_at)) AS latest_date,
            MAX(source_updated_at) AS latest_source_updated_at,
            MAX(occurred_at) AS latest_occurred_at,
            COUNT(*)::bigint AS document_count
        FROM company_context_documents
        WHERE ($1::text IS NULL OR source = $1)
          AND ($2::text IS NULL OR source_type = $2)
        """,
        source,
        source_type,
    )
    if not row or int(row["document_count"] or 0) == 0:
        return {
            "status": "ok",
            "source": source,
            "source_type": source_type,
            "document_count": 0,
            "latest_date": None,
            "latest_source_updated_at": None,
            "latest_occurred_at": None,
        }
    return {
        "status": "ok",
        "source": source,
        "source_type": source_type,
        "document_count": int(row["document_count"] or 0),
        "latest_date": _isoformat(row["latest_date"]),
        "latest_source_updated_at": _isoformat(row["latest_source_updated_at"]),
        "latest_occurred_at": _isoformat(row["latest_occurred_at"]),
    }


async def search(
    conn: Any,
    *,
    query: str,
    limit: int,
    source: str | None,
    source_type: str | None,
) -> dict[str, Any]:
    """Run the indexed company-context search and return indexed-only results.

    The returned payload includes the indexed ``*_cutoff`` fields so the caller
    can merge live Slack results locally; this function performs no Slack call.
    """
    terms = _search_terms(query)
    search_terms = [query, *terms]
    source_param = len(search_terms) + 1
    source_type_param = len(search_terms) + 2
    limit_param = len(search_terms) + 3
    rows = await conn.fetch(
        f"""
        SELECT
            document_id,
            source,
            source_type,
            source_document_id,
            source_chunk_id,
            parent_document_id,
            title,
            url,
            author_name,
            access_scope,
            body,
            occurred_at,
            source_updated_at,
            metadata,
            paradedb.score(document_id) AS score
        FROM company_context_documents
        WHERE {_search_where_clause(len(terms))}
          AND (${source_param}::text IS NULL OR source = ${source_param})
          AND (${source_type_param}::text IS NULL OR source_type = ${source_type_param})
        ORDER BY
            paradedb.score(document_id)
            * CASE source_type
                WHEN 'slack_thread' THEN {THREAD_SCORE_MULTIPLIER}
                WHEN 'slack_channel_day' THEN {CHANNEL_DAY_SCORE_MULTIPLIER}
                ELSE 1.0
            END DESC,
            source_updated_at DESC NULLS LAST
        LIMIT ${limit_param}
        """,
        *search_terms,
        source,
        source_type,
        limit,
    )
    results = []
    for row in rows:
        result = _document_summary(row)
        result["score"] = float(_row_value(row, "score", 0.0) or 0.0)
        result["preview"] = _body_preview(
            str(_row_value(row, "body", "") or ""),
            query=query,
        )
        result["lane"] = "indexed"
        result["result_type"] = str(result["source_type"] or "indexed_document")
        results.append(result)

    # Compute the indexed cutoff for slack-ish searches so the caller can build
    # the live `after:` query. This is a DB read, not a Slack call.
    latest = None
    should_compute_cutoff = source == "slack" and (
        source_type is None or source_type.startswith("slack")
    )
    if should_compute_cutoff:
        latest = await latest_date(conn, source="slack", source_type=source_type)

    return {
        "status": "ok",
        "query": query,
        "source": source,
        "source_type": source_type,
        "count": len(results),
        "indexed_count": len(results),
        "live_count": 0,
        "indexed_cutoff": latest.get("latest_date") if latest else None,
        "latest_source_updated_at": (
            latest.get("latest_source_updated_at") if latest else None
        ),
        "latest_occurred_at": latest.get("latest_occurred_at") if latest else None,
        "live_error": None,
        "results": results,
    }


async def _related_documents(
    conn: Any,
    *,
    row: Any,
    max_children: int,
) -> dict[str, Any]:
    parent = None
    if row["parent_document_id"]:
        parent_row = await conn.fetchrow(
            """
            SELECT
                document_id,
                source,
                source_type,
                source_document_id,
                source_chunk_id,
                parent_document_id,
                title,
                url,
                author_name,
                access_scope,
                occurred_at,
                source_updated_at,
                metadata
            FROM company_context_documents
            WHERE document_id = $1
            """,
            row["parent_document_id"],
        )
        if parent_row:
            parent = _document_summary(parent_row)

    child_rows = await conn.fetch(
        """
        SELECT
            document_id,
            source,
            source_type,
            source_document_id,
            source_chunk_id,
            parent_document_id,
            title,
            url,
            author_name,
            access_scope,
            occurred_at,
            source_updated_at,
            metadata
        FROM company_context_documents
        WHERE parent_document_id = $1
        ORDER BY occurred_at ASC NULLS LAST, document_id ASC
        LIMIT $2
        """,
        row["document_id"],
        max_children,
    )
    children = [_document_summary(child_row) for child_row in child_rows]
    return {
        "parent": parent,
        "children": children,
        "child_count": len(children),
    }


async def read_document(
    conn: Any,
    *,
    document_id: str,
    max_chars: int | None,
    include_related: bool,
    max_related_children: int,
) -> dict[str, Any]:
    """Read a company context document by id using ``conn``."""
    row = await conn.fetchrow(
        """
        SELECT
            document_id,
            source,
            source_type,
            source_document_id,
            source_chunk_id,
            parent_document_id,
            title,
            body,
            url,
            author_name,
            access_scope,
            occurred_at,
            source_updated_at,
            metadata
        FROM company_context_documents
        WHERE document_id = $1
        """,
        document_id,
    )
    if not row:
        return {
            "status": "error",
            "error": f"document not found: {document_id}",
        }

    body = str(row["body"] or "")
    content = body if max_chars is None else body[:max_chars]
    truncated = max_chars is not None and len(body) > max_chars
    result = {
        "status": "ok",
        **_document_summary(row),
        "chars": len(content),
        "total_chars": len(body),
        "truncated": truncated,
        "content": content,
    }
    if include_related:
        result["related"] = await _related_documents(
            conn,
            row=row,
            max_children=max_related_children,
        )
    return result
