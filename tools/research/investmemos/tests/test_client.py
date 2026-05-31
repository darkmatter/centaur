from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

import client as investmemos_client
from client import InvestmemosClient


def test_list_memos_posts_with_default_source(monkeypatch):
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        investmemos_client,
        "_post_tools_data",
        lambda path, payload: posted.append((path, payload)) or {"status": "ok"},
    )
    monkeypatch.delenv("INVEST_MEMO_SOURCE", raising=False)
    InvestmemosClient().list_memos()
    assert posted == [
        ("investmemos/list-memos", {"query": None, "limit": 50, "source": "invest_memo_corpus"})
    ]


def test_search_memos_rejects_empty_query():
    assert InvestmemosClient().search_memos("  ") == {
        "status": "error",
        "error": "query cannot be empty",
    }


def test_search_memos_posts_payload(monkeypatch):
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        investmemos_client,
        "_post_tools_data",
        lambda path, payload: posted.append((path, payload)) or {"status": "ok", "results": []},
    )
    monkeypatch.delenv("INVEST_MEMO_SOURCE", raising=False)
    monkeypatch.delenv("INVEST_MEMO_KIND", raising=False)
    InvestmemosClient().search_memos("alpha", limit=5, stage="seed", company_type="defi")
    path, payload = posted[0]
    assert path == "investmemos/search-memos"
    assert payload == {
        "query": "alpha",
        "limit": 5,
        "stage": "seed",
        "company_type": "defi",
        "source": "invest_memo_corpus",
        "kind": "invest_memo_chunk",
    }


def test_read_memo_rejects_empty():
    assert InvestmemosClient().read_memo("  ") == {
        "status": "error",
        "error": "memo cannot be empty",
    }


def test_read_memo_posts_payload(monkeypatch):
    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        investmemos_client,
        "_post_tools_data",
        lambda path, payload: posted.append((path, payload)) or {"status": "ok"},
    )
    monkeypatch.delenv("INVEST_MEMO_SOURCE", raising=False)
    monkeypatch.delenv("INVEST_MEMO_KIND", raising=False)
    InvestmemosClient().read_memo(" Alpha ", max_chars=5000)
    _, payload = posted[0]
    assert payload["memo"] == "Alpha"
    assert payload["max_chars"] == 5000


def test_build_miq_context_orchestrates_search(monkeypatch):
    def fake_search(self, query, **kwargs):
        return {
            "status": "ok",
            "results": [
                {
                    "document_id": "memo-1",
                    "memo_name": "Alpha",
                    "score": 1.0,
                    "stage_hint": "seed",
                    "type_hint": "crypto_protocol",
                    "matched_chunks": 2,
                    "source_ids": ["memo-1:0"],
                    "excerpts": ["chunk a", "chunk b"],
                }
            ],
        }

    monkeypatch.setattr(InvestmemosClient, "search_memos", fake_search)
    result = InvestmemosClient().build_miq_context("Acme", ["What is the moat?"], excerpt_chars=10)
    assert result["status"] == "ok"
    assert result["opportunity"] == "Acme"
    match = result["miq_context"][0]["matches"][0]
    assert match["document_id"] == "memo-1"
    # excerpt_chars clamps to a 400 floor, so both chunks survive joined.
    assert "chunk a" in match["excerpt"]


def test_post_failure_becomes_error_envelope(monkeypatch):
    def boom(path, payload):
        raise RuntimeError("api unreachable")

    monkeypatch.setattr(investmemos_client, "_post_tools_data", boom)
    assert InvestmemosClient().list_memos() == {
        "status": "error",
        "error": "api unreachable",
    }
