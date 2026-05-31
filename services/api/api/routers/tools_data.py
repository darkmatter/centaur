"""Brokered DB-tool data router.

The two DB-backed tools (``company_context`` and ``investmemos``) run as local
CLIs in the sandbox, which has no route to the core DB. They reach their data
through these typed endpoints instead: the API is the legitimate holder of the
core DB, runs the SQL in ``api.tools_data`` on its connection pool, and returns
the same method dicts the tools expose.

This mirrors the existing ``/agent/attachments/upload`` broker. Auth is a
sandbox token (``tools:*`` scope) or a service key with the per-tool scope.
There is **no** ``thread_key`` scoping: this data is global and read-only.

All inputs are re-clamped server-side — the sandbox is a hostile boundary, so we
never trust client-supplied LIMIT / max_chars values.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from api.deps import get_sandbox_claims, require_scope, verify_api_key
from api.tools_data import company_context as company_context_query
from api.tools_data import investmemos as investmemos_query
from api.tools_data.slack_capture import capture_live_slack_send
from api.vm_metrics import record_tool_call

router = APIRouter(
    prefix="/agent/tools-data",
    tags=["tools-data"],
    dependencies=[Depends(verify_api_key)],
)


def _stripped(value: Any) -> str | None:
    """Normalize an optional string body field to a stripped value or None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# company_context
# ---------------------------------------------------------------------------


@router.post(
    "/company-context/search",
    dependencies=[Depends(require_scope("tools:company_context"))],
)
async def company_context_search(request: Request) -> dict:
    """Indexed company-context search (no live Slack; the client merges that)."""
    qmod = company_context_query
    body = await request.json()
    query_text = str(body.get("query") or "").strip()
    if not query_text:
        return {"status": "error", "error": "query cannot be empty"}
    limit = qmod.clamp(
        _to_int(body.get("limit"), qmod.DEFAULT_SEARCH_LIMIT),
        minimum=1,
        maximum=qmod.MAX_SEARCH_LIMIT,
    )
    return await qmod.search(
        request.app.state.db_pool,
        query=query_text,
        limit=limit,
        source=_stripped(body.get("source")),
        source_type=_stripped(body.get("source_type")),
    )


@router.post(
    "/company-context/latest-date",
    dependencies=[Depends(require_scope("tools:company_context"))],
)
async def company_context_latest_date(request: Request) -> dict:
    """Latest indexed timestamp for company-context documents."""
    qmod = company_context_query
    body = await request.json()
    return await qmod.latest_date(
        request.app.state.db_pool,
        source=_stripped(body.get("source")),
        source_type=_stripped(body.get("source_type")),
    )


@router.post(
    "/company-context/read-document",
    dependencies=[Depends(require_scope("tools:company_context"))],
)
async def company_context_read_document(request: Request) -> dict:
    """Read a company-context document by id."""
    qmod = company_context_query
    body = await request.json()
    document_id = str(body.get("document_id") or "").strip()
    if not document_id:
        return {"status": "error", "error": "document_id cannot be empty"}
    max_chars_in = _to_int(body.get("max_chars"), 0)
    max_chars = max_chars_in if max_chars_in > 0 else None
    max_related = qmod.clamp(
        _to_int(body.get("max_related_children"), qmod.MAX_RELATED_CHILDREN),
        minimum=1,
        maximum=qmod.MAX_RELATED_CHILDREN,
    )
    return await qmod.read_document(
        request.app.state.db_pool,
        document_id=document_id,
        max_chars=max_chars,
        include_related=bool(body.get("include_related")),
        max_related_children=max_related,
    )


# ---------------------------------------------------------------------------
# investmemos
# ---------------------------------------------------------------------------


@router.post(
    "/investmemos/list-memos",
    dependencies=[Depends(require_scope("tools:investmemos"))],
)
async def investmemos_list_memos(request: Request) -> dict:
    """List memo documents from the indexed corpus."""
    qmod = investmemos_query
    body = await request.json()
    limit = max(1, min(_to_int(body.get("limit"), 50), 200))
    source = _stripped(body.get("source")) or qmod.DEFAULT_MEMO_SOURCE
    return await qmod.list_memos(
        request.app.state.db_pool,
        query=_stripped(body.get("query")),
        limit=limit,
        source=source,
    )


@router.post(
    "/investmemos/search-memos",
    dependencies=[Depends(require_scope("tools:investmemos"))],
)
async def investmemos_search_memos(request: Request) -> dict:
    """Search indexed memo chunks and aggregate top documents (grouping server-side)."""
    qmod = investmemos_query
    body = await request.json()
    query_text = str(body.get("query") or "")
    if not query_text.strip():
        return {"status": "error", "error": "query cannot be empty"}
    limit = max(1, min(_to_int(body.get("limit"), 12), 50))
    source = _stripped(body.get("source")) or qmod.DEFAULT_MEMO_SOURCE
    kind = _stripped(body.get("kind")) or qmod.DEFAULT_MEMO_KIND
    return await qmod.search_memos(
        request.app.state.db_pool,
        query=query_text,
        limit=limit,
        stage=body.get("stage"),
        company_type=body.get("company_type"),
        source=source,
        kind=kind,
    )


@router.post(
    "/investmemos/read-memo",
    dependencies=[Depends(require_scope("tools:investmemos"))],
)
async def investmemos_read_memo(request: Request) -> dict:
    """Read memo content by document ID or memo name."""
    qmod = investmemos_query
    body = await request.json()
    memo = str(body.get("memo") or "").strip()
    if not memo:
        return {"status": "error", "error": "memo cannot be empty"}
    max_chars = max(1000, min(_to_int(body.get("max_chars"), 12000), 120000))
    source = _stripped(body.get("source")) or qmod.DEFAULT_MEMO_SOURCE
    kind = _stripped(body.get("kind")) or qmod.DEFAULT_MEMO_KIND
    return await qmod.read_memo(
        request.app.state.db_pool,
        memo=memo,
        max_chars=max_chars,
        source=source,
        kind=kind,
    )


# ---------------------------------------------------------------------------
# slack — live-send capture
# ---------------------------------------------------------------------------


@router.post(
    "/slack/capture",
    dependencies=[Depends(require_scope("tools:slack"))],
)
async def slack_capture(request: Request) -> dict:
    """Fold a sandbox agent's Slack send into its active Slackbot live reply.

    The agent's ``thread_key`` comes from its sandbox token, not the body — only
    the calling agent's own live thread can capture. Returns ``{"captured": ...}``;
    on ``captured: false`` the local slack tool posts to Slack normally.
    """
    claims = get_sandbox_claims(request)
    thread_key = str((claims or {}).get("thread_key") or "")
    body = await request.json()
    result = await capture_live_slack_send(
        request.app.state.db_pool,
        thread_key=thread_key,
        channel=str(body.get("channel") or ""),
        thread_ts=str(body.get("thread_ts") or ""),
        text=str(body.get("text") or ""),
    )
    return result or {"captured": False}


# ---------------------------------------------------------------------------
# observability — per-call metric ingest for local tool calls
# ---------------------------------------------------------------------------


@router.post(
    "/tool-call-metric",
    dependencies=[Depends(require_scope("agent"))],
)
async def tool_call_metric(request: Request) -> dict:
    """Record a tool call's Prometheus metrics on behalf of the local runner.

    After the tool-CLI cutover, tools run as local CLIs in the sandbox and no
    longer pass through the API's in-process ``record_tool_call``. The runner
    POSTs ``{tool, method, success, duration_s}`` here so the same VictoriaMetrics
    series stay populated. Best-effort: malformed input is dropped, not 4xx'd.
    """
    body = await request.json()
    tool = _stripped(body.get("tool"))
    method = _stripped(body.get("method"))
    if not tool or not method:
        return {"ok": False}
    try:
        duration_s = max(0.0, float(body.get("duration_s") or 0.0))
    except (TypeError, ValueError):
        duration_s = 0.0
    record_tool_call(tool, method, bool(body.get("success")), duration_s)
    return {"ok": True}
