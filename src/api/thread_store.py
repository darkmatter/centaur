from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import asyncpg


async def append_thread_event(
    pool: asyncpg.Pool,
    *,
    slack_thread_key: str,
    source: str,
    event_type: str,
    payload: dict[str, Any],
    event_seq: int | None = None,
    event_id: str | None = None,
) -> tuple[str, int]:
    if event_seq is not None:
        seq = event_seq
        identifier = event_id or f"{slack_thread_key}:{seq}:{uuid.uuid4().hex[:8]}"
        row = await pool.fetchrow(
            """
            INSERT INTO thread_events_ledger
                (event_id, slack_thread_key, source, event_type, event_seq, occurred_at, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            ON CONFLICT DO NOTHING
            RETURNING event_seq
            """,
            identifier,
            slack_thread_key,
            source,
            event_type,
            seq,
            datetime.now(UTC),
            json.dumps(payload, default=str),
        )
        if row:
            return identifier, int(row["event_seq"])
        existing_seq = await pool.fetchval(
            """
            SELECT event_seq
            FROM thread_events_ledger
            WHERE event_id = $1
            """,
            identifier,
        )
        if existing_seq is not None:
            return identifier, int(existing_seq)
        existing_seq = await pool.fetchval(
            """
            SELECT event_seq
            FROM thread_events_ledger
            WHERE slack_thread_key = $1
              AND event_seq = $2
            """,
            slack_thread_key,
            seq,
        )
        if existing_seq is not None:
            return identifier, int(existing_seq)
        return identifier, seq

    occurred_at = datetime.now(UTC)
    payload_json = json.dumps(payload, default=str)
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            slack_thread_key,
        )
        candidate_seq = await conn.fetchval(
            """
            SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
            FROM thread_events_ledger
            WHERE slack_thread_key = $1
            """,
            slack_thread_key,
        )
        seq = int(candidate_seq or 1)
        identifier = event_id or f"{slack_thread_key}:{seq}:{uuid.uuid4().hex[:8]}"
        row = await conn.fetchrow(
            """
            INSERT INTO thread_events_ledger
                (event_id, slack_thread_key, source, event_type, event_seq, occurred_at, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            ON CONFLICT (event_id) DO NOTHING
            RETURNING event_seq
            """,
            identifier,
            slack_thread_key,
            source,
            event_type,
            seq,
            occurred_at,
            payload_json,
        )
        if row:
            return identifier, int(row["event_seq"])
        existing_seq = await conn.fetchval(
            """
            SELECT event_seq
            FROM thread_events_ledger
            WHERE event_id = $1
            """,
            identifier,
        )
        if existing_seq is not None:
            return identifier, int(existing_seq)
    raise RuntimeError(f"Failed to append event for thread {slack_thread_key}")
