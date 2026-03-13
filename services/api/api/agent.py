"""Pipe agent — spawn sandboxes, pipe stdin/stdout, Postgres-backed sessions.

Thin orchestration layer: one sandbox per thread_key, raw NDJSON streaming.
Session mapping lives in Postgres (sandbox_sessions table). Process-local
runtime state (queues, locks, reader threads, sockets) stays in-memory keyed
by sandbox_id.
"""

from __future__ import annotations

import asyncio
import json
import queue
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

import structlog

from api.metrics import record_agent_execution
from api.sandbox.base import RuntimeState, SandboxSession
from api.sandbox.harness_protocol import (
    build_user_input,
    extract_result,
    extract_thread_id,
    is_turn_done,
    messages_to_content_blocks,
)
from api.sandbox.registry import get_backend

log = structlog.get_logger()

_ENGINE_HARNESSES = {"amp", "claude-code", "codex", "pi-mono"}
_REUSABLE_DB_STATES = {"running", "idle", "delivering", "error"}

# ── Process-local runtime state (ephemeral: queues, locks, sockets) ──────────

_runtime: dict[str, RuntimeState] = {}


def _get_runtime(sandbox_id: str) -> RuntimeState:
    """Get or create process-local runtime state for a sandbox."""
    if sandbox_id not in _runtime:
        _runtime[sandbox_id] = RuntimeState()
    return _runtime[sandbox_id]


def _drop_runtime(sandbox_id: str) -> None:
    """Remove process-local runtime state for a sandbox."""
    _runtime.pop(sandbox_id, None)


# ── DB pool access ───────────────────────────────────────────────────────────


def _get_pool():
    """Get the asyncpg pool from the FastAPI app state."""
    from api.app import app

    return app.state.db_pool


# ── DB helpers (async) ───────────────────────────────────────────────────────


async def _db_get_session(thread_key: str) -> SandboxSession | None:
    """Load a session from the DB. Returns None if not found."""
    pool = _get_pool()
    row = await pool.fetchrow(
        "SELECT thread_key, sandbox_id, harness, engine, state, started_at "
        "FROM sandbox_sessions WHERE thread_key = $1",
        thread_key,
    )
    if row is None:
        return None
    session = SandboxSession(
        sandbox_id=row["sandbox_id"],
        thread_key=row["thread_key"],
        harness=row["harness"],
        engine=row["engine"],
        started_at=row["started_at"].timestamp() if row["started_at"] else 0.0,
        backend_name="docker",
        db_state=row["state"],
    )
    _get_runtime(session.sandbox_id)
    return session


async def _db_insert_session(
    session: SandboxSession,
    *,
    harness: str,
    engine: str,
) -> bool:
    """Insert a session row. Returns True if we won the insert race."""
    pool = _get_pool()
    row = await pool.fetchrow(
        "INSERT INTO sandbox_sessions (thread_key, sandbox_id, harness, engine, state, started_at) "
        "VALUES ($1, $2, $3, $4, 'running', NOW()) "
        "ON CONFLICT (thread_key) DO NOTHING "
        "RETURNING thread_key",
        session.thread_key,
        session.sandbox_id,
        harness,
        engine,
    )
    return row is not None


async def _db_update_state(thread_key: str, state: str) -> None:
    """Update the state of a session in the DB."""
    pool = _get_pool()
    await pool.execute(
        "UPDATE sandbox_sessions SET state = $1, updated_at = NOW() WHERE thread_key = $2",
        state,
        thread_key,
    )


async def _db_delete_session(thread_key: str) -> None:
    """Delete a session row from the DB."""
    pool = _get_pool()
    await pool.execute("DELETE FROM sandbox_sessions WHERE thread_key = $1", thread_key)


# ── Flush pipeline helpers ───────────────────────────────────────────────────


async def _flush_pending(
    thread_key: str, last_delivered_id: str | None
) -> list[dict]:
    """Fetch messages from chat_messages that haven't been delivered yet.

    If last_delivered_id is NULL, returns ALL messages (full replay).
    Otherwise returns messages created after the cursor's created_at.
    """
    pool = _get_pool()
    if last_delivered_id is None:
        rows = await pool.fetch(
            "SELECT id, role, parts, user_id, metadata, created_at "
            "FROM chat_messages WHERE thread_key = $1 ORDER BY created_at",
            thread_key,
        )
    else:
        rows = await pool.fetch(
            "SELECT id, role, parts, user_id, metadata, created_at "
            "FROM chat_messages WHERE thread_key = $1 "
            "AND created_at > (SELECT created_at FROM chat_messages WHERE id = $2) "
            "ORDER BY created_at",
            thread_key,
            last_delivered_id,
        )
    return [dict(r) for r in rows]


def _flushed_to_messages(flushed_rows: list[dict]) -> list[dict]:
    """Convert flushed DB rows into the message format expected by
    ``messages_to_content_blocks``."""
    messages = []
    for row in flushed_rows:
        parts = row.get("parts", [])
        if isinstance(parts, str):
            parts = json.loads(parts)
        user_id = row.get("user_id")
        messages.append({
            "role": row.get("role", "user"),
            "parts": parts,
            **({"user_id": user_id} if user_id else {}),
        })
    return messages


async def _advance_cursor(thread_key: str, last_msg_id: str) -> None:
    """Advance the session cursor to the last delivered message ID."""
    pool = _get_pool()
    await pool.execute(
        "UPDATE sandbox_sessions SET last_delivered_id = $1, updated_at = NOW() "
        "WHERE thread_key = $2",
        last_msg_id,
        thread_key,
    )


async def _get_last_delivered_id(thread_key: str) -> str | None:
    """Get the last_delivered_id cursor from sandbox_sessions."""
    pool = _get_pool()
    row = await pool.fetchrow(
        "SELECT last_delivered_id FROM sandbox_sessions WHERE thread_key = $1",
        thread_key,
    )
    return row["last_delivered_id"] if row else None


async def _insert_system_message(thread_key: str, platform: str) -> None:
    """Insert a static system message with platform formatting rules (idempotent)."""
    pool = _get_pool()
    msg_id = f"system-{thread_key}-{platform}"
    context = _build_session_context(thread_key, platform=platform)
    await pool.execute(
        "INSERT INTO chat_messages (id, thread_key, role, parts, metadata) "
        "VALUES ($1, $2, 'system', $3::jsonb, '{}'::jsonb) "
        "ON CONFLICT (id) DO NOTHING",
        msg_id,
        thread_key,
        json.dumps([{"type": "text", "text": context}]),
    )


# ── Harness / persona resolution ────────────────────────────────────────────


def _resolve_harness_profile(
    harness: str,
    engine_override: str | None = None,
) -> tuple[str, str | None, str | None]:
    from api.app import get_tool_manager

    normalized = (harness or "").strip() or "amp"
    normalized_engine_override = (engine_override or "").strip() or None
    if normalized_engine_override and normalized_engine_override not in _ENGINE_HARNESSES:
        raise ValueError(f"Unknown engine override: {normalized_engine_override}")
    if normalized in _ENGINE_HARNESSES:
        return normalized_engine_override or normalized, None, None
    persona_info = get_tool_manager().get_persona(normalized)
    if persona_info:
        return (
            normalized_engine_override or persona_info.engine,
            persona_info.name,
            persona_info.default_repo,
        )
    return normalized_engine_override or "amp", None, None


# ── Sync helpers (called from background threads) ───────────────────────────


def _ensure_reader(session: SandboxSession, *, force: bool = False) -> None:
    """Start a single background reader thread that dispatches stdout lines to the
    active turn's queue. Only one reader ever exists per session.

    Pass force=True after a stream reconnect to start a new reader even if the
    old one is still alive (it will be invalidated via the generation counter).
    """
    rt = _get_runtime(session.sandbox_id)
    if not force and rt.reader_thread and rt.reader_thread.is_alive():
        return

    backend = get_backend()
    rt.reader_gen += 1
    gen = rt.reader_gen

    def _read_loop(my_gen: int = gen) -> None:
        try:
            for line in backend.stream_stdout(session):
                cur = _runtime.get(session.sandbox_id)
                if cur is None or cur.reader_gen != my_gen:
                    return
                if cur.active_queue is not None:
                    cur.active_queue.put(line)
        except Exception:
            pass
        # EOF — signal the active queue only if this reader is still current
        cur = _runtime.get(session.sandbox_id)
        if cur is not None and cur.reader_gen == my_gen and cur.active_queue is not None:
            cur.active_queue.put(None)

    t = threading.Thread(target=_read_loop, daemon=True)
    t.start()
    rt.reader_thread = t


def _spawn_sync(
    thread_key: str,
    harness: str,
    *,
    engine_override: str | None = None,
) -> SandboxSession:
    """Synchronous spawn: create sandbox + register session."""
    engine, persona, repo = _resolve_harness_profile(harness, engine_override=engine_override)

    backend = get_backend()
    session = backend.create(thread_key, harness, engine, persona=persona, repo=repo)

    _get_runtime(session.sandbox_id)

    log.info("pipe_session_spawned", thread_key=thread_key, sandbox=session.sandbox_id[:12])
    return session


def _stream_turn(
    session: SandboxSession,
    message: dict | None = None,
    *,
    logs: bool = False,
    skip_done_count: int = 0,
):
    """Stream stdout lines from the sandbox (blocking generator).

    If *message* is provided (a harness-native user input dict built via
    ``build_user_input``), writes it to stdin. Otherwise reconnects to the
    running sandbox's stdout (for mid-turn reconnects).

    Turn boundaries are detected from harness-native events using
    ``is_turn_done``. A synthetic ``turn.done`` event is emitted API-side
    for downstream SSE consumers (slackbot, web).
    """
    backend = get_backend()
    rt = _get_runtime(session.sandbox_id)

    if message is not None:
        backend.attach(session)
    else:
        # Reconnect: force fresh sockets
        backend.close_streams(session)
        backend.attach(session, logs=True)

    # Create a new queue for this turn and swap it in atomically
    turn_queue: queue.SimpleQueue[str | None] = queue.SimpleQueue()
    with rt.turn_lock:
        if message is not None:
            rt.turn_counter += 1
        turn_id = rt.turn_counter
        rt.active_turn_id = turn_id
        old_queue = rt.active_queue
        rt.active_queue = turn_queue

    # Signal old turn to stop
    if old_queue is not None:
        old_queue.put(None)

    _ensure_reader(session)

    t0 = time.monotonic()
    rt.busy = True
    rt.last_result = None
    log.info(
        "turn_start",
        thread_key=session.thread_key,
        sandbox=session.sandbox_id[:12],
        harness=session.harness,
        turn_id=turn_id,
    )

    if message is not None:
        try:
            backend.write_stdin(session, message)
        except (BrokenPipeError, OSError) as exc:
            log.warning("stdin_broken_pipe", sandbox=session.sandbox_id[:12], error=str(exc))
            st = backend.status(session)
            if st != "running":
                raise RuntimeError(f"sandbox exited (status={st})") from exc
            # Stale sockets — close, re-attach, restart reader, and retry.
            backend.close_streams(session)
            backend.attach(session)
            turn_queue = queue.SimpleQueue()
            with rt.turn_lock:
                rt.active_queue = turn_queue
            _ensure_reader(session, force=True)
            backend.write_stdin(session, message)

    first_output = False
    done_seen = 0
    agent_thread_id: str | None = None
    last_result: str | None = None
    while True:
        line = turn_queue.get()
        if line is None:
            rt.busy = False
            if message is not None and done_seen == 0:
                yield json.dumps({
                    "type": "error",
                    "message": "Sandbox container exited unexpectedly before completing the turn.",
                })
            log.info(
                "turn_done",
                thread_key=session.thread_key,
                sandbox=session.sandbox_id[:12],
                harness=session.harness,
                turn_id=turn_id,
                duration_s=round(time.monotonic() - t0, 2),
                reason="eof",
            )
            return
        if not first_output:
            first_output = True
            log.info(
                "turn_first_output",
                thread_key=session.thread_key,
                sandbox=session.sandbox_id[:12],
                harness=session.harness,
                turn_id=turn_id,
                elapsed_s=round(time.monotonic() - t0, 2),
            )
        yield line
        try:
            evt = json.loads(line)
            # Track agent thread ID from init events
            tid = extract_thread_id(session.engine, evt)
            if tid:
                agent_thread_id = tid
            # Track result text
            r = extract_result(session.engine, evt)
            if r is not None:
                last_result = r
            # Detect turn completion from harness-native events
            if is_turn_done(session.engine, evt):
                done_seen += 1
                if done_seen <= skip_done_count:
                    continue
                rt.busy = False
                rt.last_result = last_result
                # Synthesize turn.done for downstream consumers
                yield json.dumps({
                    "type": "turn.done",
                    "turn_id": turn_id,
                    "result": last_result or "",
                    "agent_thread_id": agent_thread_id or "",
                })
                log.info(
                    "turn_done",
                    thread_key=session.thread_key,
                    sandbox=session.sandbox_id[:12],
                    harness=session.harness,
                    turn_id=turn_id,
                    duration_s=round(time.monotonic() - t0, 2),
                    reason="completed",
                )
                return
        except (json.JSONDecodeError, TypeError):
            pass


async def _stop_async(thread_key: str) -> bool:
    """Stop sandbox and update DB. Returns True if stopped."""
    session = await _db_get_session(thread_key)
    if not session:
        return False

    rt = _runtime.get(session.sandbox_id)
    if rt is not None and rt.active_queue is not None:
        rt.active_queue.put(None)

    _drop_runtime(session.sandbox_id)

    backend = get_backend()
    await asyncio.to_thread(backend.stop, session)
    await _db_update_state(thread_key, "stopped")
    log.info("pipe_session_stopped", thread_key=thread_key)
    return True


async def _get_status_async(thread_key: str) -> dict[str, Any]:
    """Check if a session/sandbox is alive."""
    session = await _db_get_session(thread_key)
    if not session:
        return {"thread_key": thread_key, "status": "not_found"}
    backend = get_backend()
    st = await asyncio.to_thread(backend.status, session)
    if st == "gone":
        await _db_update_state(thread_key, "gone")
        return {"thread_key": thread_key, "status": "gone"}
    rt = _runtime.get(session.sandbox_id)
    result: dict[str, Any] = {
        "thread_key": thread_key,
        "status": st,
        "sandbox_id": session.sandbox_id[:12],
        "harness": session.harness,
        "engine": session.engine,
        "started_at": session.started_at,
    }
    if rt:
        result["busy"] = rt.busy
        if rt.last_result is not None:
            result["last_result"] = rt.last_result
    return result


# ── Async bridge ─────────────────────────────────────────────────────────────


async def _async_stream(gen_fn, *args) -> AsyncIterator[str]:
    """Bridge a blocking generator to an async iterator via asyncio.to_thread."""
    q: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _run() -> None:
        try:
            for line in gen_fn(*args):
                loop.call_soon_threadsafe(q.put_nowait, line)
        except Exception as exc:
            loop.call_soon_threadsafe(
                q.put_nowait,
                json.dumps({"type": "error", "message": str(exc)}),
            )
        finally:
            loop.call_soon_threadsafe(q.put_nowait, None)

    task = asyncio.ensure_future(asyncio.to_thread(_run))
    try:
        while True:
            item = await q.get()
            if item is None:
                break
            yield item
    finally:
        if not task.done():
            task.cancel()


# ── Async public API ─────────────────────────────────────────────────────────


async def get_or_spawn(
    thread_key: str,
    harness: str = "amp",
    *,
    engine: str | None = None,
) -> SandboxSession:
    """Get existing session or spawn a new sandbox.

    Tries (in order): DB session → warm pool → cold spawn.
    """
    session = await _db_get_session(thread_key)
    if session:
        if session.db_state in _REUSABLE_DB_STATES:
            backend = get_backend()
            st = await asyncio.to_thread(backend.status, session)
            if st == "running":
                _get_runtime(session.sandbox_id)
                return session
            # DB points at a reusable session but the container is gone — clean up.
            await _db_delete_session(thread_key)
            _drop_runtime(session.sandbox_id)
        else:
            # state is stopped/gone/creating — clean up stale row
            await _db_delete_session(thread_key)
            _drop_runtime(session.sandbox_id)
            backend = get_backend()
            await asyncio.to_thread(backend.stop_by_id, session.sandbox_id)

    # Resolve harness profile (engine, persona, repo) once for both warm and cold paths
    resolved_engine, persona, repo = _resolve_harness_profile(harness, engine_override=engine)

    # Try warm pool first
    if not engine:
        from api.warm_pool import claim_container

        claimed = await asyncio.to_thread(
            claim_container, thread_key, harness, persona=persona, repo=repo
        )
        if claimed:
            won = await _db_insert_session(claimed, harness=claimed.harness, engine=claimed.engine)
            if won:
                _get_runtime(claimed.sandbox_id)
                return claimed

    session = await asyncio.to_thread(
        _spawn_sync, thread_key, harness, engine_override=engine
    )

    # INSERT into sandbox_sessions — race-safe
    won = await _db_insert_session(session, harness=session.harness, engine=session.engine)
    if not won:
        # Another request won the race — stop our container, return the winner
        log.warning("spawn_race_lost", thread_key=thread_key, sandbox=session.sandbox_id[:12])
        backend = get_backend()
        await asyncio.to_thread(backend.stop_by_id, session.sandbox_id)
        _drop_runtime(session.sandbox_id)
        winner = await _db_get_session(thread_key)
        if winner is None:
            raise RuntimeError(f"spawn race: winner row vanished for {thread_key}")
        _get_runtime(winner.sandbox_id)
        return winner

    return session


async def stream_reconnect(
    session: SandboxSession, *, skip_done_count: int = 0
) -> AsyncIterator[str]:
    """Async wrapper for reconnecting to a running sandbox's stdout.

    *skip_done_count*: number of ``turn.done`` events to skip before treating
    one as terminal.  The slackbot sets this to 1 when reconnecting after a
    follow=true handoff so that the old turn's ``turn.done`` (replayed from
    container stdout history) is passed through and the followed thread's
    output is streamed.
    """

    def _reconnect():
        return _stream_turn(session, skip_done_count=skip_done_count)

    async for line in _async_stream(_reconnect):
        yield line


def _build_session_context(
    thread_key: str,
    *,
    platform: str | None = None,
    user_id: str | None = None,
) -> str:
    """Build session context to append to the system prompt.

    Contains metadata (time, thread, platform) and platform-specific formatting
    rules so the agent produces output suitable for the target platform.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "# Session Context",
        "",
        f"- **Date/Time**: {now} UTC",
        f"- **Thread ID**: {thread_key}",
    ]
    if platform:
        lines.append(f"- **Platform**: {platform}")

    if platform and platform.lower() == "slack":
        lines.extend([
            "",
            "## Slack Formatting Rules",
            "",
            "- Use standard markdown links `[Display Text](URL)` for hyperlinks",
            "- Do NOT use Slack-native `<URL|text>` link syntax",
            "- Preserve Slack user mentions (`<@UXXXXXXX>`) exactly as-is — only use these for actual Slack users",
            "- For Twitter/X handles, link to the profile WITHOUT an @ prefix in the display text: `[handle](https://x.com/handle)` (NOT `[@handle](...)`)",
            "- Prefer concise, well-structured markdown; long replies may be split across multiple Slack messages",
            "- Markdown tables are allowed and may render as native Slack tables when the structure is clean",
            "- NEVER put links/URLs inside code blocks (``` ```) — they won't be clickable. Use markdown tables or plain text with `[text](url)` links instead",
        ])
        if user_id:
            lines.append(
                f"- After completing a long task, tag the requester with their real Slack mention: <@{user_id}>"
            )

    lines.extend(["", "---", ""])
    return "\n".join(lines)


async def stream_exec(
    session: SandboxSession,
    message: str | list,
    *,
    platform: str | None = None,
    user_id: str | None = None,
) -> AsyncIterator[str]:
    """Run a turn in the sandbox by flushing pending messages from chat_messages.

    The flush pipeline:
    1. Insert system context message on first turn (idempotent)
    2. Fetch undelivered messages via _flush_pending
    3. Flatten into content blocks via messages_to_content_blocks
    4. Build harness-native input via build_user_input
    5. Stream the turn and yield stdout lines
    6. Advance the cursor on completion
    7. Persist the assistant response
    """
    await _db_update_state(session.thread_key, "running")
    started_at = time.monotonic()
    try:
        # Insert platform-specific system message into the transcript (idempotent)
        if platform:
            await _insert_system_message(session.thread_key, platform)

        # Flush pending messages from chat_messages
        last_delivered_id = await _get_last_delivered_id(session.thread_key)
        flushed = await _flush_pending(session.thread_key, last_delivered_id)

        # Build harness-native input
        if flushed:
            msgs = _flushed_to_messages(flushed)
            content_blocks = messages_to_content_blocks(msgs)
            turn_input = build_user_input(content_blocks)
            last_flushed_id = flushed[-1]["id"]
        elif isinstance(message, list):
            turn_input = build_user_input(message)
            last_flushed_id = None
        elif isinstance(message, str) and message:
            turn_input = build_user_input([{"type": "text", "text": message}])
            last_flushed_id = None
        else:
            turn_input = None
            last_flushed_id = None

        result_text = ""
        stream_failed = False
        async for line in _async_stream(_stream_turn, session, turn_input):
            yield line
            # Extract result text from turn.done events
            try:
                evt = json.loads(line)
                if evt.get("type") == "error":
                    stream_failed = True
                    result_text = ""
                elif evt.get("type") == "turn.done":
                    r = evt.get("result", "")
                    result_text = (
                        r if isinstance(r, str)
                        else r.get("text", "") if isinstance(r, dict)
                        else ""
                    )
            except (json.JSONDecodeError, TypeError):
                pass

        # Advance the cursor to the last flushed message
        if last_flushed_id and not stream_failed:
            await _advance_cursor(session.thread_key, last_flushed_id)

        # Persist assistant response (user messages already in chat_messages)
        await _persist_turn_messages(session.thread_key, "", result_text, session.harness)
        await _db_update_state(session.thread_key, "error" if stream_failed else "idle")
        record_agent_execution(
            harness=session.harness,
            status="error" if stream_failed else "completed",
            duration_s=time.monotonic() - started_at,
        )
    except Exception:
        await _db_update_state(session.thread_key, "error")
        record_agent_execution(
            harness=session.harness,
            status="error",
            duration_s=time.monotonic() - started_at,
        )
        raise


async def _persist_turn_messages(
    thread_key: str, user_text: str, assistant_text: str, harness: str
) -> None:
    """Persist assistant message to chat_messages after a turn completes.

    User messages are already in the transcript from POST /agent/messages.
    Only the assistant response needs to be written here.
    """
    try:
        pool = _get_pool()
        now_ms = int(time.time() * 1000)
        asst_id = f"turn-{thread_key}-{now_ms}"

        async with pool.acquire() as conn:
            if assistant_text:
                await conn.execute(
                    "INSERT INTO chat_messages (id, thread_key, role, parts, metadata) "
                    "VALUES ($1, $2, 'assistant', $3::jsonb, $4::jsonb) "
                    "ON CONFLICT (id) DO NOTHING",
                    asst_id,
                    thread_key,
                    json.dumps([{"type": "text", "text": assistant_text}]),
                    json.dumps({"harness": harness}),
                )
                await conn.execute(
                    "UPDATE sandbox_sessions SET thread_name = $1, updated_at = NOW() "
                    "WHERE thread_key = $2",
                    assistant_text[:60],
                    thread_key,
                )
    except Exception as exc:
        log.warning(
            "chat_messages_persist_failed",
            thread_key=thread_key,
            harness=harness,
            error=str(exc),
        )


async def stop_session(thread_key: str) -> bool:
    return await _stop_async(thread_key)


async def get_status(thread_key: str) -> dict[str, Any]:
    return await _get_status_async(thread_key)


async def list_undelivered(max_age_s: int = 300) -> list[dict[str, Any]]:
    """List threads that completed but may not have been delivered.

    Returns sessions in 'idle' state that haven't been updated recently,
    indicating the result may not have been picked up by a client.
    """
    pool = _get_pool()
    rows = await pool.fetch(
        "SELECT thread_key, sandbox_id, harness, engine, state, updated_at "
        "FROM sandbox_sessions "
        "WHERE state = 'idle' "
        "AND updated_at < NOW() - make_interval(secs => $1::double precision) "
        "ORDER BY updated_at DESC "
        "LIMIT 50",
        float(max_age_s),
    )
    return [
        {
            "thread_key": r["thread_key"],
            "sandbox_id": r["sandbox_id"][:12],
            "harness": r["harness"],
            "state": r["state"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in rows
    ]


async def claim_for_delivery(thread_key: str) -> bool:
    """Atomically claim an idle session for delivery.

    Uses a CAS update (state idle → delivering) so only one caller wins.
    Returns True if this caller won the race.
    """
    pool = _get_pool()
    result = await pool.execute(
        "UPDATE sandbox_sessions SET state = 'delivering', updated_at = NOW() "
        "WHERE thread_key = $1 AND state = 'idle'",
        thread_key,
    )
    return result == "UPDATE 1"


async def mark_delivered(thread_key: str) -> None:
    """Mark a thread as delivered so it won't appear in orphan checks."""
    pool = _get_pool()
    await pool.execute(
        "UPDATE sandbox_sessions SET state = 'idle', updated_at = NOW() "
        "WHERE thread_key = $1 AND state = 'delivering'",
        thread_key,
    )
