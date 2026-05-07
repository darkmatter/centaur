"""Workflow: sync public Slack channel history into Postgres."""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from api.runtime_control import canonical_json
from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "slack_sync"

DEFAULT_LOOKBACK_DAYS = 30
DEFAULT_THREAD_LOOKBACK_DAYS = 3
DEFAULT_CHANNEL_PAGE_LIMIT = 600
DEFAULT_THREAD_REPLY_PAGE_LIMIT = 200
DEFAULT_SYNC_INTERVAL_SECONDS = 14_400
FALSE_ENV_VALUES = {"0", "false", "no", "off"}


def _positive_int(value: int | str | None, default: int) -> int:
    """Coerce positive integer config values with a safe default."""
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _env_flag_enabled(name: str, default: bool = True) -> bool:
    """Read a boolean feature flag where common false strings opt out."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in FALSE_ENV_VALUES


SCHEDULE = {
    "schedule_id": "slack_sync",
    "interval_seconds": _positive_int(
        os.getenv("SLACK_SYNC_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": _env_flag_enabled("SLACK_ETL_ENABLED", default=True),
    "no_delivery": True,
}


class SlackSyncClient(Protocol):
    """Small protocol for the Slack client methods this workflow uses."""

    def _etl_access_mode(self) -> str:
        ...

    def _list_etl_channels(self, limit: int = 200, force_refresh: bool = False) -> list[dict]:
        ...

    def _list_etl_users(self, limit: int = 200) -> list[dict]:
        ...

    def _sync_etl_channel_history(
        self,
        channel: str,
        state: dict[str, Any] | None = None,
        limit: int = DEFAULT_CHANNEL_PAGE_LIMIT,
        lookback_days: int = 30,
        oldest: str | int | float | None = None,
        latest: str | int | float | None = None,
    ) -> dict[str, Any]:
        ...

    def _get_etl_thread_replies_page(
        self,
        channel: str,
        thread_ts: str,
        limit: int = DEFAULT_THREAD_REPLY_PAGE_LIMIT,
        cursor: str | None = None,
        oldest: str | int | float | None = None,
        latest: str | int | float | None = None,
        inclusive: bool = True,
    ) -> dict[str, Any]:
        ...


@dataclass
class Input:
    """Runtime options for a manual Slack sync workflow run."""

    lookback_days: int | None = None
    thread_lookback_days: int | None = None
    limit: int = DEFAULT_CHANNEL_PAGE_LIMIT
    thread_reply_limit: int = DEFAULT_THREAD_REPLY_PAGE_LIMIT
    oldest: str | None = None
    latest: str | None = None
    mode: str = "incremental"
    metadata: dict[str, Any] = field(default_factory=dict)


def _ts_minus_days(ts: str | None, days: int) -> str | None:
    """Move a Slack timestamp back by a whole-day lookback window."""
    if not ts:
        return None
    try:
        seconds = max(float(ts) - (days * 86_400), 0.0)
    except (TypeError, ValueError):
        return None
    return f"{seconds:.6f}"


def _slack_ts_to_datetime(ts: str | None) -> dt.datetime | None:
    """Convert Slack timestamp strings to UTC datetimes for indexed queries."""
    if not ts:
        return None
    try:
        return dt.datetime.fromtimestamp(float(ts), tz=dt.timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _message_thread_ts(message: dict[str, Any]) -> str | None:
    """Return the thread root timestamp for a normalized Slack message."""
    thread_ts = message.get("thread_ts")
    if isinstance(thread_ts, str) and thread_ts.strip():
        return thread_ts.strip()
    message_ts = message.get("timestamp")
    reply_count = message.get("reply_count")
    if isinstance(message_ts, str) and isinstance(reply_count, int) and reply_count > 0:
        return message_ts
    return None


def _message_row(message: dict[str, Any], run_id: str, parent_message_ts: str | None = None) -> dict:
    """Project a normalized Slack message into the DB upsert shape."""
    message_ts = str(message.get("timestamp") or "")
    thread_ts = _message_thread_ts(message)
    user_id = str(message.get("user_id") or "")
    bot_id = str(message.get("bot_id") or "")
    return {
        "channel_id": str(message.get("channel_id") or ""),
        "message_ts": message_ts,
        "occurred_at": _slack_ts_to_datetime(message_ts),
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


def _channel_ref(channel: dict[str, Any], reason: str | None = None) -> dict[str, str]:
    """Return a compact channel reference for run summaries."""
    result = {
        "channel_id": str(channel.get("id") or ""),
        "channel_name": str(channel.get("name") or ""),
    }
    if reason:
        result["reason"] = reason
    return result


async def _upsert_channels(pool, channels: list[dict[str, Any]]) -> None:
    """Refresh public Slack sync channel rows and mark absent channels inactive."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE slack_sync_channels SET is_member = FALSE, updated_at = NOW()",
            )
            for channel in channels:
                channel_id = str(channel.get("id") or "")
                if not channel_id:
                    continue
                await conn.execute(
                    "INSERT INTO slack_sync_channels ("
                    "channel_id, channel_name, is_archived, is_member, topic, purpose, "
                    "member_count, raw_payload, last_seen_at, updated_at"
                    ") VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7::jsonb, NOW(), NOW()) "
                    "ON CONFLICT (channel_id) DO UPDATE SET "
                    "channel_name = EXCLUDED.channel_name, "
                    "is_archived = EXCLUDED.is_archived, "
                    "is_member = TRUE, "
                    "topic = EXCLUDED.topic, "
                    "purpose = EXCLUDED.purpose, "
                    "member_count = EXCLUDED.member_count, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    channel_id,
                    str(channel.get("name") or ""),
                    bool(channel.get("is_archived")),
                    str(channel.get("topic") or ""),
                    str(channel.get("purpose") or ""),
                    int(channel.get("member_count") or 0),
                    canonical_json(channel),
                )


async def _upsert_users(pool, users: list[dict[str, Any]]) -> int:
    """Refresh Slack user directory rows."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            for user in users:
                user_id = str(user.get("id") or "")
                if not user_id:
                    continue
                profile = user.get("profile") if isinstance(user.get("profile"), dict) else {}
                await conn.execute(
                    "INSERT INTO slack_sync_users ("
                    "user_id, user_name, real_name, display_name, is_bot, is_deleted, "
                    "team_id, raw_payload, last_seen_at, updated_at"
                    ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW()) "
                    "ON CONFLICT (user_id) DO UPDATE SET "
                    "user_name = EXCLUDED.user_name, "
                    "real_name = EXCLUDED.real_name, "
                    "display_name = EXCLUDED.display_name, "
                    "is_bot = EXCLUDED.is_bot, "
                    "is_deleted = EXCLUDED.is_deleted, "
                    "team_id = EXCLUDED.team_id, "
                    "raw_payload = EXCLUDED.raw_payload, "
                    "last_seen_at = NOW(), "
                    "updated_at = NOW()",
                    user_id,
                    str(user.get("name") or ""),
                    str(user.get("real_name") or ""),
                    str(user.get("display_name") or profile.get("display_name") or ""),
                    bool(user.get("is_bot")),
                    bool(user.get("deleted") or user.get("is_deleted")),
                    str(user.get("team_id") or user.get("team") or ""),
                    canonical_json(user),
                )
    return len([u for u in users if u.get("id")])


async def _load_checkpoint(pool, channel_id: str) -> dict[str, Any] | None:
    """Load the current per-channel sync checkpoint."""
    row = await pool.fetchrow(
        "SELECT cursor, watermark_ts, oldest_ts, latest_ts, lookback_days, thread_lookback_days "
        "FROM slack_sync_checkpoints WHERE channel_id = $1",
        channel_id,
    )
    return dict(row) if row else None


async def _upsert_messages(pool, rows: list[dict[str, Any]]) -> int:
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


async def _record_run_start(
    pool,
    *,
    run_id: str,
    workflow_run_id: str,
    mode: str,
    requested: list[dict[str, str]],
    skipped: list[dict[str, str]],
    metadata: dict[str, Any],
) -> None:
    """Insert the run row once at least one public channel will be synced."""
    await pool.execute(
        "INSERT INTO slack_sync_runs ("
        "run_id, workflow_run_id, mode, status, channels_requested, channels_skipped, metadata"
        ") VALUES ($1, $2, $3, 'running', $4::jsonb, $5::jsonb, $6::jsonb)",
        run_id,
        workflow_run_id,
        mode,
        canonical_json(requested),
        canonical_json(skipped),
        canonical_json(metadata),
    )


async def _record_run_finish(
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


async def _update_checkpoint_success(
    pool,
    *,
    channel_id: str,
    state: dict[str, Any],
    run_id: str,
    lookback_days: int,
    thread_lookback_days: int,
) -> None:
    """Advance a channel checkpoint after all writes for that channel succeed."""
    await pool.execute(
        "INSERT INTO slack_sync_checkpoints ("
        "channel_id, cursor, watermark_ts, oldest_ts, latest_ts, lookback_days, "
        "thread_lookback_days, last_run_id, last_success_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), '', NOW()) "
        "ON CONFLICT (channel_id) DO UPDATE SET "
        "cursor = EXCLUDED.cursor, "
        "watermark_ts = EXCLUDED.watermark_ts, "
        "oldest_ts = EXCLUDED.oldest_ts, "
        "latest_ts = EXCLUDED.latest_ts, "
        "lookback_days = EXCLUDED.lookback_days, "
        "thread_lookback_days = EXCLUDED.thread_lookback_days, "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_success_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        channel_id,
        state.get("cursor"),
        state.get("watermark"),
        state.get("oldest"),
        state.get("latest"),
        lookback_days,
        thread_lookback_days,
        run_id,
    )


async def _update_checkpoint_failure(
    pool,
    *,
    channel_id: str,
    run_id: str,
    error: str,
    lookback_days: int,
    thread_lookback_days: int,
) -> None:
    """Record channel failure details without advancing the watermark."""
    await pool.execute(
        "INSERT INTO slack_sync_checkpoints ("
        "channel_id, lookback_days, thread_lookback_days, last_run_id, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, $5, NOW()) "
        "ON CONFLICT (channel_id) DO UPDATE SET "
        "lookback_days = EXCLUDED.lookback_days, "
        "thread_lookback_days = EXCLUDED.thread_lookback_days, "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_error = EXCLUDED.last_error, "
        "updated_at = NOW()",
        channel_id,
        lookback_days,
        thread_lookback_days,
        run_id,
        error,
    )


def _client() -> SlackSyncClient:
    """Construct the Slack tool client from either import path or repo layout."""
    try:
        from slack.client import SlackClient
    except ModuleNotFoundError:
        client_path = Path(__file__).resolve().parents[1] / "tools" / "slack" / "client.py"
        spec = importlib.util.spec_from_file_location("_slack_sync_tool_client", client_path)
        if not spec or not spec.loader:
            raise
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        SlackClient = module.SlackClient

    return SlackClient()


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Sync public Slack channels visible through the configured ETL user token."""
    if not _env_flag_enabled("SLACK_ETL_ENABLED", default=True):
        ctx.log("slack_sync_skipped_disabled")
        return {
            "status": "skipped",
            "reason": "slack_etl_disabled",
            "channels_skipped": [],
        }

    lookback_days = _positive_int(
        inp.lookback_days or os.getenv("SLACK_SYNC_LOOKBACK_DAYS"),
        DEFAULT_LOOKBACK_DAYS,
    )
    thread_lookback_days = _positive_int(
        inp.thread_lookback_days or os.getenv("SLACK_SYNC_THREAD_LOOKBACK_DAYS"),
        DEFAULT_THREAD_LOOKBACK_DAYS,
    )
    limit = _positive_int(inp.limit, DEFAULT_CHANNEL_PAGE_LIMIT)
    thread_reply_limit = _positive_int(inp.thread_reply_limit, DEFAULT_THREAD_REPLY_PAGE_LIMIT)
    client = _client()
    access_mode = client._etl_access_mode()
    channels_to_sync = client._list_etl_channels(limit=10_000, force_refresh=True)
    await _upsert_channels(ctx._pool, channels_to_sync)

    if not channels_to_sync:
        reason = "no_public_channels"
        ctx.log("slack_sync_skipped_no_public_channels", access_mode=access_mode, reason=reason)
        return {
            "status": "skipped",
            "reason": reason,
            "channels_skipped": [],
        }

    users = client._list_etl_users(limit=10_000)
    users_upserted = await _upsert_users(ctx._pool, users)

    run_id = f"slack_sync_{uuid.uuid4().hex[:16]}"
    await _record_run_start(
        ctx._pool,
        run_id=run_id,
        workflow_run_id=ctx.run_id,
        mode=inp.mode,
        requested=[_channel_ref(channel) for channel in channels_to_sync],
        skipped=[],
        metadata={
            **inp.metadata,
            "slack_access_mode": access_mode,
            "users_upserted": users_upserted,
        },
    )

    synced: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    counts = {
        "messages_fetched": 0,
        "messages_upserted": 0,
        "threads_fetched": 0,
        "replies_fetched": 0,
        "replies_upserted": 0,
    }

    for channel in channels_to_sync:
        channel_id = str(channel.get("id") or "")
        channel_name = str(channel.get("name") or channel_id)
        try:
            checkpoint = await _load_checkpoint(ctx._pool, channel_id)
            state = {
                "cursor": checkpoint.get("cursor") if checkpoint else None,
                "watermark": checkpoint.get("watermark_ts") if checkpoint else None,
                "oldest": checkpoint.get("oldest_ts") if checkpoint else None,
                "latest": checkpoint.get("latest_ts") if checkpoint else None,
            }
            oldest = inp.oldest
            if oldest is None and not state.get("cursor") and state.get("watermark"):
                oldest = _ts_minus_days(str(state["watermark"]), thread_lookback_days)

            page = client._sync_etl_channel_history(
                channel_id,
                state=state,
                limit=limit,
                lookback_days=lookback_days,
                oldest=oldest,
                latest=inp.latest,
            )
            messages = page.get("messages") or []
            message_rows = [_message_row(msg, run_id) for msg in messages]
            counts["messages_fetched"] += len(message_rows)
            counts["messages_upserted"] += await _upsert_messages(ctx._pool, message_rows)

            thread_roots = {
                str(msg.get("timestamp"))
                for msg in messages
                if msg.get("timestamp") and int(msg.get("reply_count") or 0) > 0
            }
            for thread_ts in sorted(thread_roots):
                reply_cursor = None
                seen_reply_cursors: set[str] = set()
                counts["threads_fetched"] += 1
                while True:
                    replies_page = client._get_etl_thread_replies_page(
                        channel_id,
                        thread_ts=thread_ts,
                        limit=thread_reply_limit,
                        cursor=reply_cursor,
                        oldest=oldest,
                        latest=inp.latest,
                        inclusive=True,
                    )
                    replies = [
                        reply
                        for reply in replies_page.get("messages", [])
                        if str(reply.get("timestamp") or "") != thread_ts
                    ]
                    reply_rows = [_message_row(reply, run_id, thread_ts) for reply in replies]
                    counts["replies_fetched"] += len(reply_rows)
                    counts["replies_upserted"] += await _upsert_messages(ctx._pool, reply_rows)

                    next_reply_cursor = replies_page.get("next_cursor")
                    if not replies_page.get("has_more") or not next_reply_cursor:
                        break
                    if next_reply_cursor in seen_reply_cursors:
                        raise RuntimeError(
                            f"Slack returned a repeated reply cursor for thread {thread_ts}"
                        )
                    seen_reply_cursors.add(next_reply_cursor)
                    reply_cursor = str(next_reply_cursor)

            await _update_checkpoint_success(
                ctx._pool,
                channel_id=channel_id,
                state=page.get("sync_state") or {},
                run_id=run_id,
                lookback_days=lookback_days,
                thread_lookback_days=thread_lookback_days,
            )
            synced.append(_channel_ref(channel))
            ctx.log(
                "slack_sync_channel_completed",
                channel_id=channel_id,
                channel_name=channel_name,
                messages=len(message_rows),
                threads=len(thread_roots),
            )
        except Exception as exc:
            error = str(exc)
            ctx.log(
                "slack_sync_channel_failed",
                channel_id=channel_id,
                channel_name=channel_name,
                error=error,
            )
            failed.append(_channel_ref(channel, error))
            await _update_checkpoint_failure(
                ctx._pool,
                channel_id=channel_id,
                run_id=run_id,
                error=error,
                lookback_days=lookback_days,
                thread_lookback_days=thread_lookback_days,
            )

    status = "completed"
    error_text = ""
    if failed and synced:
        status = "partial_failed"
        error_text = f"{len(failed)} channel(s) failed"
    elif failed:
        status = "failed"
        error_text = f"{len(failed)} channel(s) failed"

    await _record_run_finish(
        ctx._pool,
        run_id=run_id,
        status=status,
        synced=synced,
        skipped=skipped,
        failed=failed,
        counts=counts,
        error_text=error_text,
    )

    return {
        "status": status,
        "run_id": run_id,
        "channels_synced": len(synced),
        "channels_skipped": len(skipped),
        "channels_failed": len(failed),
        **counts,
    }
