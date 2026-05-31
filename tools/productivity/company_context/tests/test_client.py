from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

import client as company_context_client
from client import CompanyContextClient


class _FakeSlackClient:
    def __init__(self, messages=None) -> None:
        self.messages = messages or []
        self.calls = []

    def search_messages(self, query, max_results=20):
        self.calls.append((query, max_results))
        return self.messages


def _indexed_payload(**overrides):
    payload = {
        "status": "ok",
        "query": "q",
        "source": "slack",
        "source_type": None,
        "count": 1,
        "indexed_count": 1,
        "live_count": 0,
        "indexed_cutoff": "2026-05-10T15:30:00+00:00",
        "latest_source_updated_at": "2026-05-10T15:30:00+00:00",
        "latest_occurred_at": "2026-05-10T14:00:00+00:00",
        "live_error": None,
        "results": [{"document_id": "doc-1", "lane": "indexed"}],
    }
    payload.update(overrides)
    return payload


@pytest.mark.parametrize("query", ["", "   "])
def test_search_rejects_empty_query(query):
    assert CompanyContextClient().search(query) == {
        "status": "error",
        "error": "query cannot be empty",
    }


def test_search_posts_to_broker_and_merges_live_slack(monkeypatch):
    posted: list[tuple[str, dict]] = []

    def fake_post(path, payload):
        posted.append((path, payload))
        return _indexed_payload(source="slack")

    fake_slack = _FakeSlackClient(
        [
            {
                "channel": "eng-ai",
                "user": "alice",
                "text": "live hit",
                "timestamp": "1770000000.000000",
                "thread_ts": "1770000000.000000",
            }
        ]
    )
    monkeypatch.setattr(company_context_client, "_post_tools_data", fake_post)
    monkeypatch.setattr(company_context_client, "_load_slack_client", lambda: fake_slack)

    result = CompanyContextClient().search("state root", limit=7, source="slack")

    assert posted == [
        (
            "company-context/search",
            {"query": "state root", "limit": 7, "source": "slack", "source_type": None},
        )
    ]
    assert fake_slack.calls == [("state root after:2026-05-10", 7)]
    assert result["indexed_count"] == 1
    assert result["live_count"] == 1
    assert result["count"] == 2
    assert [r["lane"] for r in result["results"]] == ["indexed", "live"]


def test_search_clamps_limit_before_posting(monkeypatch):
    posted: list[dict] = []
    monkeypatch.setattr(
        company_context_client,
        "_post_tools_data",
        lambda path, payload: posted.append(payload) or _indexed_payload(source=None),
    )
    CompanyContextClient().search("q", limit=9999, source=None)
    assert posted[0]["limit"] == 50  # MAX_SEARCH_LIMIT


def test_search_non_slack_does_not_call_slack(monkeypatch):
    monkeypatch.setattr(
        company_context_client,
        "_post_tools_data",
        lambda path, payload: _indexed_payload(source=None, source_type=None),
    )

    def boom():
        raise AssertionError("slack must not be consulted for non-slack search")

    monkeypatch.setattr(company_context_client, "_load_slack_client", boom)

    result = CompanyContextClient().search("q", source="github")
    assert result["live_count"] == 0


def test_search_preserves_existing_after_modifier(monkeypatch):
    monkeypatch.setattr(
        company_context_client,
        "_post_tools_data",
        lambda path, payload: _indexed_payload(source="slack", results=[]),
    )
    fake_slack = _FakeSlackClient()
    monkeypatch.setattr(company_context_client, "_load_slack_client", lambda: fake_slack)

    CompanyContextClient().search("state root after:2026-05-11", source="slack")
    assert fake_slack.calls == [("state root after:2026-05-11", 10)]


def test_latest_date_posts(monkeypatch):
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        company_context_client,
        "_post_tools_data",
        lambda path, payload: posted.append((path, payload)) or {"status": "ok"},
    )
    CompanyContextClient().latest_date(source="slack", source_type="slack_thread")
    assert posted == [
        ("company-context/latest-date", {"source": "slack", "source_type": "slack_thread"})
    ]


def test_read_document_posts_clamped(monkeypatch):
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        company_context_client,
        "_post_tools_data",
        lambda path, payload: posted.append((path, payload)) or {"status": "ok"},
    )
    CompanyContextClient().read_document("  doc-1 ", max_related_children=9999)
    path, payload = posted[0]
    assert path == "company-context/read-document"
    assert payload["document_id"] == "doc-1"
    assert payload["max_related_children"] == 25  # MAX_RELATED_CHILDREN


def test_read_document_rejects_empty():
    assert CompanyContextClient().read_document("  ") == {
        "status": "error",
        "error": "document_id cannot be empty",
    }


def test_post_failure_becomes_error_envelope(monkeypatch):
    def boom(path, payload):
        raise RuntimeError("api unreachable")

    monkeypatch.setattr(company_context_client, "_post_tools_data", boom)
    result = CompanyContextClient().search("q", source="github")
    assert result == {"status": "error", "error": "api unreachable"}
