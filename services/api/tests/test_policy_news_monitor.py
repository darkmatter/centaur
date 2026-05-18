from __future__ import annotations

import datetime as dt
import json
import uuid

import pytest
import pytest_asyncio

import api.policy_news as policy_news
from api.policy_news import (
    ClassificationResult,
    DEFAULT_POLICY_NEWS_FEEDS_FILE,
    QueryRequest,
    build_alert_message,
    load_monitor_config,
    normalize_title,
    parse_feedback_command,
    parse_query_request,
    run_policy_news_monitor,
    search_archive,
    title_similarity,
)


@pytest_asyncio.fixture
async def policy_news_tables(db_pool):
    await db_pool.execute(
        "TRUNCATE TABLE policy_news_monitor_runs, policy_news_feedback, policy_news_alerts, policy_news_cluster_articles, "
        "policy_news_articles, policy_news_clusters, policy_news_feed_fetches, "
        "policy_news_watch_terms, policy_news_sources CASCADE"
    )
    yield


class StubWorkflowContext:
    def __init__(self, pool, *, post_error: str | None = None):
        self._pool = pool
        self._post_error = post_error

    async def post_to_slack(self, channel: str, text: str, *, thread_ts: str | None = None):
        if self._post_error:
            raise RuntimeError(self._post_error)
        return {"channel": channel, "ts": thread_ts or "1776.0001"}


def test_parse_feedback_command_supports_plain_and_annotated_commands():
    assert parse_feedback_command("good catch") == parse_feedback_command("good catch")
    detailed = parse_feedback_command("wrong topic: AI")
    assert detailed is not None
    assert detailed.command == "wrong topic"
    assert detailed.note == "ai"


def test_parse_query_request_extracts_topic_source_and_date_window():
    now = dt.datetime(2026, 4, 15, 12, 0, tzinfo=dt.timezone.utc)
    query = parse_query_request(
        "search crypto SEC last 30d Reuters",
        now=now,
        source_names=["Reuters", "Politico"],
    )
    assert query is not None
    assert query.topic == "Crypto"
    assert query.source_names == ["Reuters"]
    assert query.since == now - dt.timedelta(days=30)
    assert query.search_text == "sec"


def test_title_similarity_clusters_obvious_near_duplicates():
    left = normalize_title(
        "Chairman Scott announces digital asset market structure markup"
    )
    right = normalize_title(
        "Scott announces digital asset market structure markup in Senate Banking"
    )
    assert title_similarity(left, right) >= 0.70


def test_load_monitor_config_ignores_scheduler_metadata_and_uses_default_file(
    tmp_path, monkeypatch
):
    config_path = tmp_path / "policy_news_sources.json"
    config_path.write_text(
        json.dumps(
            {
                "slack_channel": "C0ASR4NFLPR",
                "sources": [
                    {
                        "name": "Reuters",
                        "url": "https://www.reutersagency.com/feed/",
                    }
                ],
            }
        )
    )
    monkeypatch.setenv("POLICY_NEWS_FEEDS_FILE", str(config_path))

    config = load_monitor_config(
        {
            "metadata": {"source": "workflow_schedule"},
            "unexpected": "ignored",
        }
    )

    assert config.slack_channel == "C0ASR4NFLPR"
    assert config.sources[0].name == "Reuters"


def test_load_monitor_config_falls_back_to_checked_in_default_file(monkeypatch):
    monkeypatch.delenv("POLICY_NEWS_FEEDS_FILE", raising=False)

    assert DEFAULT_POLICY_NEWS_FEEDS_FILE == "/app/workflows/policy_news_sources.json"


@pytest.mark.asyncio
async def test_search_archive_filters_to_sent_alerts(db_pool, policy_news_tables):
    cluster_id = f"clu_{uuid.uuid4().hex[:12]}"
    article_key = uuid.uuid4().hex[:24]
    now = dt.datetime(2026, 4, 15, 12, 0, tzinfo=dt.timezone.utc)
    await db_pool.execute(
        "INSERT INTO policy_news_sources (source_key, name, feed_url) VALUES "
        "('reuters', 'Reuters', 'https://example.com/rss')"
    )
    await db_pool.execute(
        "INSERT INTO policy_news_clusters ("
        "cluster_id, canonical_title, title_normalized, title_tokens, canonical_url, primary_topic, "
        "secondary_tags, score_total, score_breakdown, delivery_class, reason_for_inclusion, "
        "what_happened, why_it_matters, first_seen_at"
        ") VALUES ($1, $2, $3, $4::jsonb, $5, 'Crypto', '[\"Congress\"]'::jsonb, 90, '{}'::jsonb, "
        "'Urgent', 'committee activity', $6, $7, $8)",
        cluster_id,
        "Chairman Scott announces digital asset market structure markup",
        normalize_title(
            "Chairman Scott announces digital asset market structure markup"
        ),
        '["chairman","scott","announces","digital","asset","market","structure","markup"]',
        "https://www.banking.senate.gov/newsroom/majority/chairman-scott-announces-digital-asset-market-structure-markup",
        "Senate Banking is moving market structure into formal committee process.",
        "This is a concrete process signal worth seeing immediately.",
        now,
    )
    await db_pool.execute(
        "INSERT INTO policy_news_articles ("
        "article_key, source_key, external_id, title, title_normalized, canonical_url, raw_url"
        ") VALUES ($1, 'reuters', 'ext-1', $2, $3, 'https://example.com/story', 'https://example.com/story')",
        article_key,
        "Chairman Scott announces digital asset market structure markup",
        normalize_title(
            "Chairman Scott announces digital asset market structure markup"
        ),
    )
    await db_pool.execute(
        "INSERT INTO policy_news_cluster_articles (cluster_id, article_key, is_primary) VALUES ($1, $2, TRUE)",
        cluster_id,
        article_key,
    )
    await db_pool.execute(
        "INSERT INTO policy_news_alerts ("
        "alert_id, cluster_id, slack_channel_id, slack_thread_ts, delivery_class, message_text, score_total"
        ") VALUES ('alt_1', $1, 'C123', '1776.0001', 'Urgent', 'posted', 90)",
        cluster_id,
    )

    result = await search_archive(
        db_pool,
        QueryRequest(
            raw_text="what did we send on crypto this month",
            sent_only=True,
            topic="Crypto",
            since=now.replace(day=1, hour=0, minute=0, second=0, microsecond=0),
        ),
        limit=5,
    )

    assert "Found 1 sent alerts" in result
    assert "Chairman Scott announces digital asset market structure markup" in result
    assert "[Crypto][Congress][Urgent]" in result


@pytest.mark.asyncio
async def test_build_alert_message_includes_reason_and_corroboration(
    db_pool, policy_news_tables
):
    cluster_id = f"clu_{uuid.uuid4().hex[:12]}"
    article_a = uuid.uuid4().hex[:24]
    article_b = uuid.uuid4().hex[:24]
    await db_pool.execute(
        "INSERT INTO policy_news_sources (source_key, name, feed_url, trust_tier) VALUES "
        "('reuters', 'Reuters', 'https://example.com/rss', 5), "
        "('politico', 'Politico', 'https://example.com/rss', 5)"
    )
    await db_pool.execute(
        "INSERT INTO policy_news_clusters ("
        "cluster_id, canonical_title, title_normalized, title_tokens, canonical_url, primary_topic, "
        "secondary_tags, score_total, score_breakdown, delivery_class, reason_for_inclusion, "
        "what_happened, why_it_matters"
        ") VALUES ($1, 'Test title', 'test title', '[\"test\",\"title\"]'::jsonb, 'https://example.com/story', "
        "'AI', '[\"Congress\"]'::jsonb, 70, '{}'::jsonb, 'Standard', 'committee activity', "
        "'What happened', 'Why it matters')",
        cluster_id,
    )
    await db_pool.execute(
        "INSERT INTO policy_news_articles (article_key, source_key, external_id, title, title_normalized) VALUES "
        "($1, 'reuters', 'a', 'A', 'a'), ($2, 'politico', 'b', 'B', 'b')",
        article_a,
        article_b,
    )
    await db_pool.execute(
        "INSERT INTO policy_news_cluster_articles (cluster_id, article_key, is_primary) VALUES "
        "($1, $2, TRUE), ($1, $3, FALSE)",
        cluster_id,
        article_a,
        article_b,
    )

    text = await build_alert_message(
        db_pool,
        {
            "cluster_id": cluster_id,
            "primary_topic": "AI",
            "secondary_tags": ["Congress"],
            "delivery_class": "Standard",
            "canonical_title": "Test title",
            "what_happened": "What happened",
            "why_it_matters": "Why it matters",
            "reason_for_inclusion": "committee activity",
            "canonical_url": "https://example.com/story",
        },
    )

    assert text.startswith("[AI][Congress][Standard]")
    assert "Reason for inclusion: committee activity" in text
    assert "Corroborating coverage: Politico" in text


@pytest.mark.asyncio
async def test_run_policy_news_monitor_records_failed_slack_post_attempt(
    db_pool, policy_news_tables, monkeypatch
):
    async def fake_fetch_feed(source, *, limit):
        return [
            {
                "external_id": "story-1",
                "title": "SEC advances digital asset market structure proposal",
                "canonical_url": "https://example.com/story",
                "raw_url": "https://example.com/story",
                "excerpt": "A policy-heavy article.",
                "content_text": "A policy-heavy article with meaningful congressional movement.",
                "author": "Reporter",
                "published_at": dt.datetime(2026, 4, 15, 12, 0, tzinfo=dt.timezone.utc),
                "categories": ["Crypto"],
                "excerpt_only": False,
                "raw_payload": {"title": "SEC advances digital asset market structure proposal"},
            }
        ]

    async def fake_classify_candidates(config, articles):
        return {
            articles[0].article_key: ClassificationResult(
                article_key=articles[0].article_key,
                primary_topic="Crypto",
                secondary_tags=["Congress"],
                include=True,
                reason_for_inclusion="committee activity",
                what_happened="Congress is moving a market structure item.",
                why_it_matters="This is the kind of update the monitor should deliver.",
                suggested_delivery="Standard",
                scores={
                    "policy_centrality": 20,
                    "actor_importance": 12,
                    "actionability": 8,
                    "source_quality": 5,
                    "novelty": 4,
                    "narrative_influence": 1,
                },
            )
        }

    monkeypatch.setattr(policy_news, "fetch_feed", fake_fetch_feed)
    monkeypatch.setattr(policy_news, "classify_candidates", fake_classify_candidates)

    ctx = StubWorkflowContext(db_pool, post_error="channel_not_found")
    with pytest.raises(RuntimeError, match="channel_not_found"):
        await run_policy_news_monitor(
            ctx,
            {
                "slack_channel": "C0ASR4NFLPR",
                "sources": [
                    {
                        "name": "Reuters",
                        "url": "https://example.com/rss",
                    }
                ],
                "process_replies": False,
            },
        )

    row = await db_pool.fetchrow(
        "SELECT status, enabled_source_count, new_articles, classified_candidates, alertable_clusters, "
        "alerts_sent, last_post_attempt, error_text "
        "FROM policy_news_monitor_runs ORDER BY started_at DESC LIMIT 1"
    )

    assert row is not None
    assert row["status"] == "error"
    assert row["enabled_source_count"] == 1
    assert row["new_articles"] == 1
    assert row["classified_candidates"] == 1
    assert row["alertable_clusters"] == 1
    assert row["alerts_sent"] == 0
    assert row["last_post_attempt"]["status"] == "error"
    assert row["last_post_attempt"]["channel"] == "C0ASR4NFLPR"
    assert "channel_not_found" in row["last_post_attempt"]["error_text"]
    assert row["error_text"] == "channel_not_found"


@pytest.mark.asyncio
async def test_run_policy_news_monitor_diagnostics_only_summarizes_latest_run(
    db_pool, policy_news_tables
):
    await db_pool.execute(
        "INSERT INTO policy_news_sources (source_key, name, feed_url) VALUES "
        "('reuters', 'Reuters', 'https://example.com/reuters'), "
        "('politico', 'Politico', 'https://example.com/politico')"
    )
    await db_pool.execute(
        "INSERT INTO policy_news_feed_fetches (source_key, status, item_count, error_text, fetched_at) VALUES "
        "('reuters', 'error', 0, 'timeout contacting feed', $1)",
        dt.datetime(2026, 4, 15, 13, 0, tzinfo=dt.timezone.utc),
    )
    await db_pool.execute(
        "INSERT INTO policy_news_monitor_runs ("
        "started_at, completed_at, status, slack_channel_id, enabled_source_count, fetch_successes, "
        "fetch_failures, new_articles, classified_candidates, alertable_clusters, alerts_sent, "
        "last_post_attempt, error_text"
        ") VALUES ($1, $2, 'error', 'C0ASR4NFLPR', 2, 1, 1, 4, 3, 2, 0, $3::jsonb, 'channel_not_found')",
        dt.datetime(2026, 4, 15, 12, 0, tzinfo=dt.timezone.utc),
        dt.datetime(2026, 4, 15, 12, 5, tzinfo=dt.timezone.utc),
        json.dumps(
            {
                "status": "error",
                "attempted_at": "2026-04-15T12:04:00+00:00",
                "channel": "C0ASR4NFLPR",
                "error_text": "channel_not_found",
            }
        ),
    )

    result = await run_policy_news_monitor(
        StubWorkflowContext(db_pool),
        {
            "diagnostics_only": True,
            "slack_channel": "C0ASR4NFLPR",
            "sources": [
                {"name": "Reuters", "url": "https://example.com/reuters"},
                {"name": "Politico", "url": "https://example.com/politico"},
            ],
        },
    )

    assert result["status"] == "diagnostics"
    assert result["configured_slack_channel"] == "C0ASR4NFLPR"
    assert result["enabled_source_count"] == 2
    assert result["new_articles"] == 4
    assert result["classified_candidates"] == 3
    assert result["alertable_clusters"] == 2
    assert result["last_post_attempt"]["status"] == "error"
    assert result["last_fetch_failures"][0]["source_name"] == "Reuters"
    assert "channel_not_found" in result["summary"]
    assert "Enabled sources: 2" in result["summary"]
