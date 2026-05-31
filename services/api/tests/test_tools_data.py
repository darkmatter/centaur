"""Tests for the brokered DB-tool data path (``api.tools_data`` + its router).

Two layers:

1. The SQL query functions in ``api.tools_data.{company_context,investmemos}``
   against a fake connection — covers the SQL shape, row-shaping, grouping, and
   ranking that used to live in the tool clients.
2. The router handlers called directly with a fake request — covers server-side
   re-clamping and empty-input handling. (Auth via ``verify_api_key`` /
   ``require_scope`` is exercised in ``test_check_scope`` and the deps tests.)
"""

from __future__ import annotations

import datetime as dt
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.routers import tools_data as router_mod
from api.tools_data import company_context as cc
from api.tools_data import investmemos as im
from api.tools_data import slack_capture


class _FakeConnection:
    """Stand-in for an asyncpg pool/connection: records calls, returns canned rows."""

    def __init__(self, *, rows=None, row=None, val=None) -> None:
        self._rows = rows if rows is not None else []
        self._row = row
        self._val = val
        self.fetch_calls: list[tuple] = []
        self.fetchrow_calls: list[tuple] = []
        self.fetchval_calls: list[tuple] = []

    async def fetch(self, query, *args):
        self.fetch_calls.append((query, args))
        return self._rows

    async def fetchrow(self, query, *args):
        self.fetchrow_calls.append((query, args))
        return self._row

    async def fetchval(self, query, *args):
        self.fetchval_calls.append((query, args))
        return self._val


class _FakeRequest:
    def __init__(self, body: dict, pool, *, sandbox_claims=None) -> None:
        self._body = body
        self.app = types.SimpleNamespace(state=types.SimpleNamespace(db_pool=pool))
        self.state = types.SimpleNamespace(sandbox_claims=sandbox_claims)

    async def json(self) -> dict:
        return self._body


# ── company_context query functions ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_cc_search_builds_bm25_and_shapes_rows():
    conn = _FakeConnection(
        rows=[
            {
                "document_id": "slack:thread:C123:1770000000.000000",
                "source": "slack",
                "source_type": "slack_thread",
                "title": "BM25 indexing plan",
                "url": "https://slack.example/thread",
                "occurred_at": dt.datetime(2026, 5, 8, 12, 0, tzinfo=dt.UTC),
                "source_updated_at": dt.datetime(2026, 5, 8, 12, 5, tzinfo=dt.UTC),
                "metadata": {"channel_name": "eng-ai"},
                "score": 1.25,
            }
        ],
        row={
            "latest_date": dt.datetime(2026, 5, 10, 15, 30, tzinfo=dt.UTC),
            "latest_source_updated_at": dt.datetime(2026, 5, 10, 15, 30, tzinfo=dt.UTC),
            "latest_occurred_at": dt.datetime(2026, 5, 10, 14, 0, tzinfo=dt.UTC),
            "document_count": 42,
        },
    )

    result = await cc.search(
        conn, query="ParadeDB BM25", limit=5, source="slack", source_type="slack_thread"
    )

    assert result["status"] == "ok"
    assert result["indexed_count"] == 1
    assert result["live_count"] == 0
    assert result["count"] == 1
    assert result["indexed_cutoff"] == "2026-05-10T15:30:00+00:00"
    row = result["results"][0]
    assert row["document_id"] == "slack:thread:C123:1770000000.000000"
    assert row["lane"] == "indexed"
    assert row["result_type"] == "slack_thread"
    sql, args = conn.fetch_calls[0]
    assert "title ||| $1::text::pdb.boost(8) OR body ||| $1::text::pdb.boost(2)" in sql
    assert "WHEN 'slack_thread' THEN 1.25" in sql
    assert "paradedb.score(document_id)" in sql
    assert args == ("ParadeDB BM25", "ParadeDB", "BM25", "slack", "slack_thread", 5)


@pytest.mark.asyncio
async def test_cc_search_skips_cutoff_for_non_slack():
    conn = _FakeConnection(rows=[])
    result = await cc.search(conn, query="state root", limit=3, source=None, source_type=None)
    assert result["indexed_cutoff"] is None
    # No latest-date lookup when not slack-scoped.
    assert conn.fetchrow_calls == []


@pytest.mark.asyncio
async def test_cc_latest_date_empty_index():
    conn = _FakeConnection(
        row={
            "latest_date": None,
            "latest_source_updated_at": None,
            "latest_occurred_at": None,
            "document_count": 0,
        }
    )
    result = await cc.latest_date(conn, source="slack", source_type=None)
    assert result["document_count"] == 0
    assert result["latest_date"] is None


@pytest.mark.asyncio
async def test_cc_read_document_full_and_bounded():
    body = "x" * 2500
    conn = _FakeConnection(
        row={
            "document_id": "doc-1",
            "source": "slack",
            "source_type": "slack_channel_day",
            "title": "t",
            "body": body,
            "url": "",
            "occurred_at": None,
            "source_updated_at": None,
            "metadata": '{"channel_name": "eng-ai"}',
        }
    )
    full = await cc.read_document(
        conn, document_id="doc-1", max_chars=None, include_related=False,
        max_related_children=25,
    )
    assert full["chars"] == 2500
    assert full["truncated"] is False
    assert full["metadata"] == {"channel_name": "eng-ai"}

    bounded = await cc.read_document(
        conn, document_id="doc-1", max_chars=1200, include_related=False,
        max_related_children=25,
    )
    assert bounded["chars"] == 1200
    assert bounded["truncated"] is True


@pytest.mark.asyncio
async def test_cc_read_document_missing():
    conn = _FakeConnection(row=None)
    result = await cc.read_document(
        conn, document_id="missing", max_chars=None, include_related=False,
        max_related_children=25,
    )
    assert result == {"status": "error", "error": "document not found: missing"}


# ── investmemos query functions ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_im_list_memos_shapes_rows():
    conn = _FakeConnection(
        rows=[
            {
                "external_id": "memo-1",
                "data": {"memo_name": "Acme", "stage_hint": "seed"},
                "fetched_at": dt.datetime(2026, 5, 1, tzinfo=dt.UTC),
            }
        ]
    )
    result = await im.list_memos(conn, query=None, limit=50, source="invest_memo_corpus")
    assert result["count"] == 1
    assert result["memos"][0]["memo_name"] == "Acme"
    assert result["memos"][0]["fetched_at"] == "2026-05-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_im_search_memos_groups_and_ranks():
    conn = _FakeConnection(
        rows=[
            {
                "source_id": "memo-1:0",
                "content": "alpha protocol design",
                "metadata": {"document_id": "memo-1", "memo_name": "Alpha"},
                "fts_or_score": 0.5,
                "fts_and_score": 0.2,
            },
            {
                "source_id": "memo-1:1",
                "content": "alpha protocol risks",
                "metadata": {"document_id": "memo-1", "memo_name": "Alpha"},
                "fts_or_score": 0.4,
                "fts_and_score": 0.1,
            },
        ]
    )
    result = await im.search_memos(
        conn, query="alpha protocol", limit=12, stage=None, company_type=None,
        source="invest_memo_corpus", kind="invest_memo_chunk",
    )
    assert result["count"] == 1
    doc = result["results"][0]
    assert doc["document_id"] == "memo-1"
    assert doc["matched_chunks"] == 2
    assert len(doc["excerpts"]) == 2


@pytest.mark.asyncio
async def test_im_read_memo_assembles_chunks():
    conn = _FakeConnection()

    calls = {"n": 0}

    async def fetchrow(query, *args):
        return {"external_id": "memo-1", "data": {"memo_name": "Alpha"}}

    async def fetch(query, *args):
        return [
            {"content": "part one ", "metadata": {}},
            {"content": "part two", "metadata": {}},
        ]

    conn.fetchrow = fetchrow  # type: ignore[assignment]
    conn.fetch = fetch  # type: ignore[assignment]

    result = await im.read_memo(
        conn, memo="Alpha", max_chars=12000, source="invest_memo_corpus",
        kind="invest_memo_chunk",
    )
    assert result["document_id"] == "memo-1"
    assert "part one" in result["content"]
    assert "part two" in result["content"]


# ── Router handlers: server-side re-clamping + empty inputs ──────────────────


@pytest.mark.asyncio
async def test_handler_cc_search_clamps_limit_and_rejects_empty():
    pool = _FakeConnection(rows=[])
    req = _FakeRequest(
        {"query": "x", "limit": 9999, "source": "slack", "source_type": "slack_thread"}, pool
    )
    pool._row = {
        "latest_date": None,
        "latest_source_updated_at": None,
        "latest_occurred_at": None,
        "document_count": 0,
    }
    await router_mod.company_context_search(req)
    _, args = pool.fetch_calls[0]
    assert args[-1] == cc.MAX_SEARCH_LIMIT  # clamped down from 9999

    empty = await router_mod.company_context_search(_FakeRequest({"query": "  "}, pool))
    assert empty == {"status": "error", "error": "query cannot be empty"}


@pytest.mark.asyncio
async def test_handler_cc_read_document_clamps_related_children():
    pool = _FakeConnection(
        row={
            "document_id": "doc-1",
            "source": "s",
            "source_type": "t",
            "title": "x",
            "body": "body",
            "url": "",
            "occurred_at": None,
            "source_updated_at": None,
            "metadata": {},
            "parent_document_id": None,
        }
    )
    req = _FakeRequest(
        {"document_id": "doc-1", "include_related": True, "max_related_children": 9999}, pool
    )
    await router_mod.company_context_read_document(req)
    # The related-children fetch is the LIMIT $2 arg on the children query.
    children_call = next(c for c in pool.fetch_calls if "parent_document_id = $1" in c[0])
    assert children_call[1][1] == cc.MAX_RELATED_CHILDREN


@pytest.mark.asyncio
async def test_handler_im_search_clamps_limit():
    pool = _FakeConnection(rows=[])
    req = _FakeRequest({"query": "alpha", "limit": 9999}, pool)
    await router_mod.investmemos_search_memos(req)
    # chunk_limit = clamped_limit * 12; clamped_limit caps at 50 → 600, then the
    # SQL re-clamps to 200. Assert the candidate LIMIT arg reflects that.
    _, args = pool.fetch_calls[0]
    assert args[-1] == 200


@pytest.mark.asyncio
async def test_handler_im_read_memo_clamps_max_chars_and_rejects_empty():
    empty = await router_mod.investmemos_read_memo(_FakeRequest({"memo": " "}, _FakeConnection()))
    assert empty == {"status": "error", "error": "memo cannot be empty"}


# ── slack live-send capture ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_capture_folds_send_into_live_reply(monkeypatch):
    sent: list[tuple[str, str]] = []

    async def fake_session_text(session_id, text):
        sent.append((session_id, text))

    monkeypatch.setattr(slack_capture.slackbot_client, "session_text", fake_session_text)
    pool = _FakeConnection(val="sess-123")

    result = await slack_capture.capture_live_slack_send(
        pool,
        thread_key="slack:T1:C9:1700000000.0001",
        channel="C9",
        thread_ts="1700000000.0001",
        text="progress update",
    )
    assert result["captured"] is True
    assert result["channel"] == "C9"
    assert sent == [("sess-123", "progress update")]


@pytest.mark.asyncio
async def test_capture_returns_none_for_other_channel():
    pool = _FakeConnection(val="sess-123")
    result = await slack_capture.capture_live_slack_send(
        pool,
        thread_key="slack:T1:C9:1700000000.0001",
        channel="C1234567",
        thread_ts="",
        text="hi",
    )
    assert result is None


@pytest.mark.asyncio
async def test_capture_returns_none_without_live_session():
    pool = _FakeConnection(val=None)
    result = await slack_capture.capture_live_slack_send(
        pool,
        thread_key="slack:T1:C9:1700000000.0001",
        channel="C9",
        thread_ts="",
        text="hi",
    )
    assert result is None


@pytest.mark.asyncio
async def test_handler_slack_capture_without_claims_returns_false():
    req = _FakeRequest({"channel": "C9", "text": "x"}, _FakeConnection(), sandbox_claims=None)
    assert await router_mod.slack_capture(req) == {"captured": False}


# ── tool-call metric ingest ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tool_call_metric_records(monkeypatch):
    recorded: list[tuple] = []
    monkeypatch.setattr(
        router_mod, "record_tool_call", lambda *a: recorded.append(a)
    )
    req = _FakeRequest(
        {"tool": "coingecko", "method": "price", "success": True, "duration_s": 0.42},
        _FakeConnection(),
    )
    assert await router_mod.tool_call_metric(req) == {"ok": True}
    assert recorded == [("coingecko", "price", True, 0.42)]


@pytest.mark.asyncio
async def test_tool_call_metric_drops_malformed(monkeypatch):
    recorded: list[tuple] = []
    monkeypatch.setattr(router_mod, "record_tool_call", lambda *a: recorded.append(a))
    req = _FakeRequest({"method": "price"}, _FakeConnection())  # no tool
    assert await router_mod.tool_call_metric(req) == {"ok": False}
    assert recorded == []
