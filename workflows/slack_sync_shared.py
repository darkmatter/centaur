"""Shared helpers for Slack ETL incremental sync and backfill workflows."""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
from pathlib import Path
from typing import Any, Protocol

from api.runtime_control import canonical_json

FALSE_ENV_VALUES = {"0", "false", "no", "off"}
BACKFILL_JOB_CHANNEL_CONTINUATION = "channel_continuation"
BACKFILL_JOB_CHANNEL_BOOTSTRAP = "channel_bootstrap"
BACKFILL_JOB_THREAD_REFRESH = "thread_refresh"
BACKFILL_JOB_PAYLOAD_VERSION = 1


def positive_int(value: int | str | None, default: int) -> int:
    """Coerce positive integer config values with a safe default."""
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def env_flag_enabled(name: str, default: bool = True) -> bool:
    """Read a boolean feature flag where common false strings opt out."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in FALSE_ENV_VALUES


class SlackSyncClient(Protocol):
    """Small protocol for the Slack client methods used by Slack ETL workflows."""

    def _etl_access_mode(self) -> str: ...

    def _list_etl_channels(
        self, limit: int = 200, force_refresh: bool = False
    ) -> list[dict]: ...

    def _list_etl_users(self, limit: int = 200) -> list[dict]: ...

    def _sync_etl_channel_history(
        self,
        channel: str,
        state: dict[str, Any] | None = None,
        limit: int = 200,
        lookback_days: int = 30,
        oldest: str | int | float | None = None,
        latest: str | int | float | None = None,
    ) -> dict[str, Any]: ...

    def _get_etl_thread_replies_page(
        self,
        channel: str,
        thread_ts: str,
        limit: int = 200,
        cursor: str | None = None,
        oldest: str | int | float | None = None,
        latest: str | int | float | None = None,
        inclusive: bool = True,
    ) -> dict[str, Any]: ...


def slack_ts_to_datetime(ts: str | None) -> dt.datetime | None:
    """Convert Slack timestamp strings to UTC datetimes for indexed queries."""
    if not ts:
        return None
    try:
        return dt.datetime.fromtimestamp(float(ts), tz=dt.timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def message_thread_ts(message: dict[str, Any]) -> str | None:
    """Return the thread root timestamp for a normalized Slack message."""
    thread_ts = message.get("thread_ts")
    if isinstance(thread_ts, str) and thread_ts.strip():
        return thread_ts.strip()
    message_ts = message.get("timestamp")
    reply_count = message.get("reply_count")
    if isinstance(message_ts, str) and isinstance(reply_count, int) and reply_count > 0:
        return message_ts
    return None


def message_row(
    message: dict[str, Any],
    run_id: str,
    parent_message_ts: str | None = None,
) -> dict[str, Any]:
    """Project a normalized Slack message into the DB upsert shape."""
    message_ts = str(message.get("timestamp") or "")
    thread_ts = message_thread_ts(message)
    user_id = str(message.get("user_id") or "")
    bot_id = str(message.get("bot_id") or "")
    return {
        "channel_id": str(message.get("channel_id") or ""),
        "message_ts": message_ts,
        "occurred_at": slack_ts_to_datetime(message_ts),
        "thread_ts": thread_ts,
        "parent_message_ts": parent_message_ts,
        "is_thread_root": bool(thread_ts and thread_ts == message_ts),
        "user_id": user_id,
        "bot_id": bot_id,
        "message_type": str(message.get("type") or "message"),
        "message_subtype": message.get("subtype"),
        "text": str(message.get("text") or ""),
        "permalink": str(message.get("permalink") or ""),
        "reply_count": int(message.get("reply_count") or 0),
        "reply_users": message.get("reply_users") or [],
        "latest_reply_ts": message.get("latest_reply"),
        "raw_payload": message,
        "source_run_id": run_id,
    }


def channel_ref(channel: dict[str, Any], reason: str | None = None) -> dict[str, str]:
    """Return a compact channel reference for run summaries."""
    result = {
        "channel_id": str(channel.get("id") or ""),
        "channel_name": str(channel.get("name") or ""),
    }
    if reason:
        result["reason"] = reason
    return result


def failure_reason(error: str) -> str:
    """Map Slack/client errors to low-cardinality metric reasons."""
    lowered = error.lower()
    if "rate_limited" in lowered or "ratelimited" in lowered:
        return "rate_limited"
    if (
        "missing_scope" in lowered
        or "not_in_channel" in lowered
        or "permission" in lowered
    ):
        return "permission_error"
    if "repeated reply cursor" in lowered or "cursor" in lowered:
        return "cursor_error"
    if "slack api" in lowered or "slack_sdk" in lowered:
        return "api_error"
    if "write" in lowered or "database" in lowered or "postgres" in lowered:
        return "write_error"
    return "unknown_error"


async def upsert_messages(pool, rows: list[dict[str, Any]]) -> int:
    """Upsert Slack messages and replies by their channel-scoped Slack ts."""
    if not rows:
        return 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for row in rows:
                await conn.execute(
                    "INSERT INTO slack_sync_messages ("
                    "channel_id, message_ts, occurred_at, thread_ts, parent_message_ts, "
                    "is_thread_root, user_id, bot_id, message_type, message_subtype, text, "
                    "permalink, reply_count, reply_users, latest_reply_ts, raw_payload, "
                    "source_run_id, last_seen_at, updated_at"
                    ") VALUES ("
                    "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, "
                    "$14::jsonb, $15, $16::jsonb, $17, NOW(), NOW()"
                    ") ON CONFLICT (channel_id, message_ts) DO UPDATE SET "
                    "occurred_at = EXCLUDED.occurred_at, "
                    "thread_ts = EXCLUDED.thread_ts, "
                    "parent_message_ts = EXCLUDED.parent_message_ts, "
                    "is_thread_root = EXCLUDED.is_thread_root, "
                    "user_id = EXCLUDED.user_id, "
                    "bot_id = EXCLUDED.bot_id, "
                    "message_type = EXCLUDED.message_type, "
                    "message_subtype = EXCLUDED.message_subtype, "
                    "text = EXCLUDED.text, "
                    "permalink = EXCLUDED.permalink, "
                    "reply_count = EXCLUDED.reply_count, "
                    "reply_users = EXCLUDED.reply_users, "
                    "latest_reply_ts = EXCLUDED.latest_reply_ts, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "source_run_id = EXCLUDED.source_run_id, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    row["channel_id"],
                    row["message_ts"],
                    row["occurred_at"],
                    row["thread_ts"],
                    row["parent_message_ts"],
                    row["is_thread_root"],
                    row["user_id"],
                    row["bot_id"],
                    row["message_type"],
                    row["message_subtype"],
                    row["text"],
                    row["permalink"],
                    row["reply_count"],
                    canonical_json(row["reply_users"]),
                    row["latest_reply_ts"],
                    canonical_json(row["raw_payload"]),
                    row["source_run_id"],
                )
    return len(rows)


async def load_thread_refresh_times(
    pool,
    *,
    channel_id: str,
    thread_ts_values: list[str],
) -> dict[str, dt.datetime | None]:
    """Load last refresh timestamps for root messages keyed by thread ts."""
    if not thread_ts_values:
        return {}
    rows = await pool.fetch(
        "SELECT message_ts, thread_refreshed_at "
        "FROM slack_sync_messages "
        "WHERE channel_id = $1 "
        "  AND is_thread_root = TRUE "
        "  AND message_ts = ANY($2::text[])",
        channel_id,
        thread_ts_values,
    )
    return {
        str(row["message_ts"]): (
            row["thread_refreshed_at"].astimezone(dt.timezone.utc)
            if isinstance(row["thread_refreshed_at"], dt.datetime)
            else None
        )
        for row in rows
    }


async def replace_thread_replies(
    pool,
    *,
    channel_id: str,
    thread_ts: str,
    reply_rows: list[dict[str, Any]],
) -> tuple[int, int]:
    """Replace the stored reply set for one thread with the fetched authoritative set."""
    upserted = await upsert_messages(pool, reply_rows)
    reply_ts_values = [
        str(row["message_ts"]) for row in reply_rows if row.get("message_ts")
    ]
    async with pool.acquire() as conn:
        async with conn.transaction():
            if reply_ts_values:
                deleted = await conn.fetchval(
                    "WITH deleted AS ("
                    "    DELETE FROM slack_sync_messages "
                    "    WHERE channel_id = $1 "
                    "      AND parent_message_ts = $2 "
                    "      AND NOT (message_ts = ANY($3::text[])) "
                    "    RETURNING 1"
                    ") "
                    "SELECT COUNT(*) FROM deleted",
                    channel_id,
                    thread_ts,
                    reply_ts_values,
                )
            else:
                deleted = await conn.fetchval(
                    "WITH deleted AS ("
                    "    DELETE FROM slack_sync_messages "
                    "    WHERE channel_id = $1 "
                    "      AND parent_message_ts = $2 "
                    "    RETURNING 1"
                    ") "
                    "SELECT COUNT(*) FROM deleted",
                    channel_id,
                    thread_ts,
                )
    return upserted, int(deleted or 0)


async def mark_thread_refreshed(
    pool,
    *,
    channel_id: str,
    thread_ts: str,
) -> None:
    """Mark the root row for one thread as freshly reconciled."""
    await pool.execute(
        "UPDATE slack_sync_messages SET "
        "thread_refreshed_at = NOW(), updated_at = NOW(), last_seen_at = NOW() "
        "WHERE channel_id = $1 "
        "  AND message_ts = $2 "
        "  AND is_thread_root = TRUE",
        channel_id,
        thread_ts,
    )


async def record_run_start(
    pool,
    *,
    run_id: str,
    workflow_run_id: str,
    mode: str,
    requested: list[dict[str, str]],
    skipped: list[dict[str, str]],
    metadata: dict[str, Any],
) -> None:
    """Insert or reset the ETL run row."""
    await pool.execute(
        "INSERT INTO slack_sync_runs ("
        "run_id, workflow_run_id, mode, status, channels_requested, channels_skipped, metadata"
        ") VALUES ($1, $2, $3, 'running', $4::jsonb, $5::jsonb, $6::jsonb) "
        "ON CONFLICT (run_id) DO UPDATE SET "
        "workflow_run_id = EXCLUDED.workflow_run_id, "
        "mode = EXCLUDED.mode, "
        "status = 'running', "
        "channels_requested = EXCLUDED.channels_requested, "
        "channels_synced = '[]'::jsonb, "
        "channels_skipped = EXCLUDED.channels_skipped, "
        "channels_failed = '[]'::jsonb, "
        "messages_fetched = 0, "
        "messages_upserted = 0, "
        "threads_fetched = 0, "
        "replies_fetched = 0, "
        "replies_upserted = 0, "
        "finished_at = NULL, "
        "error_text = '', "
        "metadata = EXCLUDED.metadata",
        run_id,
        workflow_run_id,
        mode,
        canonical_json(requested),
        canonical_json(skipped),
        canonical_json(metadata),
    )


async def record_run_finish(
    pool,
    *,
    run_id: str,
    status: str,
    synced: list[dict[str, str]],
    skipped: list[dict[str, str]],
    failed: list[dict[str, str]],
    counts: dict[str, int],
    error_text: str = "",
) -> None:
    """Finalize a sync run with channel outcomes and row counts."""
    await pool.execute(
        "UPDATE slack_sync_runs SET "
        "status = $2, channels_synced = $3::jsonb, channels_skipped = $4::jsonb, "
        "channels_failed = $5::jsonb, messages_fetched = $6, messages_upserted = $7, "
        "threads_fetched = $8, replies_fetched = $9, replies_upserted = $10, "
        "finished_at = NOW(), error_text = $11 "
        "WHERE run_id = $1",
        run_id,
        status,
        canonical_json(synced),
        canonical_json(skipped),
        canonical_json(failed),
        counts.get("messages_fetched", 0),
        counts.get("messages_upserted", 0),
        counts.get("threads_fetched", 0),
        counts.get("replies_fetched", 0),
        counts.get("replies_upserted", 0),
        error_text,
    )


def workflow_run_id_to_sync_run_id(workflow_run_id: str) -> str:
    """Derive a stable sync run id from the durable workflow run id."""
    safe_run_id = "".join(char if char.isalnum() else "_" for char in workflow_run_id)
    return f"slack_sync_{safe_run_id}"


def repo_slack_client_paths() -> list[Path]:
    """Return Slack tool client paths for installed and legacy repo layouts."""
    repo_root = Path(__file__).resolve().parents[1]
    return [
        repo_root / "tools" / "productivity" / "slack" / "client.py",
        repo_root / "tools" / "slack" / "client.py",
    ]


def slack_client_class_from_path(client_path: Path) -> type:
    """Load SlackClient from a repo checkout path when package import is unavailable."""
    spec = importlib.util.spec_from_file_location(
        "_slack_sync_tool_client", client_path
    )
    if not spec or not spec.loader:
        raise ImportError(f"Could not load Slack client module from {client_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SlackClient


def slack_client_class() -> type:
    """Resolve the SlackClient class from package imports or repo checkout paths."""
    try:
        from slack.client import SlackClient

        return SlackClient
    except ModuleNotFoundError:
        for client_path in repo_slack_client_paths():
            if client_path.exists():
                return slack_client_class_from_path(client_path)
        candidates = ", ".join(str(path) for path in repo_slack_client_paths())
        raise FileNotFoundError(
            f"Could not find Slack client module. Tried: {candidates}"
        )


def client() -> SlackSyncClient:
    """Construct the Slack tool client from either import path or repo layout."""
    return slack_client_class()()


async def enqueue_backfill_job(
    pool,
    *,
    job_key: str,
    job_type: str,
    channel_id: str,
    payload: dict[str, Any],
    run_id: str,
    priority: int = 100,
    refresh_completed: bool = True,
) -> None:
    """Store or refresh a queued backfill job outside the incremental checkpoint."""
    if not payload:
        return
    completion_guard = (
        ""
        if refresh_completed
        else " WHERE slack_sync_backfill_jobs.status <> 'completed'"
    )
    await pool.execute(
        "INSERT INTO slack_sync_backfill_jobs ("
        "job_key, job_type, payload_version, channel_id, status, payload_json, "
        "priority, last_run_id, last_enqueued_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, $7, NOW(), '', NOW()) "
        "ON CONFLICT (job_key) DO UPDATE SET "
        "job_type = EXCLUDED.job_type, "
        "payload_version = EXCLUDED.payload_version, "
        "channel_id = EXCLUDED.channel_id, "
        "status = 'pending', "
        "payload_json = EXCLUDED.payload_json, "
        "priority = EXCLUDED.priority, "
        "attempt_count = CASE "
        "    WHEN slack_sync_backfill_jobs.status = 'running' THEN slack_sync_backfill_jobs.attempt_count "
        "    ELSE 0 "
        "END, "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_enqueued_at = NOW(), "
        "last_completed_at = NULL, "
        "last_error = '', "
        "updated_at = NOW()" + completion_guard,
        job_key,
        job_type,
        BACKFILL_JOB_PAYLOAD_VERSION,
        channel_id,
        canonical_json(payload),
        priority,
        run_id,
    )


async def seed_channel_bootstrap_job(
    pool,
    *,
    channel_id: str,
    window_oldest: str,
    window_latest: str,
    lookback_days: int,
    thread_lookback_days: int,
    run_id: str,
    priority: int = 200,
) -> bool:
    """Create the one initial historical bootstrap job for a channel.

    Bootstrap rows are channel state, not per-sync-run events: once a row exists,
    incremental sync must leave its fixed window and cursor progress alone.
    """
    if not channel_id or not window_oldest or not window_latest:
        return False
    result = await pool.execute(
        "INSERT INTO slack_sync_backfill_jobs ("
        "job_key, job_type, payload_version, channel_id, status, payload_json, "
        "priority, last_run_id, last_enqueued_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, $7, NOW(), '', NOW()) "
        "ON CONFLICT DO NOTHING",
        f"bootstrap:{channel_id}",
        BACKFILL_JOB_CHANNEL_BOOTSTRAP,
        BACKFILL_JOB_PAYLOAD_VERSION,
        channel_id,
        canonical_json(
            {
                "cursor": None,
                "window_oldest": window_oldest,
                "window_latest": window_latest,
                "lookback_days": lookback_days,
                "thread_lookback_days": thread_lookback_days,
            }
        ),
        priority,
        run_id,
    )
    return result == "INSERT 0 1"


async def claim_backfill_jobs(pool, limit: int) -> list[dict[str, Any]]:
    """Claim a bounded batch of pending backfill jobs for one workflow run."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                "WITH claimed AS ("
                "    SELECT job_id "
                "    FROM slack_sync_backfill_jobs "
                "    WHERE status IN ('pending', 'failed') "
                "    ORDER BY priority, updated_at, job_id "
                "    LIMIT $1 "
                "    FOR UPDATE SKIP LOCKED"
                ") "
                "UPDATE slack_sync_backfill_jobs backfills "
                "SET status = 'running', "
                "    attempt_count = backfills.attempt_count + 1, "
                "    last_started_at = NOW(), "
                "    updated_at = NOW() "
                "FROM claimed "
                "WHERE backfills.job_id = claimed.job_id "
                "RETURNING backfills.job_id, backfills.job_key, backfills.job_type, "
                "backfills.payload_version, backfills.channel_id, backfills.payload_json, "
                "backfills.priority, backfills.attempt_count",
                limit,
            )
    return [dict(row) for row in rows]


async def mark_backfill_job_failed(
    pool,
    *,
    job_id: int,
    run_id: str,
    error: str,
) -> None:
    """Return a claimed backfill job to the queue as failed."""
    await pool.execute(
        "UPDATE slack_sync_backfill_jobs SET "
        "status = 'failed', last_run_id = $2, last_error = $3, updated_at = NOW() "
        "WHERE job_id = $1",
        job_id,
        run_id,
        error,
    )


async def mark_backfill_job_completed(
    pool,
    *,
    job_id: int,
    run_id: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Mark a finished backfill job as completed for observability and auditability."""
    if payload is None:
        await pool.execute(
            "UPDATE slack_sync_backfill_jobs SET "
            "status = 'completed', last_run_id = $2, last_completed_at = NOW(), "
            "last_error = '', updated_at = NOW() "
            "WHERE job_id = $1",
            job_id,
            run_id,
        )
        return
    await pool.execute(
        "UPDATE slack_sync_backfill_jobs SET "
        "status = 'completed', last_run_id = $2, payload_json = $3::jsonb, "
        "last_completed_at = NOW(), last_error = '', updated_at = NOW() "
        "WHERE job_id = $1",
        job_id,
        run_id,
        canonical_json(payload),
    )
