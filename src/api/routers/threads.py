"""Thread viewer API.

Live threads are streamed from in-memory sessions via SSE.
Historical/completed threads are read from Postgres.
"""

from __future__ import annotations

import asyncio
import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from starlette.responses import StreamingResponse

from api.agent import _sessions
from api.deps import get_pool, verify_ui_or_api_key

router = APIRouter(
    prefix="/api/threads",
    tags=["threads"],
    dependencies=[Depends(verify_ui_or_api_key)],
)


def _build_live_detail(key: str, session: dict[str, Any]) -> dict[str, Any]:
    """Build thread detail from an in-memory session."""
    return {
        "slack_thread_key": key,
        "container_id": session["container_id"][:12],
        "harness": session["harness"],
        "agent_thread_id": session.get("agent_thread_id"),
        "state": session["state"],
        "created_at": session["created_at"],
        "last_activity": session["last_activity"],
        "turns": session.get("turns", []),
    }


@router.get("")
async def list_threads(
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> dict[str, Any]:
    """List all agent sessions with summary info."""
    rows = await pool.fetch(
        """
        SELECT
            s.slack_thread_key,
            s.container_id,
            s.harness,
            s.agent_thread_id,
            s.state,
            extract(epoch from s.created_at)    AS created_at,
            extract(epoch from s.last_activity) AS last_activity,
            coalesce(tc.turn_count, 0)          AS turn_count,
            coalesce(lt.result, '')              AS last_result
        FROM agent_sessions s
        LEFT JOIN LATERAL (
            SELECT count(*) AS turn_count
            FROM agent_turns t WHERE t.slack_thread_key = s.slack_thread_key
        ) tc ON true
        LEFT JOIN LATERAL (
            SELECT t.result
            FROM agent_turns t
            WHERE t.slack_thread_key = s.slack_thread_key
            ORDER BY t.turn_id DESC LIMIT 1
        ) lt ON true
        ORDER BY s.last_activity DESC
        """
    )
    threads = []
    for r in rows:
        threads.append(
            {
                "slack_thread_key": r["slack_thread_key"],
                "container_id": r["container_id"][:12],
                "harness": r["harness"],
                "agent_thread_id": r["agent_thread_id"],
                "state": r["state"],
                "created_at": float(r["created_at"]),
                "last_activity": float(r["last_activity"]),
                "turn_count": r["turn_count"],
                "last_result": (r["last_result"] or "")[:200],
            }
        )
    return {"threads": threads, "count": len(threads)}


async def _fetch_pg_detail(pool: asyncpg.Pool, key: str) -> dict[str, Any]:
    """Read full thread detail from Postgres. Raises HTTPException(404) if not found."""
    row = await pool.fetchrow(
        """
        SELECT
            slack_thread_key,
            container_id,
            harness,
            agent_thread_id,
            state,
            extract(epoch from created_at)    AS created_at,
            extract(epoch from last_activity) AS last_activity
        FROM agent_sessions
        WHERE slack_thread_key = $1
        """,
        key,
    )
    if not row:
        raise HTTPException(status_code=404, detail=f"Thread '{key}' not found")

    turn_rows = await pool.fetch(
        """
        SELECT
            turn_id,
            user_message,
            events,
            result,
            extract(epoch from started_at)  AS started_at,
            extract(epoch from finished_at) AS finished_at,
            exit_code,
            timed_out,
            duration_s
        FROM agent_turns
        WHERE slack_thread_key = $1
        ORDER BY turn_id
        """,
        key,
    )

    turns = []
    for t in turn_rows:
        events_raw = t["events"]
        if isinstance(events_raw, str):
            events_raw = json.loads(events_raw)
        turns.append(
            {
                "turn_id": t["turn_id"],
                "user_message": t["user_message"],
                "events": events_raw,
                "result": t["result"],
                "started_at": float(t["started_at"]) if t["started_at"] else None,
                "finished_at": float(t["finished_at"]) if t["finished_at"] else None,
                "exit_code": t["exit_code"],
                "timed_out": t["timed_out"],
                "duration_s": float(t["duration_s"]),
            }
        )

    return {
        "slack_thread_key": row["slack_thread_key"],
        "container_id": row["container_id"][:12],
        "harness": row["harness"],
        "agent_thread_id": row["agent_thread_id"],
        "state": row["state"],
        "created_at": float(row["created_at"]),
        "last_activity": float(row["last_activity"]),
        "turns": turns,
    }


@router.get("/detail")
async def get_thread(
    key: str,
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> dict[str, Any]:
    """Get full thread detail. Prefers live in-memory data, falls back to PG."""
    session = _sessions.get(key)
    if session:
        return _build_live_detail(key, session)
    return await _fetch_pg_detail(pool, key)


@router.get("/stream")
async def stream_thread(
    key: str,
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> StreamingResponse:
    """SSE stream of thread updates. Live sessions stream from memory;
    historical threads send a single snapshot from Postgres."""

    async def generate():
        # If not in memory, send PG snapshot immediately and close
        session = _sessions.get(key)
        if not session:
            try:
                detail = await _fetch_pg_detail(pool, key)
                yield f"data: {json.dumps(detail, default=str)}\n\n"
            except HTTPException:
                yield f"event: error\ndata: {json.dumps({'error': 'not_found'})}\n\n"
            return

        last_event_count = -1
        last_state = ""
        idle_ticks = 0

        while True:
            session = _sessions.get(key)
            if not session:
                break

            total_events = sum(
                len(t.get("events", [])) for t in session.get("turns", [])
            )
            state = session.get("state", "")

            if total_events != last_event_count or state != last_state:
                detail = _build_live_detail(key, session)
                yield f"data: {json.dumps(detail, default=str)}\n\n"
                last_event_count = total_events
                last_state = state
                idle_ticks = 0
            else:
                idle_ticks += 1

            # Stop streaming after 30s of no changes on an idle thread
            if state == "idle" and idle_ticks > 100:
                break

            await asyncio.sleep(0.3)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
