from __future__ import annotations

import os
import uuid


def normalize_trace_id(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        parsed = uuid.UUID(raw)
    except ValueError:
        return None
    if parsed.int == 0:
        return None
    return str(parsed)


def traceparent_from_trace_id(trace_id: str | None) -> str | None:
    normalized = normalize_trace_id(trace_id)
    if not normalized:
        return None
    span_id = int.from_bytes(os.urandom(8), "big") or 1
    return f"00-{uuid.UUID(normalized).hex}-{span_id:016x}-01"


async def get_or_create_thread_trace_id(pool, thread_key: str | None) -> str | None:
    if not thread_key:
        return None
    row = await pool.fetchrow(
        "INSERT INTO thread_traces (thread_key) VALUES ($1) "
        "ON CONFLICT (thread_key) DO UPDATE SET updated_at = NOW() "
        "RETURNING trace_id",
        thread_key,
    )
    return str(row["trace_id"]) if row and row["trace_id"] else None
