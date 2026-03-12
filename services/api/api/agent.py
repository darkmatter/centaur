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

from api.sandbox.base import RuntimeState, SandboxSession
from api.sandbox.registry import get_backend

log = structlog.get_logger()

_ENGINE_HARNESSES = {"amp", "claude-code", "codex", "pi-mono"}

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
    message: str | None = None,
    *,
    logs: bool = False,
):
    """Stream stdout lines from the sandbox (blocking generator).

    If *message* is provided, sends a turn.start first. Otherwise just
    reconnects to the running sandbox's stdout (for mid-turn reconnects).

    A single reader thread reads stdout and dispatches lines to the active
    turn's queue. When a new turn starts, the old queue gets a None sentinel.
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
            backend.write_stdin(
                session, {"type": "turn.start", "turn_id": turn_id, "text": message}
            )
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
            backend.write_stdin(
                session, {"type": "turn.start", "turn_id": turn_id, "text": message}
            )

    first_output = False
    while True:
        line = turn_queue.get()
        if line is None:
            rt.busy = False
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
            if evt.get("type") == "turn.done" and (
                message is None or evt.get("turn_id") == turn_id
            ):
                rt.busy = False
                rt.last_result = evt.get("result")
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
        if session.db_state == "running":
            backend = get_backend()
            st = await asyncio.to_thread(backend.status, session)
            if st == "running":
                _get_runtime(session.sandbox_id)
                return session
            # DB says running but container is gone — clean up
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


async def stream_reconnect(session: SandboxSession) -> AsyncIterator[str]:
    """Async wrapper for reconnecting to a running sandbox's stdout."""
    async for line in _async_stream(_stream_turn, session):
        yield line


async def stream_exec(session: SandboxSession, message: str) -> AsyncIterator[str]:
    """Run a command in the sandbox and yield raw stdout lines."""
    result_text = ""
    async for line in _async_stream(_stream_turn, session, message):
        yield line
        # Extract result text from turn.done events
        try:
            evt = json.loads(line)
            if evt.get("type") == "turn.done":
                r = evt.get("result", "")
                result_text = r if isinstance(r, str) else r.get("text", "") if isinstance(r, dict) else ""
            elif evt.get("type") == "result" and isinstance(evt.get("text"), str):
                result_text = evt["text"]
        except (json.JSONDecodeError, TypeError):
            pass

    # Persist after stream completes (async context — safe to use asyncpg)
    await _persist_turn_messages(session.thread_key, message, result_text, session.harness)


async def _persist_turn_messages(
    thread_key: str, user_text: str, assistant_text: str, harness: str
) -> None:
    """Persist user + assistant messages to chat_messages after a turn completes."""
    try:
        pool = _get_pool()
        now_ms = int(time.time() * 1000)
        user_id = f"turn-{thread_key}-{now_ms}"
        asst_id = f"turn-{thread_key}-{now_ms + 1}"

        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO chat_messages (id, thread_key, role, parts, metadata) "
                "VALUES ($1, $2, 'user', $3::jsonb, '{}'::jsonb) "
                "ON CONFLICT (id) DO NOTHING",
                user_id,
                thread_key,
                json.dumps([{"type": "text", "text": user_text}]),
            )
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
                # Update thread_name on sandbox_sessions
                await conn.execute(
                    "UPDATE sandbox_sessions SET thread_name = $1, updated_at = NOW() "
                    "WHERE thread_key = $2",
                    assistant_text[:60],
                    thread_key,
                )
    except Exception:
        pass  # Best-effort — don't break the stream


async def stop_session(thread_key: str) -> bool:
    return await _stop_async(thread_key)


async def get_status(thread_key: str) -> dict[str, Any]:
    return await _get_status_async(thread_key)
