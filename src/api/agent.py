"""Agent sandbox — 1 Slack thread = 1 Docker container.

Manages container lifecycle and executes harness CLI commands (amp,
claude-code, codex) inside them. Returns the final result text.
"""

import codecs
import contextlib
import io
import json
import os
import re
import subprocess
import tarfile
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import docker
import httpx
import psycopg2
import psycopg2.extras
import structlog
from docker.errors import NotFound

from api.harness_events import normalize_harness_event
from shared.engineer.session import has_active_session as has_active_engineer_session
from shared.tool_sdk import _sm_read

log = structlog.get_logger()

HARNESSES = ("amp", "claude-code", "codex", "pi-mono")

# Max seconds of *idle* time (no output) before killing a hung exec.
# Active agents that keep producing output are never killed by this timeout.
EXEC_IDLE_TIMEOUT = int(os.getenv("AGENT_EXEC_IDLE_TIMEOUT", "600"))

# Number of pre-warmed containers to keep ready
POOL_SIZE = int(os.getenv("AGENT_POOL_SIZE", "0"))

_SLACK_POST_TIMEOUT_S = 20.0
_MAX_SLACK_MESSAGE_CHARS = 3800
_SLACK_TRUNCATED_SUFFIX = "\n\n... (truncated)"
_SLACK_POST_RETRY_ATTEMPTS = 3
_THREAD_NAME_MAX_CHARS = 60
_THREAD_CONTEXT_DELIMITER = "---"
_MAX_PENDING_CONTEXT_MESSAGES = 18
_MAX_PENDING_CONTEXT_CHARS = 6000
_CONTEXT_HEADER = (
    "Additional Slack thread context since the last AI instruction "
    "(ambient discussion from humans):"
)
_SLACK_MENTION_RE = re.compile(r"<@[^>]+>")
_PLAIN_MENTION_RE = re.compile(r"(?<!\w)@[A-Za-z0-9._-]+")


def _fetch_secret(key: str) -> str:
    """Fetch a secret from the secret manager. Returns empty string on failure."""
    return _sm_read(key) or ""


# In-memory session registry: slack_thread_key → session dict
_sessions: dict[str, dict[str, Any]] = {}
_sessions_lock = threading.RLock()
_execute_locks: dict[str, threading.Lock] = {}
_execute_locks_guard = threading.Lock()
_MAX_CONCURRENT_EXECUTIONS = max(1, int(os.getenv("AGENT_MAX_CONCURRENT_RUNS", "8")))
_MAX_CONCURRENT_EXECUTIONS_PER_ACTOR = max(
    1, int(os.getenv("AGENT_MAX_CONCURRENT_RUNS_PER_ACTOR", "2"))
)
_EXECUTION_QUEUE_WAIT_TIMEOUT_S = max(1.0, float(os.getenv("AGENT_EXEC_QUEUE_WAIT_TIMEOUT", "45")))
_exec_scheduler_cond = threading.Condition()
_exec_wait_queue: list[tuple[int, str, str]] = []
_exec_active_total = 0
_exec_active_by_actor: dict[str, int] = {}
_exec_ticket_counter = 0

# Active states that prevent engineer from overwriting a non-engineer session
_ACTIVE_SESSION_STATES = ("working", "idle", "running", "stopping")

# Graceful shutdown: set by the API lifespan on SIGTERM so active executions
# can break out of their streaming loops before DB pools are closed.
_shutdown_event = threading.Event()


def is_shutting_down() -> bool:
    return _shutdown_event.is_set()


def signal_shutdown() -> None:
    _shutdown_event.set()


def get_session_state(thread_key: str) -> dict[str, Any] | None:
    with _sessions_lock:
        return _sessions.get(thread_key)


def set_session_state(thread_key: str, session: dict[str, Any]) -> None:
    with _sessions_lock:
        _sessions[thread_key] = session


def pop_session_state(thread_key: str) -> dict[str, Any] | None:
    with _sessions_lock:
        return _sessions.pop(thread_key, None)


def session_items_snapshot() -> list[tuple[str, dict[str, Any]]]:
    with _sessions_lock:
        return list(_sessions.items())


def get_execute_lock(thread_key: str) -> threading.Lock:
    with _execute_locks_guard:
        lock = _execute_locks.get(thread_key)
        if lock is None:
            lock = threading.Lock()
            _execute_locks[thread_key] = lock
        return lock


def _execution_actor_key(user_id: str | None, source_tag: str, thread_key: str) -> str:
    normalized_user = str(user_id or "").strip()
    if normalized_user:
        return f"user:{normalized_user}"
    normalized_source = source_tag.strip() or "unknown"
    # Keep anonymous traffic reasonably partitioned by source + thread.
    return f"anon:{normalized_source}:{thread_key}"


def _acquire_execution_slot(
    *,
    actor_key: str,
    thread_key: str,
    timeout_s: float,
) -> tuple[bool, float, int]:
    """Fair queue with global + per-actor concurrency caps.

    Admission chooses the first *eligible* queued ticket so a capped actor at
    queue head does not block unrelated actors behind it.
    """
    global _exec_active_total, _exec_ticket_counter

    started_at = time.monotonic()
    with _exec_scheduler_cond:
        _exec_ticket_counter += 1
        ticket_id = _exec_ticket_counter
        _exec_wait_queue.append((ticket_id, actor_key, thread_key))
        initial_position = len(_exec_wait_queue) - 1

        while True:
            elapsed = time.monotonic() - started_at
            remaining = timeout_s - elapsed
            eligible_index: int | None = None
            if _exec_active_total < _MAX_CONCURRENT_EXECUTIONS:
                for idx, (_, queued_actor, _) in enumerate(_exec_wait_queue):
                    queued_actor_active = _exec_active_by_actor.get(queued_actor, 0)
                    if queued_actor_active < _MAX_CONCURRENT_EXECUTIONS_PER_ACTOR:
                        eligible_index = idx
                        break

            if (
                eligible_index is not None
                and _exec_wait_queue[eligible_index][0] == ticket_id
            ):
                _exec_wait_queue.pop(eligible_index)
                _exec_active_total += 1
                _exec_active_by_actor[actor_key] = _exec_active_by_actor.get(actor_key, 0) + 1
                return True, elapsed, initial_position

            if remaining <= 0:
                _exec_wait_queue[:] = [item for item in _exec_wait_queue if item[0] != ticket_id]
                _exec_scheduler_cond.notify_all()
                return False, elapsed, initial_position

            _exec_scheduler_cond.wait(timeout=remaining)


def _release_execution_slot(actor_key: str) -> None:
    global _exec_active_total
    with _exec_scheduler_cond:
        _exec_active_total = max(0, _exec_active_total - 1)
        actor_active = _exec_active_by_actor.get(actor_key, 0)
        if actor_active <= 1:
            _exec_active_by_actor.pop(actor_key, None)
        else:
            _exec_active_by_actor[actor_key] = actor_active - 1
        _exec_scheduler_cond.notify_all()


def _session_has_active_turn(session: dict[str, Any]) -> bool:
    turns = session.get("turns")
    if not isinstance(turns, list):
        return False
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if turn.get("finished_at") is None:
            return True
    return False


def reap_stale_running_sessions(
    stale_after_s: int = 600,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Mark stale `running` sessions as idle and prune orphaned sessions.

    Handles two cases:
    1. Sessions stuck in `running` state with no active turn and no recent activity.
    2. Sessions whose backing Docker container no longer exists.
    """
    checked = 0
    reaped: list[str] = []
    orphaned: list[str] = []
    current_ts = now_ts if now_ts is not None else time.time()

    try:
        client = _docker_client()
    except Exception:
        client = None

    for key, _ in session_items_snapshot():
        execute_lock = get_execute_lock(key)
        if not execute_lock.acquire(blocking=False):
            continue
        try:
            checked += 1
            with _sessions_lock:
                session = _sessions.get(key)
                if not session:
                    continue

                harness = session.get("harness", "")

                # Prune sessions whose container is gone (skip engineer — no container)
                if client and harness != "engineer":
                    container_id = session.get("container_id", "")
                    if container_id:
                        try:
                            container = client.containers.get(container_id)
                            if container.status not in ("running", "created"):
                                session["state"] = "stopped"
                                session["last_activity"] = current_ts
                                session_copy = dict(session)
                                _sessions.pop(key, None)
                                _persist_session(session_copy, key)
                                orphaned.append(key)
                                continue
                        except Exception:
                            session["state"] = "stopped"
                            session["last_activity"] = current_ts
                            session_copy = dict(session)
                            _sessions.pop(key, None)
                            _persist_session(session_copy, key)
                            orphaned.append(key)
                            continue

                # Reap stale running sessions
                if session.get("state") != "running":
                    continue
                if _session_has_active_turn(session):
                    continue
                try:
                    last_activity = float(session.get("last_activity"))
                except (TypeError, ValueError):
                    continue
                if current_ts - last_activity <= stale_after_s:
                    continue
                session["state"] = "idle"
                session["last_activity"] = current_ts
                session_to_persist = dict(session)
            _persist_session(session_to_persist, key)
            reaped.append(key)
        finally:
            execute_lock.release()

    if reaped or orphaned:
        log.info(
            "stale_running_sessions_reaped",
            reaped=len(reaped),
            orphaned=len(orphaned),
            reaped_keys=reaped,
            orphaned_keys=orphaned,
            stale_after_s=stale_after_s,
        )
    return {
        "checked": checked,
        "reaped": len(reaped),
        "orphaned": len(orphaned),
        "thread_keys": reaped + orphaned,
    }


def _normalize_thread_key(thread_key: str) -> str:
    raw = thread_key.strip()
    parts = raw.split(":")
    if len(parts) == 2 and parts[0] and parts[1]:
        return f"{parts[0]}:{parts[1]}"
    if len(parts) == 3 and parts[0].lower() == "slack" and parts[1] and parts[2]:
        return f"{parts[1]}:{parts[2]}"
    return raw


def _thread_key_aliases(thread_key: str) -> list[str]:
    aliases: list[str] = []
    raw = thread_key.strip()
    canonical = _normalize_thread_key(raw)
    for key in (raw, canonical):
        if key and key not in aliases:
            aliases.append(key)
    if canonical:
        channel, _, thread_ts = canonical.partition(":")
        if channel and thread_ts:
            slack_key = f"slack:{channel}:{thread_ts}"
            if slack_key not in aliases:
                aliases.append(slack_key)
    return aliases


def _slack_thread_parts(thread_key: str) -> tuple[str, str] | None:
    canonical = _normalize_thread_key(thread_key)
    channel, sep, thread_ts = canonical.partition(":")
    if not sep or not channel or not thread_ts:
        return None
    if channel[:1] not in {"C", "D", "G"}:
        return None
    if "." not in thread_ts:
        return None
    return channel, thread_ts


def _truncate_slack_message(text: str) -> str:
    safe_text = text.strip()
    if not safe_text:
        return ""
    if len(safe_text) <= _MAX_SLACK_MESSAGE_CHARS:
        return safe_text
    budget = _MAX_SLACK_MESSAGE_CHARS - len(_SLACK_TRUNCATED_SUFFIX)
    if budget <= 0:
        return _SLACK_TRUNCATED_SUFFIX[:_MAX_SLACK_MESSAGE_CHARS]
    return safe_text[:budget].rstrip() + _SLACK_TRUNCATED_SUFFIX


def _thread_name_from_user_message(raw_message: str) -> str | None:
    text = str(raw_message or "").strip()
    if not text:
        return None

    if _THREAD_CONTEXT_DELIMITER in text:
        text = text.split(_THREAD_CONTEXT_DELIMITER, 1)[1]

    text = _SLACK_MENTION_RE.sub(" ", text)
    text = _PLAIN_MENTION_RE.sub(" ", text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None

    first_line = re.sub(r"\s+", " ", lines[0]).strip()
    if not first_line:
        return None
    return first_line[:_THREAD_NAME_MAX_CHARS].rstrip() or None


def _slack_retry_after_s(response: httpx.Response) -> float:
    retry_after = response.headers.get("Retry-After", "").strip()
    try:
        parsed = float(retry_after)
    except ValueError:
        return 1.0
    return max(1.0, min(parsed, 30.0))


def _post_to_slack(
    thread_key: str,
    text: str,
    *,
    event_prefix: str,
    warn_on_error: bool,
) -> None:
    token = _fetch_secret("SLACK_BOT_TOKEN").strip()
    if not token:
        return
    parts = _slack_thread_parts(thread_key)
    if parts is None:
        return
    channel, thread_ts = parts
    safe_text = _truncate_slack_message(text)
    if not safe_text:
        return
    logger = log.warning if warn_on_error else log.debug
    try:
        with httpx.Client(timeout=_SLACK_POST_TIMEOUT_S) as client:
            for attempt in range(_SLACK_POST_RETRY_ATTEMPTS):
                resp = client.post(
                    "https://slack.com/api/chat.postMessage",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"channel": channel, "thread_ts": thread_ts, "text": safe_text},
                )

                if resp.status_code == 429 and attempt + 1 < _SLACK_POST_RETRY_ATTEMPTS:
                    time.sleep(_slack_retry_after_s(resp))
                    continue

                if resp.status_code >= 300:
                    logger(
                        f"{event_prefix}_failed",
                        thread=thread_key,
                        status=resp.status_code,
                        body=resp.text[:200],
                    )
                    return

                try:
                    data = resp.json()
                except Exception:
                    logger(
                        f"{event_prefix}_invalid_json",
                        thread=thread_key,
                        body=resp.text[:200],
                    )
                    return

                if data.get("ok"):
                    return

                error = str(data.get("error") or "unknown_error")
                if error == "ratelimited" and attempt + 1 < _SLACK_POST_RETRY_ATTEMPTS:
                    time.sleep(_slack_retry_after_s(resp))
                    continue

                logger(
                    f"{event_prefix}_rejected",
                    thread=thread_key,
                    error=error,
                )
                return
    except Exception as exc:
        logger(f"{event_prefix}_exception", thread=thread_key, error=str(exc))


def _post_slack_thread_message(thread_key: str, text: str) -> None:
    _post_to_slack(
        thread_key=thread_key,
        text=text,
        event_prefix="slack_mirror",
        warn_on_error=True,
    )


def _post_to_slack_sync(thread_key: str, text: str) -> None:
    """Post a message to a Slack thread. Best-effort, never raises."""
    _post_to_slack(
        thread_key=thread_key,
        text=text,
        event_prefix="slack_post",
        warn_on_error=False,
    )


def _extract_turn_user_id(events: list[dict[str, Any]]) -> str | None:
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "")
        if event_type in {"thread.user", "thread.message"}:
            user_id = str(event.get("user_id") or "").strip()
            if user_id:
                return user_id
    return None


def _display_user_message(message: str) -> str:
    """Return user-visible text without system context blocks."""
    text = message.strip()
    if not text:
        return ""
    context_idx = text.find(_CONTEXT_HEADER)
    if context_idx >= 0:
        text = text[:context_idx].rstrip()
        if text.endswith(_THREAD_CONTEXT_DELIMITER):
            text = text[: -len(_THREAD_CONTEXT_DELIMITER)].rstrip()
    if "# Session Context" in text and _THREAD_CONTEXT_DELIMITER in text:
        tail = text.rsplit(_THREAD_CONTEXT_DELIMITER, 1)[-1].strip()
        if tail:
            return tail
    if _THREAD_CONTEXT_DELIMITER in text:
        head = text.split(_THREAD_CONTEXT_DELIMITER, 1)[0].strip()
        if head:
            text = head
    return text


def _find_session_for_thread(thread_key: str) -> tuple[str, dict[str, Any]] | None:
    for candidate in _thread_key_aliases(thread_key):
        session = get_session_state(candidate)
        if session:
            return candidate, session
    return None


def _context_line(source: str | None, user_id: str | None, text: str) -> str:
    compact = " ".join(text.split()).strip()
    if not compact:
        return ""
    if len(compact) > 300:
        compact = compact[:297].rstrip() + "..."
    source_tag = str(source or "").strip()
    author = str(user_id or "").strip()
    prefix_parts: list[str] = []
    if author:
        prefix_parts.append(f"<@{author}>")
    if source_tag:
        prefix_parts.append(f"[{source_tag}]")
    if prefix_parts:
        return f"- {' '.join(prefix_parts)}: {compact}"
    return f"- {compact}"


def _format_pending_context_block(items: list[dict[str, Any]]) -> str:
    if not items:
        return ""
    lines = [
        _context_line(
            str(item.get("source") or ""),
            str(item.get("user_id") or ""),
            str(item.get("text") or ""),
        )
        for item in items
    ]
    filtered = [line for line in lines if line]
    if not filtered:
        return ""
    block = _CONTEXT_HEADER + "\n" + "\n".join(filtered[-_MAX_PENDING_CONTEXT_MESSAGES:])
    if len(block) > _MAX_PENDING_CONTEXT_CHARS:
        block = block[: _MAX_PENDING_CONTEXT_CHARS - 18].rstrip() + "\n- ... (truncated)"
    return block


def record_thread_message(
    thread_key: str,
    text: str,
    *,
    message_type: str,
    source: str | None = None,
    user_id: str | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    normalized_text = text.strip()
    if not normalized_text:
        return {"status": "ignored_empty", "thread_key": _normalize_thread_key(thread_key)}

    found = _find_session_for_thread(thread_key)
    if not found:
        return {"status": "no_active_session", "thread_key": _normalize_thread_key(thread_key)}

    canonical_key, session = found
    normalized_source = str(source or "unknown").strip().lower() or "unknown"
    normalized_user_id = str(user_id or "").strip() or None
    normalized_message_id = str(message_id or "").strip() or None

    with _sessions_lock:
        turns = session.setdefault("turns", [])
        if not turns:
            return {"status": "no_active_session", "thread_key": canonical_key}
        target_turn = turns[-1]
        events = target_turn.setdefault("events", [])
        if not isinstance(events, list):
            events = []
            target_turn["events"] = events

        if normalized_message_id:
            for event in events:
                if not isinstance(event, dict):
                    continue
                if (
                    event.get("type") == "thread.message"
                    and str(event.get("message_id") or "").strip() == normalized_message_id
                ):
                    return {
                        "status": "duplicate",
                        "thread_key": canonical_key,
                        "message_id": normalized_message_id,
                    }

        event_payload: dict[str, Any] = {
            "type": "thread.message",
            "message_type": message_type,
            "source": normalized_source,
            "text": normalized_text,
            "created_at": datetime.now(UTC).isoformat(),
        }
        if normalized_user_id:
            event_payload["user_id"] = normalized_user_id
        if normalized_message_id:
            event_payload["message_id"] = normalized_message_id
        events.append(event_payload)

        if message_type == "context":
            queue = session.setdefault("pending_context_messages", [])
            if not isinstance(queue, list):
                queue = []
                session["pending_context_messages"] = queue
            queue.append(
                {
                    "text": normalized_text,
                    "source": normalized_source,
                    "user_id": normalized_user_id,
                    "message_id": normalized_message_id,
                }
            )
            if len(queue) > _MAX_PENDING_CONTEXT_MESSAGES:
                session["pending_context_messages"] = queue[-_MAX_PENDING_CONTEXT_MESSAGES:]

        session["last_activity"] = time.time()

    _persist_turn(canonical_key, target_turn)
    _persist_session(session, canonical_key)
    return {
        "status": "accepted",
        "thread_key": canonical_key,
        "message_id": normalized_message_id,
        "message_type": message_type,
    }


def drain_pending_context_messages(thread_key: str) -> list[dict[str, Any]]:
    found = _find_session_for_thread(thread_key)
    if not found:
        return []
    _, session = found
    with _sessions_lock:
        pending = session.get("pending_context_messages")
        if not isinstance(pending, list) or not pending:
            return []
        items = [item for item in pending if isinstance(item, dict)]
        session["pending_context_messages"] = []
    return items


def has_active_non_engineer_session(thread_key: str) -> tuple[bool, str | None]:
    """Return (True, harness) if an active non-engineer session would be overwritten."""
    for candidate in _thread_key_aliases(thread_key):
        session = get_session_state(candidate)
        if not session:
            continue
        harness = session.get("harness")
        if harness == "engineer":
            continue
        if harness not in HARNESSES:
            continue
        state = session.get("state", "")
        if state not in _ACTIVE_SESSION_STATES:
            continue
        return (True, harness)
    return (False, None)


# Pool of pre-warmed, unclaimed containers (LIFO)
_pool: list[str] = []  # container IDs
_pool_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Postgres persistence (best-effort — never breaks Docker operations)
# ---------------------------------------------------------------------------
def _pg_conn():
    """Create a Postgres connection. Returns None if DATABASE_URL not set."""
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return None
    return psycopg2.connect(url, connect_timeout=3)


def _pg_write(sql: str, params: tuple = ()) -> None:
    """Execute a single write against Postgres. Silently skips on failure."""
    try:
        conn = _pg_conn()
        if not conn:
            return
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        log.debug("pg_write_failed", error=str(exc))


def _pg_read(sql: str, params: tuple = ()) -> list[dict]:
    """Execute a read query. Returns list of dicts. Empty list on failure."""
    try:
        conn = _pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                return [dict(row) for row in cur.fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        log.debug("pg_read_failed", error=str(exc))
        return []


def _ts(epoch: float) -> datetime:
    return datetime.fromtimestamp(epoch, tz=UTC)


def _persist_session(session: dict[str, Any], key: str) -> None:
    _pg_write(
        """
        INSERT INTO agent_sessions
            (slack_thread_key, container_id, harness, agent_thread_id,
             state, created_at, last_activity, thread_name)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (slack_thread_key) DO UPDATE SET
            container_id    = EXCLUDED.container_id,
            harness         = EXCLUDED.harness,
            agent_thread_id = EXCLUDED.agent_thread_id,
            state           = EXCLUDED.state,
            last_activity   = EXCLUDED.last_activity,
            thread_name     = EXCLUDED.thread_name
        """,
        (
            key,
            session["container_id"],
            session["harness"],
            session.get("agent_thread_id"),
            session["state"],
            _ts(session["created_at"]),
            _ts(session["last_activity"]),
            session.get("thread_name"),
        ),
    )


def _extract_artifacts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract file artifacts (uploads, screenshots) from turn events.

    Two-pass: first collect tool_use inputs with content_base64 keyed by
    tool_use id, then match with tool results to build complete artifacts
    that include the raw file data.
    """
    # Pass 1: index upload tool_use inputs by id
    uploads_by_id: dict[str, dict[str, Any]] = {}
    for evt in events:
        if not isinstance(evt, dict) or evt.get("type") != "assistant":
            continue
        message = evt.get("message")
        if not isinstance(message, dict):
            continue
        for block in message.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            inp = block.get("input") or {}
            if not isinstance(inp, dict):
                continue
            if inp.get("content_base64") or inp.get("file_path"):
                uploads_by_id[block.get("id", "")] = {
                    "content_base64": inp.get("content_base64", ""),
                    "filename": inp.get("filename", ""),
                    "comment": inp.get("comment", ""),
                }

    # Pass 2: match tool results with upload inputs
    artifacts = []
    for evt in events:
        if not isinstance(evt, dict) or evt.get("type") not in ("tool", "user"):
            continue
        for block in evt.get("content") or []:
            if not isinstance(block, dict):
                continue
            tool_use_id = block.get("tool_use_id", "")
            if tool_use_id not in uploads_by_id:
                continue
            # Parse the result text for permalink/metadata
            raw_content = block.get("content", "")
            text = ""
            if isinstance(raw_content, list):
                for sub in raw_content:
                    if isinstance(sub, dict) and sub.get("type") == "text":
                        text += sub.get("text", "")
            elif isinstance(raw_content, str):
                text = raw_content
            try:
                result = json.loads(text) if text.strip().startswith("{") else {}
            except (json.JSONDecodeError, ValueError):
                result = {}
            upload_input = uploads_by_id[tool_use_id]
            artifacts.append(
                {
                    "type": "file",
                    "filename": (
                        result.get("name")
                        or result.get("filename")
                        or upload_input.get("filename", "")
                    ),
                    "permalink": result.get("permalink", ""),
                    "comment": upload_input.get("comment", ""),
                    "content_base64": upload_input.get("content_base64", ""),
                    "timestamp": evt.get("received_at", ""),
                }
            )
    return artifacts


def _persist_turn(key: str, turn: dict[str, Any]) -> None:
    events_json = json.dumps(turn.get("events", []), default=str)
    artifacts = _extract_artifacts(turn.get("events", []))
    artifacts_json = json.dumps(artifacts, default=str)
    _pg_write(
        """
        INSERT INTO agent_turns
            (slack_thread_key, turn_id, user_message, events, result,
             started_at, finished_at, exit_code, timed_out, duration_s, artifacts)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (slack_thread_key, turn_id) DO UPDATE SET
            events      = EXCLUDED.events,
            result      = EXCLUDED.result,
            finished_at = EXCLUDED.finished_at,
            exit_code   = EXCLUDED.exit_code,
            timed_out   = EXCLUDED.timed_out,
            duration_s  = EXCLUDED.duration_s,
            artifacts   = EXCLUDED.artifacts
        """,
        (
            key,
            turn["turn_id"],
            turn["user_message"],
            events_json,
            turn["result"],
            _ts(turn["started_at"]),
            _ts(turn["finished_at"]) if turn.get("finished_at") else None,
            turn.get("exit_code"),
            turn.get("timed_out", False),
            turn.get("duration_s", 0),
            artifacts_json,
        ),
    )


def _delete_session(key: str) -> None:
    _pg_write("DELETE FROM agent_sessions WHERE slack_thread_key = %s", (key,))


def _docker_client() -> docker.DockerClient:
    return docker.from_env()


def _wait_ready(container: Any, timeout: int = 15) -> float:
    """Wait for the entrypoint to signal readiness (touch ~/.ready).

    Returns the number of seconds waited.
    """
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        exit_code, _ = container.exec_run(["test", "-f", "/home/agent/.ready"], demux=False)
        if exit_code == 0:
            return round(time.monotonic() - t0, 3)
        time.sleep(0.1)
    log.warning("container_ready_timeout", timeout=timeout)
    return round(time.monotonic() - t0, 3)


def _image() -> str:
    return os.getenv("AGENT_IMAGE", "agent2:latest")


def _repos_host_dir() -> str:
    return os.getenv("REPOS_HOST_DIR", os.path.expanduser("~/github"))


def _create_container(
    client: Any,
    name: str | None = None,
    repo: str | None = None,
    extra_labels: dict[str, str] | None = None,
    slack_thread_key: str | None = None,
) -> tuple[Any, dict[str, float]]:
    """Create a ready-to-use agent container.

    Returns (container, timings_dict).
    """
    t0 = time.monotonic()
    workdir = "/home/agent/workspace" if repo else "/home/agent/github"
    env = _container_env()
    if repo:
        env.append(f"AGENT_REPO={repo}")
    if slack_thread_key:
        parts = _slack_thread_parts(slack_thread_key)
        if parts:
            env.append(f"SLACK_CHANNEL={parts[0]}")
            env.append(f"SLACK_THREAD_TS={parts[1]}")
    labels = {
        "agent2": "true",
        **({"ai2.pool": "true"} if not name else {}),
        **(extra_labels or {}),
    }
    volumes = {
        _repos_host_dir(): {"bind": "/home/agent/github", "mode": "ro"},
    }
    # When a repo is specified, the entrypoint creates a writable worktree
    # from the read-only bare repo.  Mount just that repo rw so git worktree
    # can write back (lock files, refs).  Everything else stays read-only.
    if repo:
        repo_host_path = os.path.join(_repos_host_dir(), repo)
        if os.path.isdir(repo_host_path):
            volumes[repo_host_path] = {"bind": f"/home/agent/github/{repo}", "mode": "rw"}
    vol = os.getenv("FIREWALL_CERTS_VOLUME", "firewall-certs")
    volumes[vol] = {"bind": "/firewall-certs", "mode": "ro"}
    container = client.containers.run(
        _image(),
        detach=True,
        stdin_open=True,
        tty=False,
        network_mode=os.getenv("AGENT_NETWORK", "ai_v2_default"),
        mem_limit="4g",
        nano_cpus=int(2 * 1e9),
        environment=env,
        working_dir=workdir,
        volumes=volumes,
        labels=labels,
        **({"name": name} if name else {}),
    )
    docker_run_s = round(time.monotonic() - t0, 3)
    wait_ready_s = _wait_ready(container)
    return container, {"docker_run_s": docker_run_s, "wait_ready_s": wait_ready_s}


def _claim_from_pool() -> Any | None:
    """Try to claim a pre-warmed container from the pool."""
    with _pool_lock:
        while _pool:
            cid = _pool.pop()
            try:
                client = _docker_client()
                container = client.containers.get(cid)
                if container.status == "running":
                    # Remove pool label so it won't be reclaimed
                    return container
            except Exception:
                continue
    return None


def _refill_pool() -> None:
    """Top up the pool in a background thread."""
    import threading as _threading

    def _fill() -> None:
        with _pool_lock:
            needed = POOL_SIZE - len(_pool)
        if needed <= 0:
            return
        client = _docker_client()
        for _ in range(needed):
            try:
                container, _timings = _create_container(client)
                with _pool_lock:
                    _pool.append(container.id)
                log.info("pool_container_added", pool_size=len(_pool), **_timings)
            except Exception as exc:
                log.warning("pool_fill_failed", error=str(exc))
                break

    _threading.Thread(target=_fill, daemon=True).start()


def _sm_list_keys() -> list[str]:
    """Fetch all available secret key names from the secret manager."""
    url = os.environ.get("SECRET_MANAGER_URL", "http://secrets:8100")
    try:
        resp = httpx.get(f"{url}/keys", timeout=5.0)
        if resp.status_code == 200:
            return resp.json().get("keys", [])
    except Exception:
        log.warning("failed to fetch secret keys from secret manager")
    return []


# Env var name → secret manager key name, for cases where they differ.
_SECRET_OVERRIDES: dict[str, str] = {}


def _container_env() -> list[str]:
    """Build env vars for sandbox containers.

    Containers never receive real API keys.  The firewall proxy
    intercepts outgoing HTTPS and replaces key-name placeholders in
    header values with real secrets.  We set every known secret as
    ``KEY=KEY`` (the key name *is* the placeholder value) so harness
    CLIs use API-key auth flows instead of interactive/browser login.

    Use ``_SECRET_OVERRIDES`` to remap an env var to a different secret
    manager key (e.g. ``GITHUB_TOKEN`` → ``SVC_PARADIGM_GITHUB_TOKEN``).
    """
    firewall_host = os.getenv("FIREWALL_HOST", "firewall")

    env = [
        f"AI_V2_API_URL={os.getenv('AGENT_API_URL', 'http://api:8000')}",
        f"AI_V2_API_KEY={_fetch_secret('API_SECRET_KEY')}",
    ]

    # Pull in every secret from the secret manager as KEY=KEY placeholders.
    seen: set[str] = set()
    for key in _sm_list_keys():
        env_name = key
        env_value = _SECRET_OVERRIDES.get(key, key)
        env.append(f"{env_name}={env_value}")
        seen.add(env_name)

    # Apply overrides for env var names that don't exist as secret keys
    # (i.e. the override target is a different key name).
    for env_name, secret_key in _SECRET_OVERRIDES.items():
        if env_name not in seen:
            env.append(f"{env_name}={secret_key}")

    env.extend([
        f"HTTPS_PROXY=http://{firewall_host}:8080",
        f"HTTP_PROXY=http://{firewall_host}:8080",
        f"https_proxy=http://{firewall_host}:8080",
        f"http_proxy=http://{firewall_host}:8080",
        "NO_PROXY=api,localhost,127.0.0.1",
        "no_proxy=api,localhost,127.0.0.1",
        "NODE_EXTRA_CA_CERTS=/firewall-certs/ca-cert.pem",
        "REQUESTS_CA_BUNDLE=/firewall-certs/ca-cert.pem",
        "SSL_CERT_FILE=/firewall-certs/ca-cert.pem",
        "GIT_SSL_CAINFO=/firewall-certs/ca-cert.pem",
    ])

    return env


def _build_command(harness: str, message: str, thread_id: str | None) -> list[str]:
    if harness == "claude-code":
        return [
            "claude",
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "--verbose",
            *(["--session-id", thread_id] if thread_id else []),
            "-p",
            message,
        ]
    if harness == "codex":
        return [
            "codex",
            "exec",
            "--json",
            "--full-auto",
            "--skip-git-repo-check",
            *(["resume", thread_id] if thread_id else []),
            message,
        ]
    if harness == "pi-mono":
        return [
            "pi",
            "--mode",
            "json",
            *(["--session", thread_id] if thread_id else []),
            message,
        ]
    # Default: amp
    return [
        "amp",
        "--no-ide",
        "--no-notifications",
        "--dangerously-allow-all",
        "--stream-json",
        *(["threads", "continue", thread_id] if thread_id else []),
        "-x",
        message,
    ]


def _extract_result(
    raw_lines: list[str], harness: str, stderr_lines: list[str] | None = None
) -> tuple[str, str | None]:
    """Parse JSON-line output from a harness CLI.

    Returns (result_text, agent_thread_id).
    """
    result_text = ""
    agent_thread_id: str | None = None

    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Codex normalization
        if harness == "codex":
            etype = event.get("type", "")
            if etype == "thread.started":
                agent_thread_id = event.get("thread_id")
            elif etype == "item.completed":
                item = event.get("item", {})
                if item.get("type") == "agent_message":
                    result_text = item.get("text", result_text)
            elif etype == "turn.completed":
                # Some codex versions bundle items in turn.completed
                for item in event.get("items", []):
                    if item.get("type") == "agent_message":
                        result_text = item.get("text", result_text)
            elif etype == "error":
                result_text = f"❌ {event.get('message', 'Unknown error')}"
            continue

        # Pi-mono normalization
        if harness == "pi-mono":
            etype = event.get("type", "")
            if etype == "session":
                agent_thread_id = event.get("id")
            elif etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for part in msg.get("content", []):
                        if isinstance(part, dict) and part.get("type") == "text":
                            result_text = part.get("text", result_text)
                        elif isinstance(part, str):
                            result_text = part
            elif etype == "agent_end":
                for msg in event.get("messages", []):
                    if msg.get("role") == "assistant":
                        for part in msg.get("content", []):
                            if isinstance(part, dict) and part.get("type") == "text":
                                result_text = part.get("text", result_text)
                            elif isinstance(part, str):
                                result_text = part
            continue

        # Amp / claude-code format
        etype = event.get("type", "")
        if etype == "system" and event.get("subtype") == "init":
            agent_thread_id = event.get("session_id")
        elif etype == "result":
            result_text = event.get("result", result_text)
        elif etype == "assistant" and event.get("message", {}).get("content"):
            for part in event["message"]["content"]:
                if part.get("type") == "text" and part.get("text"):
                    result_text = part["text"]
        elif etype == "error":
            result_text = f"❌ {event.get('error', 'Unknown error')}"

    # Fallback: if no structured output found, use last non-empty stderr
    if not result_text and stderr_lines:
        # Strip ANSI escape codes before surfacing stderr
        ansi_re = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>]?[0-9]*[A-Za-z]?")
        tail = [ansi_re.sub("", line).strip() for line in stderr_lines[-10:]]
        tail = [line for line in tail if line]
        if tail:
            result_text = "❌ Agent produced no output. Stderr:\n" + "\n".join(tail)

    return result_text, agent_thread_id


def _download_files_to_container(
    container: Any,
    files: list[dict[str, str]],
) -> list[str]:
    """Download files and copy them into the container.

    Returns list of in-container paths for successfully copied files.
    """
    upload_dir = "/home/agent/uploads"
    container.exec_run(["mkdir", "-p", upload_dir])

    slack_token = _fetch_secret("SLACK_BOT_TOKEN")
    paths: list[str] = []

    for f in files:
        url = f["url"]
        name = f["name"]
        headers: dict[str, str] = {}
        if "slack" in url and slack_token:
            headers["Authorization"] = f"Bearer {slack_token}"

        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                resp = client.get(url, headers=headers)
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "")
                if "text/html" in content_type:
                    log.warning(
                        "file_download_got_html",
                        url=url,
                        name=name,
                        hint="Bot may be missing files:read scope",
                    )
                    continue
                data = resp.content
        except Exception as exc:
            log.warning("file_download_failed", url=url, error=str(exc))
            continue

        # Build a tar archive in memory and put_archive into container
        tar_buf = io.BytesIO()
        with tarfile.open(fileobj=tar_buf, mode="w") as tar:
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        tar_buf.seek(0)
        container.put_archive(upload_dir, tar_buf)

        dest = f"{upload_dir}/{name}"
        paths.append(dest)
        log.info("file_copied", name=name, size=len(data), dest=dest)

    return paths


class AgentClient:
    """Manage Docker sandbox containers for agent harness execution."""

    def spawn(
        self,
        slack_thread_key: str,
        harness: str = "amp",
        repo: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Spawn a new sandbox container for a Slack thread.

        Args:
            slack_thread_key: Unique thread ID (e.g. "C04ABC:1234567890.123456")
            harness: Agent CLI to use — amp, claude-code, or codex
            repo: Optional repo path to set as working directory
            request_id: Correlation ID for end-to-end latency tracing
        """
        rid = request_id or ""
        log.info("spawn_start", request_id=rid, thread=slack_thread_key, harness=harness)

        if harness not in HARNESSES:
            raise RuntimeError(f"Unknown harness: {harness}. Use one of {HARNESSES}")

        # Reuse existing container if alive
        existing = get_session_state(slack_thread_key)
        if existing:
            if existing.get("harness") == "engineer":
                return {
                    "session_id": slack_thread_key,
                    "container_id": existing["container_id"],
                    "status": "already_running",
                    "harness": existing["harness"],
                }
            try:
                client = _docker_client()
                container = client.containers.get(existing["container_id"])
                if container.status == "running":
                    log.info(
                        "spawn_done",
                        request_id=rid,
                        thread=slack_thread_key,
                        status="already_running",
                    )
                    return {
                        "session_id": slack_thread_key,
                        "container_id": existing["container_id"],
                        "status": "already_running",
                        "harness": existing["harness"],
                    }
                container.start()
                existing["state"] = "running"
                log.info("spawn_done", request_id=rid, thread=slack_thread_key, status="restarted")
                return {
                    "session_id": slack_thread_key,
                    "container_id": existing["container_id"],
                    "status": "restarted",
                    "harness": existing["harness"],
                }
            except NotFound:
                pop_session_state(slack_thread_key)

        # Try to claim a pre-warmed container from the pool (skip if repo needed)
        container = None
        status = "started"
        if not repo:
            container = _claim_from_pool()
            if container:
                status = "claimed_from_pool"
                log.info("spawn_pool_claimed", request_id=rid, thread=slack_thread_key)

        # Otherwise create a new one
        if not container:
            log.info("spawn_creating_container", request_id=rid, thread=slack_thread_key)
            client = _docker_client()
            container, create_timings = _create_container(
                client,
                name=f"agent2-{slack_thread_key.replace(':', '-').replace('.', '-')[:40]}",
                repo=repo,
                extra_labels={
                    "ai2.thread": slack_thread_key,
                    "ai2.harness": harness,
                },
                slack_thread_key=slack_thread_key,
            )
            log.info(
                "spawn_container_created", request_id=rid, thread=slack_thread_key, **create_timings
            )

        # Refill pool in background after claiming
        _refill_pool()

        session = {
            "container_id": container.id,
            "harness": harness,
            "agent_thread_id": None,
            "state": "running",
            "created_at": time.time(),
            "last_activity": time.time(),
            "turns": [],
            "pending_context_messages": [],
            "thread_name": None,
        }
        set_session_state(slack_thread_key, session)
        _persist_session(session, slack_thread_key)

        log.info("spawn_done", request_id=rid, thread=slack_thread_key, status=status)
        return {
            "session_id": slack_thread_key,
            "container_id": container.id,
            "status": status,
            "harness": harness,
        }

    def pool(self) -> dict[str, Any]:
        """Show pool status and trigger a refill if needed."""
        with _pool_lock:
            pool_size = len(_pool)
        _refill_pool()
        return {"pool_size": pool_size, "target": POOL_SIZE}

    def execute(
        self,
        slack_thread_key: str,
        message: str,
        harness: str = "amp",
        source: str | None = None,
        repo: str | None = None,
        request_id: str | None = None,
        files: list[dict[str, str]] | None = None,
        emit: Callable[[dict[str, Any]], None] | None = None,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute a message in a sandbox, spawning one if needed.

        Runs the harness CLI via docker exec, waits for completion,
        and returns the final result text. If *emit* is provided, progress
        events are streamed to the caller in real-time.
        """
        _emit = emit or (lambda _: None)
        rid = request_id or ""
        source_tag = str(source or "api").strip().lower()
        display_message = _display_user_message(message) or message.strip()
        mirror_to_slack = source_tag in {"thread_ui", "thread-view", "ui"}
        actor_key = _execution_actor_key(user_id, source_tag, slack_thread_key)
        slot_acquired = False
        execute_lock = get_execute_lock(slack_thread_key)
        if not execute_lock.acquire(blocking=False):
            return {
                "error": "A run is already in progress for this thread. Wait for it to finish first."
            }

        try:
            if has_active_engineer_session(slack_thread_key):
                return {
                    "error": (
                        "Active engineer session in progress for this thread. "
                        "Complete or stop it before running harness execution."
                    )
                }
            session = get_session_state(slack_thread_key)
            if session and session.get("harness") == "engineer":
                return {
                    "error": (
                        "Active engineer session in progress for this thread. "
                        "Complete or stop it before running harness execution."
                    )
                }
            if session and session.get("state") == "working":
                return {
                    "error": "A run is already in progress for this thread. Wait for it to finish first."
                }

            slot_acquired, queue_wait_s, queue_position = _acquire_execution_slot(
                actor_key=actor_key,
                thread_key=slack_thread_key,
                timeout_s=_EXECUTION_QUEUE_WAIT_TIMEOUT_S,
            )
            if not slot_acquired:
                return {
                    "error": (
                        "Run queue is saturated right now. "
                        "Please retry in a few moments."
                    )
                }
            if queue_wait_s > 0.1:
                _emit(
                    {
                        "type": "status",
                        "stage": "scheduler.acquired",
                        "wait_s": round(queue_wait_s, 3),
                        "queue_position": queue_position + 1,
                    }
                )

            if mirror_to_slack:
                attributed_message = (
                    f"<@{user_id}>: {display_message}"
                    if str(user_id or "").strip()
                    else display_message
                )
                _post_slack_thread_message(
                    slack_thread_key,
                    "[via Thread Viewer] " + attributed_message,
                )

            # Auto-spawn if no session or container is gone
            if session:
                client = _docker_client()
                try:
                    container = client.containers.get(session["container_id"])
                except NotFound:
                    pop_session_state(slack_thread_key)
                    session = None

            if not session:
                # Re-check right before spawn to avoid racing engineer startup.
                if has_active_engineer_session(slack_thread_key):
                    return {
                        "error": (
                            "Active engineer session in progress for this thread. "
                            "Complete or stop it before running harness execution."
                        )
                    }
                log.info("exec_auto_spawn", request_id=rid, thread=slack_thread_key)
                _emit({"type": "status", "stage": "container.creating"})
                self.spawn(slack_thread_key, harness, repo, request_id)
                _emit({"type": "status", "stage": "container.ready"})
                session = get_session_state(slack_thread_key)
                if session is None:
                    return {"error": "Failed to initialize agent session after spawn."}
                client = _docker_client()
                container = client.containers.get(session["container_id"])

            # Download and copy files into the container
            if files:
                _emit({"type": "status", "stage": "files.downloading", "count": len(files)})
                file_paths = _download_files_to_container(container, files)
                if file_paths:
                    listing = "\n".join(f"- {p}" for p in file_paths)
                    message = f"{message}\n\nAttached files (already downloaded to the container):\n{listing}"
            pending_context = _format_pending_context_block(
                drain_pending_context_messages(slack_thread_key)
            )
            command_message = message
            if pending_context:
                command_message = (
                    f"{message.rstrip()}\n\n{_THREAD_CONTEXT_DELIMITER}\n{pending_context}"
                )

            cmd = _build_command(session["harness"], command_message, session["agent_thread_id"])

            started_ts = time.time()
            with _sessions_lock:
                session["state"] = "working"
                session["last_activity"] = started_ts
            _persist_session(session, slack_thread_key)
            log.info(
                "exec_start",
                request_id=rid,
                thread=slack_thread_key,
                harness=session["harness"],
            )

            # Create the turn on the session immediately so SSE can stream it live
            live_turn: dict[str, Any] = {
                "turn_id": len(session.get("turns", [])) + 1,
                "user_message": display_message,
                "events": [],
                "result": "",
                "user_id": user_id,
                "started_at": started_ts,
                "finished_at": None,
                "exit_code": None,
                "timed_out": False,
                "duration_s": 0,
            }
            live_turn["events"].append(
                {
                    "type": "thread.message",
                    "message_type": "command",
                    "source": source_tag or "api",
                    "text": display_message,
                    "created_at": datetime.now(UTC).isoformat(),
                    **({"user_id": user_id} if user_id else {}),
                }
            )
            with _sessions_lock:
                session.setdefault("turns", []).append(live_turn)

            # Use low-level exec API for streaming
            api = client.api
            exec_id = api.exec_create(
                container.id,
                cmd,
                stdout=True,
                stderr=True,
            )["Id"]

            _emit({"type": "status", "stage": "exec.start", "harness": session["harness"]})
            output = api.exec_start(exec_id, stream=True, demux=True)

            # Collect stdout and stderr separately
            stdout_decoder = codecs.getincrementaldecoder("utf-8")("replace")
            stderr_decoder = codecs.getincrementaldecoder("utf-8")("replace")
            lines: list[str] = []
            stderr_lines: list[str] = []
            buf = ""
            err_buf = ""
            timed_out = False
            first_output_logged = False
            started = time.monotonic()
            last_output_at = started

            for stdout_chunk, stderr_chunk in output:
                if _shutdown_event.is_set():
                    log.warning("agent_exec_shutdown", thread=slack_thread_key)
                    # Clear thread ID so next execution starts fresh
                    # instead of trying to continue a corrupted session
                    with _sessions_lock:
                        session["agent_thread_id"] = None
                    break
                if time.monotonic() - last_output_at > EXEC_IDLE_TIMEOUT:
                    timed_out = True
                    log.warning(
                        "agent_exec_idle_timeout",
                        thread=slack_thread_key,
                        idle_timeout=EXEC_IDLE_TIMEOUT,
                        total_elapsed=round(time.monotonic() - started, 1),
                    )
                    break
                if stdout_chunk or stderr_chunk:
                    last_output_at = time.monotonic()
                if stdout_chunk:
                    if not first_output_logged:
                        first_output_logged = True
                        log.info(
                            "exec_first_output",
                            request_id=rid,
                            thread=slack_thread_key,
                            elapsed_s=round(time.monotonic() - started, 3),
                        )
                    buf += stdout_decoder.decode(stdout_chunk)
                    while "\n" in buf:
                        idx = buf.index("\n")
                        line = buf[:idx]
                        lines.append(line)
                        buf = buf[idx + 1 :]
                        # Append event to live turn in real-time for SSE
                        stripped = line.strip()
                        if stripped:
                            now = datetime.now(UTC).isoformat()
                            elapsed = round(time.monotonic() - started, 3)
                            try:
                                evt = json.loads(stripped)
                                if isinstance(evt, dict):
                                    normalized_events = normalize_harness_event(
                                        session["harness"], evt
                                    )
                                    if not normalized_events:
                                        normalized_events = [evt]
                                    for normalized in normalized_events:
                                        normalized["received_at"] = now
                                        normalized["elapsed_s"] = elapsed
                                        live_turn["events"].append(normalized)
                                        _emit(normalized)
                                else:
                                    live_turn["events"].append(
                                        {
                                            "type": "raw",
                                            "text": stripped,
                                            "received_at": now,
                                            "elapsed_s": elapsed,
                                        }
                                    )
                            except json.JSONDecodeError:
                                live_turn["events"].append(
                                    {
                                        "type": "raw",
                                        "text": stripped,
                                        "received_at": now,
                                        "elapsed_s": elapsed,
                                    }
                                )
                if stderr_chunk:
                    err_buf += stderr_decoder.decode(stderr_chunk)
                    while "\n" in err_buf:
                        idx = err_buf.index("\n")
                        stderr_lines.append(err_buf[:idx])
                        err_buf = err_buf[idx + 1 :]

            # Flush remaining buffers
            if buf.strip():
                lines.append(buf)
                stripped = buf.strip()
                now = datetime.now(UTC).isoformat()
                elapsed = round(time.monotonic() - started, 3)
                try:
                    evt = json.loads(stripped)
                    if isinstance(evt, dict):
                        normalized_events = normalize_harness_event(session["harness"], evt)
                        if not normalized_events:
                            normalized_events = [evt]
                        for normalized in normalized_events:
                            normalized["received_at"] = now
                            normalized["elapsed_s"] = elapsed
                            live_turn["events"].append(normalized)
                            _emit(normalized)
                    else:
                        live_turn["events"].append(
                            {
                                "type": "raw",
                                "text": stripped,
                                "received_at": now,
                                "elapsed_s": elapsed,
                            }
                        )
                except json.JSONDecodeError:
                    live_turn["events"].append(
                        {"type": "raw", "text": stripped, "received_at": now, "elapsed_s": elapsed}
                    )
            if err_buf.strip():
                stderr_lines.append(err_buf)

            # If timed out, kill the exec process
            if timed_out:
                with contextlib.suppress(Exception):
                    container.exec_run(["pkill", "-TERM", "-f", session["harness"]], detach=True)

            # Check exec exit code
            exit_code = api.exec_inspect(exec_id).get("ExitCode")

            result_text, agent_thread_id = _extract_result(lines, session["harness"], stderr_lines)

            if timed_out and not result_text:
                elapsed_total = round(time.monotonic() - started)
                result_text = (
                    f"❌ Agent appears hung — no output for {EXEC_IDLE_TIMEOUT}s"
                    f" (ran for {elapsed_total}s total)."
                )
            elif exit_code and exit_code != 0 and not result_text:
                result_text = f"❌ Agent exited with code {exit_code}."
                if stderr_lines:
                    tail = "\n".join(stderr_lines[-5:])
                    result_text += f"\n```\n{tail}\n```"

            if agent_thread_id:
                with _sessions_lock:
                    session["agent_thread_id"] = agent_thread_id

            # Finalize the live turn
            live_turn["result"] = result_text
            live_turn["finished_at"] = time.time()
            live_turn["exit_code"] = exit_code
            live_turn["timed_out"] = timed_out
            live_turn["duration_s"] = round(time.time() - started_ts, 1)

            # Persist to PG in background
            _persist_turn(slack_thread_key, live_turn)

            with _sessions_lock:
                if live_turn["turn_id"] == 1 and not str(session.get("thread_name") or "").strip():
                    suggested_name = _thread_name_from_user_message(
                        str(live_turn.get("user_message") or "")
                    )
                    if suggested_name:
                        session["thread_name"] = suggested_name
                stop_requested = session.get("state") == "stopping"
                if stop_requested:
                    session["state"] = "stopped"
                    if not result_text.strip():
                        live_turn["result"] = "Stopped by user."
                        result_text = live_turn["result"]
                elif timed_out or (exit_code not in (0, None)):
                    session["state"] = "error"
                else:
                    session["state"] = "idle"
                session["last_activity"] = time.time()
            _persist_session(session, slack_thread_key)
            # Compute per-turn LLM stats from events
            llm_calls = 0
            total_input_tokens = 0
            total_output_tokens = 0
            for evt in live_turn["events"]:
                usage = None
                if isinstance(evt, dict):
                    message = evt.get("message")
                    if isinstance(message, dict):
                        usage = message.get("usage")
                    if usage is None:
                        usage = evt.get("usage")
                if usage:
                    usage_dict = usage if isinstance(usage, dict) else {}
                    llm_calls += 1
                    total_input_tokens += (
                        int(usage_dict.get("input_tokens", 0))
                        + int(usage_dict.get("cached_input_tokens", 0))
                        + int(usage_dict.get("cache_read_input_tokens", 0))
                        + int(usage_dict.get("cache_creation_input_tokens", 0))
                    )
                    total_output_tokens += int(usage_dict.get("output_tokens", 0))
            log.info(
                "exec_done",
                request_id=rid,
                thread=slack_thread_key,
                harness=session["harness"],
                exit_code=exit_code,
                timed_out=timed_out,
                duration_s=live_turn["duration_s"],
                result_len=len(result_text),
                llm_calls=llm_calls,
                total_input_tokens=total_input_tokens,
                total_output_tokens=total_output_tokens,
                event_count=len(live_turn["events"]),
            )

            result = {
                "session_id": slack_thread_key,
                "result": result_text,
                "agent_thread_id": session["agent_thread_id"],
                "harness": session["harness"],
            }
            if mirror_to_slack and result_text:
                _post_slack_thread_message(
                    slack_thread_key,
                    "[via Thread Viewer] Agent update:\n" + result_text,
                )
            _emit({"type": "final", **result})
            return result
        finally:
            if slot_acquired:
                _release_execution_slot(actor_key)
            execute_lock.release()

    def status(self, slack_thread_key: str | None = None) -> dict[str, Any]:
        """Get session status. If no key given, list all sessions."""
        if slack_thread_key:
            session = get_session_state(slack_thread_key)
            if not session:
                return {"error": f"No session for '{slack_thread_key}'"}
            return {
                "session_id": slack_thread_key,
                **session,
            }

        sessions = session_items_snapshot()
        return {
            "sessions": [{"session_id": k, **v} for k, v in sessions],
            "count": len(sessions),
        }

    def stop(self, slack_thread_key: str) -> dict[str, Any]:
        """Stop and remove a sandbox container."""
        session = get_session_state(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}
        if session.get("harness") == "engineer":
            # Engineer runs are in-process asyncio tasks, not Docker containers. @todo: move it.
            from shared.engineer.session import remove_session

            remove_session(slack_thread_key)
            pop_session_state(slack_thread_key)
            _delete_session(slack_thread_key)
            return {"session_id": slack_thread_key, "status": "stopped"}

        client = _docker_client()
        try:
            container = client.containers.get(session["container_id"])
            # Clean up git worktree before removing the container
            repo = container.labels.get("ai2.repo", "")
            if repo:
                repos_dir = _repos_host_dir()
                repo_path = os.path.join(repos_dir, repo)
                if os.path.isdir(repo_path):
                    subprocess.run(
                        ["git", "-C", repo_path, "worktree", "prune"],
                        capture_output=True,
                        timeout=10,
                    )
            container.stop(timeout=5)
            container.remove()
        except Exception:
            pass

        pop_session_state(slack_thread_key)
        _delete_session(slack_thread_key)
        return {"session_id": slack_thread_key, "status": "stopped"}

    def threads(self) -> dict[str, Any]:
        """List all agent threads with summary info for the thread viewer."""
        result = []
        for key, session in session_items_snapshot():
            turns = session.get("turns", [])
            result.append(
                {
                    "slack_thread_key": key,
                    "container_id": session["container_id"][:12],
                    "harness": session["harness"],
                    "agent_thread_id": session.get("agent_thread_id"),
                    "state": session["state"],
                    "created_at": session["created_at"],
                    "last_activity": session["last_activity"],
                    "turn_count": len(turns),
                    "last_result": turns[-1]["result"][:200] if turns else "",
                }
            )
        return {"threads": result, "count": len(result)}

    def thread_detail(self, slack_thread_key: str) -> dict[str, Any]:
        """Get full event stream for a specific thread including all turns and tool calls."""
        session = get_session_state(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}
        return {
            "slack_thread_key": slack_thread_key,
            "container_id": session["container_id"][:12],
            "harness": session["harness"],
            "agent_thread_id": session.get("agent_thread_id"),
            "state": session["state"],
            "created_at": session["created_at"],
            "last_activity": session["last_activity"],
            "turns": session.get("turns", []),
        }

    def recover_sessions(self) -> dict[str, Any]:
        """Recover sessions from Postgres and reconcile with live Docker state.

        Called on API startup to re-attach to containers that survived a restart.
        Also discovers labeled containers not yet in PG (belt-and-suspenders).
        """
        recovered = 0
        pruned = 0

        # 1. Load active sessions from Postgres
        rows = _pg_read("SELECT * FROM agent_sessions WHERE state NOT IN ('stopped')")
        client = _docker_client()

        for row in rows:
            key = row["slack_thread_key"]
            if get_session_state(key):
                continue

            harness = row.get("harness", "amp")
            if harness == "engineer":
                # Engineer sessions use run_id as container_id, not a Docker container.
                # They cannot be resumed; leave PG state as-is (idle/error).
                continue

            container_id = row["container_id"]
            try:
                container = client.containers.get(container_id)
                if container.status != "running":
                    _pg_write(
                        "UPDATE agent_sessions SET state = 'stopped' WHERE slack_thread_key = %s",
                        (key,),
                    )
                    pruned += 1
                    continue
            except (NotFound, Exception):
                _pg_write(
                    "UPDATE agent_sessions SET state = 'stopped' WHERE slack_thread_key = %s",
                    (key,),
                )
                pruned += 1
                continue

            # Load turns from PG
            turn_rows = _pg_read(
                "SELECT * FROM agent_turns WHERE slack_thread_key = %s ORDER BY turn_id",
                (key,),
            )
            turns = []
            for tr in turn_rows:
                events = tr.get("events", [])
                if isinstance(events, str):
                    events = json.loads(events)
                started = tr.get("started_at")
                finished = tr.get("finished_at")
                turns.append(
                    {
                        "turn_id": tr["turn_id"],
                        "user_message": tr["user_message"],
                        "events": events,
                        "result": tr.get("result", ""),
                        "user_id": _extract_turn_user_id(events),
                        "started_at": started.timestamp() if started else time.time(),
                        "finished_at": finished.timestamp() if finished else None,
                        "exit_code": tr.get("exit_code"),
                        "timed_out": tr.get("timed_out", False),
                        "duration_s": tr.get("duration_s", 0),
                    }
                )

            created = row.get("created_at")
            last_act = row.get("last_activity")
            recovered_session = {
                "container_id": container_id,
                "harness": row.get("harness", "amp"),
                "agent_thread_id": row.get("agent_thread_id"),
                "state": "idle",
                "created_at": created.timestamp() if created else time.time(),
                "last_activity": last_act.timestamp() if last_act else time.time(),
                "turns": turns,
                "pending_context_messages": [],
                "thread_name": row.get("thread_name"),
            }
            set_session_state(key, recovered_session)
            recovered += 1
            log.info("session_recovered", thread=key, turns=len(turns))

        # 2. Discover labeled containers not in PG (e.g. PG write failed)
        try:
            containers = client.containers.list(filters={"label": "agent2=true"})
            for container in containers:
                key = container.labels.get("ai2.thread", "")
                if key and not get_session_state(key):
                    recovered_session = {
                        "container_id": container.id,
                        "harness": container.labels.get("ai2.harness", "amp"),
                        "agent_thread_id": None,
                        "state": "idle",
                        "created_at": time.time(),
                        "last_activity": time.time(),
                        "turns": [],
                        "pending_context_messages": [],
                        "thread_name": None,
                    }
                    set_session_state(key, recovered_session)
                    _persist_session(recovered_session, key)
                    recovered += 1
                    log.info("session_recovered_from_docker", thread=key)
        except Exception:
            pass

        log.info("session_recovery_complete", recovered=recovered, pruned=pruned)

        # 3. Mark interrupted sessions safely; do not auto-replay side-effecting work.
        interrupted = 0
        for row in rows:
            if row.get("state") != "working":
                continue
            key = row["slack_thread_key"]
            session = get_session_state(key)
            if not session:
                continue

            # Find the last unfinished turn
            incomplete = _pg_read(
                "SELECT * FROM agent_turns WHERE slack_thread_key = %s "
                "AND finished_at IS NULL ORDER BY turn_id DESC LIMIT 1",
                (key,),
            )
            if not incomplete:
                # No incomplete turn — just fix PG state
                _pg_write(
                    "UPDATE agent_sessions SET state = 'idle' WHERE slack_thread_key = %s",
                    (key,),
                )
                continue

            interrupted_turn = incomplete[0]
            interrupted_result = (
                "⚠️ Interrupted by API restart — automatic retry disabled. "
                "Please retry manually."
            )

            # Mark the interrupted turn as failed
            _pg_write(
                "UPDATE agent_turns SET finished_at = now(), result = %s, exit_code = -1 "
                "WHERE slack_thread_key = %s AND turn_id = %s AND finished_at IS NULL",
                (
                    interrupted_result,
                    key,
                    interrupted_turn["turn_id"],
                ),
            )
            # Also update the in-memory turn if present
            for t in session.get("turns", []):
                if t["turn_id"] == interrupted_turn["turn_id"] and not t.get("finished_at"):
                    t["result"] = interrupted_result
                    t["finished_at"] = time.time()
                    t["exit_code"] = -1

            session["state"] = "error"
            session["last_activity"] = time.time()
            _persist_session(session, key)
            log.info(
                "session_marked_interrupted",
                thread=key,
                harness=session.get("harness", "amp"),
                turn_id=interrupted_turn["turn_id"],
            )
            interrupted += 1

        if interrupted:
            log.info("session_restart_interrupt_marked", count=interrupted)

        return {"recovered": recovered, "pruned": pruned, "interrupted": interrupted}

    def interrupt(self, slack_thread_key: str) -> dict[str, Any]:
        """Interrupt the currently running command in a sandbox."""
        session = get_session_state(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}
        if session.get("harness") == "engineer":
            # Engineer has no signal-based interrupt; best-effort cancel equals stop.
            from shared.engineer.session import remove_session

            remove_session(slack_thread_key)
            pop_session_state(slack_thread_key)
            _delete_session(slack_thread_key)
            return {"session_id": slack_thread_key, "status": "interrupted"}

        previous_state = str(session.get("state") or "")
        if previous_state not in {"running", "working", "stopping"}:
            return {"error": "No running command to interrupt."}

        turn_to_persist: dict[str, Any] | None = None
        with _sessions_lock:
            session["state"] = "stopping"
            session["last_activity"] = time.time()
            turns = session.get("turns")
            if isinstance(turns, list) and turns:
                last_turn = turns[-1]
                if isinstance(last_turn, dict) and last_turn.get("finished_at") is None:
                    events = last_turn.setdefault("events", [])
                    if isinstance(events, list):
                        events.append(
                            {
                                "type": "status",
                                "stage": "interrupt.requested",
                                "source": "api",
                                "received_at": datetime.now(UTC).isoformat(),
                            }
                        )
                        turn_to_persist = dict(last_turn)
        _persist_session(session, slack_thread_key)
        if turn_to_persist is not None:
            _persist_turn(slack_thread_key, turn_to_persist)

        client = _docker_client()
        try:
            container = client.containers.get(session["container_id"])
            harness = session["harness"]
            target = {
                "amp": "amp",
                "claude-code": "claude",
                "codex": "codex",
                "pi-mono": "pi",
            }.get(harness, "amp")
            result = container.exec_run(["pkill", "-INT", "-f", target], detach=False)
            exit_code = result.exit_code if hasattr(result, "exit_code") else None
            if exit_code not in (0,):
                with _sessions_lock:
                    if session.get("state") == "stopping":
                        session["state"] = previous_state
                        session["last_activity"] = time.time()
                _persist_session(session, slack_thread_key)
                return {"error": f"No active {target} process to interrupt."}
        except NotFound:
            with _sessions_lock:
                if session.get("state") == "stopping":
                    session["state"] = previous_state
                    session["last_activity"] = time.time()
            _persist_session(session, slack_thread_key)
            return {"error": f"No active container for '{slack_thread_key}'"}
        except Exception as exc:
            with _sessions_lock:
                if session.get("state") == "stopping":
                    session["state"] = previous_state
                    session["last_activity"] = time.time()
            _persist_session(session, slack_thread_key)
            return {"error": f"Failed to interrupt run: {exc}"}

        return {"session_id": slack_thread_key, "status": "interrupted"}


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
_agent: AgentClient | None = None


def get_agent() -> AgentClient:
    global _agent
    if _agent is None:
        _agent = AgentClient()
        if POOL_SIZE > 0:
            _refill_pool()
    return _agent
