"""Thread viewer API.

Live threads are streamed from in-memory sessions via SSE.
Historical/completed threads are read from Postgres.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from starlette.responses import RedirectResponse, StreamingResponse

from api.agent import get_session_state, record_thread_message, session_items_snapshot
from api.deps import get_pool, verify_ui_or_api_key

router = APIRouter(
    prefix="/api/threads",
    tags=["threads"],
    dependencies=[Depends(verify_ui_or_api_key)],
)

_THREAD_CONTEXT_DELIMITER = "---"
_CONTEXT_HEADER = (
    "Additional Slack thread context since the last AI instruction "
    "(ambient discussion from humans):"
)


def _raw_item_call_digest(item: dict[str, Any]) -> str:
    """Build a stable digest for tool-call identity fallback."""
    name = str(
        item.get("tool") or item.get("name") or item.get("tool_name") or item.get("type") or "tool"
    )
    payload = item.get("arguments") or item.get("input") or item.get("args")
    stable_input: dict[str, Any] = {}
    if isinstance(payload, dict):
        stable_input = payload
    elif isinstance(payload, str):
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                stable_input = parsed
        except Exception:
            stable_input = {}

    if stable_input:
        fingerprint_source = json.dumps(
            {"name": name, "input": stable_input}, sort_keys=True, default=str
        )
    else:
        command = str(item.get("command") or "")
        fingerprint_source = f"{name}:{command}"
    return hashlib.sha1(fingerprint_source.encode("utf-8")).hexdigest()[:12]


def _raw_item_call_id(
    item: dict[str, Any],
    turn_id: int,
    *,
    event_type: str = "",
    event_index: int = 0,
    pending_ids: dict[tuple[int, str], list[str]] | None = None,
    call_counters: dict[tuple[int, str], int] | None = None,
) -> str:
    for key in ("id", "tool_call_id", "toolCallId", "tool_use_id", "toolUseId", "call_id"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    digest = _raw_item_call_digest(item)
    if pending_ids is None or call_counters is None:
        return f"turn-{turn_id}-item-{digest}"

    queue_key = (turn_id, digest)
    if event_type == "item.started":
        call_counters[queue_key] = call_counters.get(queue_key, 0) + 1
        call_id = f"turn-{turn_id}-item-{digest}-{call_counters[queue_key]}"
        pending_ids.setdefault(queue_key, []).append(call_id)
        return call_id

    if event_type in {"item.updated", "item.completed"}:
        queued = pending_ids.get(queue_key)
        if queued:
            call_id = queued[0]
            if event_type == "item.completed":
                queued.pop(0)
                if not queued:
                    pending_ids.pop(queue_key, None)
            return call_id

    # No matching start event seen for this connection (e.g. live_only attach mid-run).
    return f"turn-{turn_id}-item-{digest}-e{event_index}"


def _build_participants_from_turns(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for turn in turns:
        user_ids: list[str] = []
        explicit_user_id = str(turn.get("user_id") or "").strip()
        if explicit_user_id:
            user_ids.append(explicit_user_id)
        events = turn.get("events")
        if isinstance(events, list):
            user_ids.extend(_extract_turn_user_ids(events))
        for user_id in user_ids:
            if user_id not in seen:
                seen[user_id] = {"id": user_id, "name": user_id, "avatar_url": None}
    return list(seen.values())


async def _enrich_participants(
    pool: asyncpg.Pool,
    participants: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not participants:
        return []
    ids = [str(p.get("id") or "").strip() for p in participants]
    ids = [item for item in ids if item]
    if not ids:
        return participants

    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (external_id)
            external_id,
            data
        FROM raw_records
        WHERE source = 'slack'
          AND kind = 'user'
          AND external_id = ANY($1::text[])
        ORDER BY external_id, fetched_at DESC
        """,
        ids,
    )
    by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        data = row["data"] if isinstance(row["data"], dict) else {}
        profile = data.get("profile") if isinstance(data.get("profile"), dict) else {}
        display_name = (
            profile.get("display_name")
            or profile.get("real_name")
            or data.get("real_name")
            or data.get("name")
            or row["external_id"]
        )
        avatar_url = profile.get("image_48") or profile.get("image_72") or profile.get("image_24")
        by_id[str(row["external_id"])] = {
            "name": str(display_name),
            "avatar_url": str(avatar_url) if avatar_url else None,
        }

    enriched: list[dict[str, Any]] = []
    for participant in participants:
        pid = str(participant.get("id") or "").strip()
        details = by_id.get(pid)
        if not details:
            enriched.append(participant)
            continue
        enriched.append(
            {**participant, "name": details["name"], "avatar_url": details["avatar_url"]}
        )
    return enriched


def _extract_turn_user_ids(events: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "")
        if event_type not in {"thread.user", "thread.message"}:
            continue
        user_id = str(event.get("user_id") or "").strip()
        if user_id and user_id not in seen:
            seen.append(user_id)
    return seen


def _build_live_detail(key: str, session: dict[str, Any]) -> dict[str, Any]:
    """Build thread detail from an in-memory session."""
    turns = session.get("turns", [])
    participants = session.get("participants")
    if not isinstance(participants, list) or len(participants) == 0:
        participants = _build_participants_from_turns(turns)
    return {
        "slack_thread_key": key,
        "container_id": session["container_id"][:12],
        "harness": session["harness"],
        "agent_thread_id": session.get("agent_thread_id"),
        "state": session["state"],
        "created_at": session["created_at"],
        "last_activity": session["last_activity"],
        "turns": turns,
        "thread_name": session.get("thread_name"),
        "participants": participants,
    }


class ContextMessageAttachment(BaseModel):
    name: str
    url: str


class ContextMessageRequest(BaseModel):
    thread_key: str
    text: str
    source: str | None = None
    user_id: str | None = None
    message_id: str | None = None
    attachments: list[ContextMessageAttachment] = []


def _latest_command_message_event(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    for event in reversed(events):
        if not isinstance(event, dict):
            continue
        if event.get("type") != "thread.message":
            continue
        if str(event.get("message_type") or "") != "command":
            continue
        return event
    return None


def _display_user_message(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        return ""
    context_idx = cleaned.find(_CONTEXT_HEADER)
    if context_idx >= 0:
        cleaned = cleaned[:context_idx].rstrip()
        if cleaned.endswith(_THREAD_CONTEXT_DELIMITER):
            cleaned = cleaned[: -len(_THREAD_CONTEXT_DELIMITER)].rstrip()
    if "# Session Context" in cleaned and _THREAD_CONTEXT_DELIMITER in cleaned:
        tail = cleaned.rsplit(_THREAD_CONTEXT_DELIMITER, 1)[-1].strip()
        if tail:
            return tail
    if _THREAD_CONTEXT_DELIMITER in cleaned:
        cleaned = cleaned.split(_THREAD_CONTEXT_DELIMITER, 1)[0].strip()
    return cleaned


def _user_message_preview(text: str, *, max_chars: int = 200) -> str:
    cleaned = _display_user_message(text)
    if not cleaned:
        cleaned = text.strip()
    compact = " ".join(cleaned.split())
    return compact[:max_chars]


def _turn_user_message_key(turn_id: int) -> str:
    return f"{turn_id}:user-message"


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
            s.thread_name,
            extract(epoch from s.created_at)    AS created_at,
            extract(epoch from s.last_activity) AS last_activity,
            coalesce(tc.turn_count, 0)          AS turn_count,
            coalesce(lt.result, '')              AS last_result,
            coalesce(ft.first_message, '')       AS first_message,
            coalesce(lm.last_user_message, '')   AS last_user_message
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
        LEFT JOIN LATERAL (
            SELECT t.user_message AS first_message
            FROM agent_turns t
            WHERE t.slack_thread_key = s.slack_thread_key
            ORDER BY t.turn_id ASC LIMIT 1
        ) ft ON true
        LEFT JOIN LATERAL (
            SELECT t.user_message AS last_user_message
            FROM agent_turns t
            WHERE t.slack_thread_key = s.slack_thread_key
            ORDER BY t.turn_id DESC LIMIT 1
        ) lm ON true
        ORDER BY s.last_activity DESC
        """
    )
    pg_keys: set[str] = set()
    threads = []
    participants_cache: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        key = r["slack_thread_key"]
        pg_keys.add(key)
        live = get_session_state(key)
        live_turns = live.get("turns", []) if live else []
        live_first_message = ""
        live_last_result = ""
        live_last_user_message = ""
        if live_turns:
            live_first_message = _user_message_preview(str(live_turns[0].get("user_message") or ""))
            live_last_result = str(live_turns[-1].get("result") or "")
            live_last_user_message = _user_message_preview(
                str(live_turns[-1].get("user_message") or "")
            )
        if key not in participants_cache:
            if live:
                participants_cache[key] = live.get(
                    "participants"
                ) or _build_participants_from_turns(live_turns)
            else:
                participants_cache[key] = await _fetch_pg_participants(pool, key)
            participants_cache[key] = await _enrich_participants(pool, participants_cache[key])
        threads.append(
            {
                "slack_thread_key": key,
                "container_id": r["container_id"][:12],
                "harness": live["harness"] if live else r["harness"],
                "agent_thread_id": live.get("agent_thread_id") if live else r["agent_thread_id"],
                "state": live["state"] if live else r["state"],
                "created_at": float(r["created_at"]),
                "last_activity": live["last_activity"] if live else float(r["last_activity"]),
                "turn_count": len(live_turns) if live else r["turn_count"],
                "last_result": (live_last_result if live_last_result else (r["last_result"] or ""))[
                    :200
                ],
                "first_message": (
                    live_first_message
                    if live_first_message
                    else _user_message_preview(str(r["first_message"] or ""))
                ),
                "last_user_message": (
                    live_last_user_message
                    if live_last_user_message
                    else _user_message_preview(str(r["last_user_message"] or ""))
                ),
                "thread_name": live.get("thread_name") if live else r.get("thread_name"),
                "participants": participants_cache[key],
            }
        )
    for key, live in session_items_snapshot():
        if key not in pg_keys:
            first_msg = ""
            last_result = ""
            last_user_message = ""
            if live.get("turns"):
                first_msg = _user_message_preview(str(live["turns"][0].get("user_message") or ""))
                last_result = live["turns"][-1].get("result", "")
                last_user_message = _user_message_preview(
                    str(live["turns"][-1].get("user_message") or "")
                )
            threads.append(
                {
                    "slack_thread_key": key,
                    "container_id": live["container_id"][:12],
                    "harness": live["harness"],
                    "agent_thread_id": live.get("agent_thread_id"),
                    "state": live["state"],
                    "created_at": live["created_at"],
                    "last_activity": live["last_activity"],
                    "turn_count": len(live.get("turns", [])),
                    "last_result": last_result[:200],
                    "first_message": first_msg,
                    "last_user_message": last_user_message,
                    "thread_name": live.get("thread_name"),
                    "participants": await _enrich_participants(
                        pool,
                        live.get("participants")
                        or _build_participants_from_turns(live.get("turns", [])),
                    ),
                }
            )
    threads.sort(key=lambda t: t.get("last_activity") or 0, reverse=True)
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
            thread_name,
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
        if not isinstance(events_raw, list):
            events_raw = []
        turns.append(
            {
                "turn_id": t["turn_id"],
                "user_message": t["user_message"],
                "events": events_raw,
                "result": t["result"],
                "user_id": (_extract_turn_user_ids(events_raw) or [None])[0],
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
        "thread_name": row.get("thread_name"),
        "created_at": float(row["created_at"]),
        "last_activity": float(row["last_activity"]),
        "turns": turns,
        "participants": _build_participants_from_turns(turns),
    }


async def _fetch_pg_participants(pool: asyncpg.Pool, key: str) -> list[dict[str, Any]]:
    turn_rows = await pool.fetch(
        """
        SELECT events
        FROM agent_turns
        WHERE slack_thread_key = $1
        ORDER BY turn_id
        """,
        key,
    )
    turns: list[dict[str, Any]] = []
    for row in turn_rows:
        events_raw = row["events"]
        if isinstance(events_raw, str):
            events_raw = json.loads(events_raw)
        if not isinstance(events_raw, list):
            events_raw = []
        turns.append({"events": events_raw})
    return _build_participants_from_turns(turns)


@router.get("/detail")
async def get_thread(
    key: str,
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> dict[str, Any]:
    """Get full thread detail. Prefers live in-memory data, falls back to PG."""
    session = get_session_state(key)
    if not session and not key.startswith("slack:"):
        session = get_session_state(f"slack:{key}")
        if session:
            key = f"slack:{key}"

    if session:
        detail = _build_live_detail(key, session)
        detail["participants"] = await _enrich_participants(pool, detail.get("participants"))
        return detail

    try:
        detail = await _fetch_pg_detail(pool, key)
        detail["participants"] = await _enrich_participants(pool, detail.get("participants"))
        return detail
    except HTTPException:
        if not key.startswith("slack:"):
            try:
                detail = await _fetch_pg_detail(pool, f"slack:{key}")
                detail["participants"] = await _enrich_participants(
                    pool, detail.get("participants")
                )
                return detail
            except HTTPException:
                pass
        raise


@router.post("/context-message")
async def post_context_message(payload: ContextMessageRequest) -> dict[str, Any]:
    text = payload.text.strip()
    if payload.attachments:
        lines = [
            f"- {item.name.strip()}: {item.url.strip()}"
            for item in payload.attachments
            if item.name.strip() and item.url.strip()
        ]
        if lines:
            text = f"{text}\n\nAttachments:\n" + "\n".join(lines)
    return record_thread_message(
        payload.thread_key,
        text,
        message_type="context",
        source=payload.source,
        user_id=payload.user_id,
        message_id=payload.message_id,
    )


# Per-1M token pricing (as of early 2026)
_MODEL_COST_PER_M: dict[str, tuple[float, float]] = {
    # (input_cost_per_M, output_cost_per_M)
    "claude-sonnet-4-20250514": (3.0, 15.0),
    "claude-3-7-sonnet-20250219": (3.0, 15.0),
    "claude-3-5-sonnet-20241022": (3.0, 15.0),
    "claude-3-5-haiku-20241022": (0.80, 4.0),
    "claude-3-opus-20240229": (15.0, 75.0),
}


def _estimate_cost_usd(model: str | None, input_tokens: int, output_tokens: int) -> float | None:
    if not model or (input_tokens == 0 and output_tokens == 0):
        return None
    model_lower = model.lower()
    # Try exact match first, then prefix match
    costs = _MODEL_COST_PER_M.get(model_lower)
    if not costs:
        for key, val in _MODEL_COST_PER_M.items():
            if model_lower.startswith(key.rsplit("-", 1)[0]):
                costs = val
                break
    if not costs:
        # Default to sonnet pricing as a reasonable fallback
        if "opus" in model_lower:
            costs = (15.0, 75.0)
        elif "haiku" in model_lower:
            costs = (0.80, 4.0)
        elif "sonnet" in model_lower:
            costs = (3.0, 15.0)
        else:
            return None
    input_cost = (input_tokens / 1_000_000) * costs[0]
    output_cost = (output_tokens / 1_000_000) * costs[1]
    return round(input_cost + output_cost, 6)


# SSE comment keepalive sent when no data for this many seconds (prevents proxy timeouts)
_SSE_KEEPALIVE_INTERVAL_S = 15


def _parse_phase_label(user_message: str) -> str | None:
    if not user_message.startswith("["):
        return None
    closing = user_message.find("]")
    if closing <= 1:
        return None
    return user_message[1:closing].strip().lower() or None


def _coerce_non_negative_int(value: Any) -> int:
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    return 0


def _has_usage(usage: dict[str, int]) -> bool:
    return usage["input_tokens"] > 0 or usage["output_tokens"] > 0


def _extract_usage_from_payload(usage_payload: dict[str, Any]) -> dict[str, int]:
    input_tokens = (
        _coerce_non_negative_int(usage_payload.get("input_tokens"))
        + _coerce_non_negative_int(usage_payload.get("prompt_tokens"))
        + _coerce_non_negative_int(usage_payload.get("cached_input_tokens"))
        + _coerce_non_negative_int(usage_payload.get("cache_read_input_tokens"))
        + _coerce_non_negative_int(usage_payload.get("cache_creation_input_tokens"))
    )
    output_tokens = (
        _coerce_non_negative_int(usage_payload.get("output_tokens"))
        + _coerce_non_negative_int(usage_payload.get("completion_tokens"))
    )
    if input_tokens == 0 and output_tokens == 0:
        total = _coerce_non_negative_int(usage_payload.get("total_tokens"))
        if total > 0:
            input_tokens = total // 2
            output_tokens = total - input_tokens
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


def _extract_usage_from_event(event: dict[str, Any]) -> tuple[dict[str, int], bool]:
    event_type = str(event.get("type") or "")
    if event_type == "subagent":
        return {"input_tokens": 0, "output_tokens": 0}, False

    usage_payload: dict[str, Any] | None = None
    message = event.get("message")
    if isinstance(message, dict) and isinstance(message.get("usage"), dict):
        usage_payload = message.get("usage")
    elif isinstance(event.get("usage"), dict):
        usage_payload = event.get("usage")

    if not isinstance(usage_payload, dict):
        return {"input_tokens": 0, "output_tokens": 0}, False

    usage = _extract_usage_from_payload(usage_payload)
    is_authoritative = event_type == "turn.completed"
    return usage, is_authoritative


def _extract_usage_model(event: dict[str, Any]) -> str | None:
    event_type = str(event.get("type") or "")
    if event_type == "subagent":
        return None
    message = event.get("message")
    if isinstance(message, dict):
        message_model = str(message.get("model") or "").strip()
        if message_model:
            return message_model
    model = str(event.get("model") or "").strip()
    return model or None


def _ui_stream_chunks_for_event(
    turn_id: int,
    event_index: int,
    event: dict[str, Any],
    pending_tool_ids: dict[tuple[int, str], list[str]] | None = None,
    tool_call_counters: dict[tuple[int, str], int] | None = None,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    event_type = event.get("type")

    if event_type == "assistant":
        content = (event.get("message") or {}).get("content") or []
        for content_index, block in enumerate(content):
            block_type = block.get("type")
            if block_type == "text" and (block.get("text") or "").strip():
                text_id = f"turn-{turn_id}-text-{event_index}-{content_index}"
                chunks.append({"type": "text-start", "id": text_id})
                chunks.append(
                    {"type": "text-delta", "id": text_id, "delta": str(block.get("text") or "")}
                )
                chunks.append({"type": "text-end", "id": text_id})
            elif block_type == "thinking" and (block.get("thinking") or "").strip():
                reasoning_id = f"turn-{turn_id}-reasoning-{event_index}-{content_index}"
                chunks.append({"type": "reasoning-start", "id": reasoning_id})
                chunks.append(
                    {
                        "type": "reasoning-delta",
                        "id": reasoning_id,
                        "delta": str(block.get("thinking") or ""),
                    }
                )
                chunks.append({"type": "reasoning-end", "id": reasoning_id})
            elif block_type == "tool_use":
                tool_call_id = str(block.get("id") or "").strip() or (
                    f"turn-{turn_id}-tool-{event_index}-{content_index}"
                )
                chunks.append(
                    {
                        "type": "tool-input-available",
                        "toolCallId": tool_call_id,
                        "toolName": str(block.get("name") or "tool"),
                        "input": block.get("input") or {},
                    }
                )
    elif event_type == "tool":
        for block in event.get("content") or []:
            tool_call_id = str(block.get("tool_use_id") or "").strip()
            if not tool_call_id:
                continue
            chunks.append(
                {
                    "type": "tool-output-available",
                    "toolCallId": tool_call_id,
                    "output": block.get("content"),
                }
            )
    elif event_type == "reasoning":
        reasoning_id = f"turn-{turn_id}-reasoning-{event_index}"
        chunks.append({"type": "reasoning-start", "id": reasoning_id})
        chunks.append(
            {"type": "reasoning-delta", "id": reasoning_id, "delta": str(event.get("text") or "")}
        )
        chunks.append({"type": "reasoning-end", "id": reasoning_id})
    elif event_type == "file_change":
        chunks.append(
            {
                "type": "data-file-changes",
                "id": f"turn-{turn_id}-file-change-{event_index}",
                "data": {"changes": event.get("changes") or []},
            }
        )
    elif event_type == "command_execution":
        chunks.append(
            {
                "type": "data-shell-command",
                "id": f"turn-{turn_id}-command-{event_index}",
                "data": {
                    "command": event.get("command") or "",
                    "output": event.get("aggregated_output") or event.get("output") or "",
                    "exitCode": event.get("exit_code"),
                    "status": event.get("status"),
                },
            }
        )
    elif event_type == "thread.message":
        message_type = str(event.get("message_type") or "")
        text = str(event.get("text") or "").strip()
        if not text:
            return chunks
        base_data = {
            "id": str(event.get("message_id") or f"turn-{turn_id}-thread-message-{event_index}"),
            "turn_id": turn_id,
            "text": text,
            "source": str(event.get("source") or "unknown"),
            "user_id": str(event.get("user_id") or "").strip() or None,
            "created_at": str(event.get("created_at") or ""),
        }
        if message_type == "context":
            chunks.append(
                {
                    "type": "data-context-message",
                    "id": f"turn-{turn_id}-context-{event_index}",
                    "data": base_data,
                }
            )
        elif message_type == "command":
            chunks.append(
                {
                    "type": "data-user-message",
                    "id": f"turn-{turn_id}-user-message-{event_index}",
                    "data": base_data,
                }
            )
    elif event_type == "subagent":
        subagent_id = str(event.get("subagent_id") or "").strip()
        phase = str(event.get("phase") or "").strip()
        status = str(event.get("status") or "").strip()
        if not status:
            return chunks
        input_tokens_raw = event.get("input_tokens")
        output_tokens_raw = event.get("output_tokens")
        input_tokens = (
            _coerce_non_negative_int(input_tokens_raw)
            if input_tokens_raw is not None
            else None
        )
        output_tokens = (
            _coerce_non_negative_int(output_tokens_raw)
            if output_tokens_raw is not None
            else None
        )
        total_tokens_raw = event.get("total_tokens")
        if total_tokens_raw is not None:
            total_tokens: int | None = _coerce_non_negative_int(total_tokens_raw)
        elif input_tokens is not None or output_tokens is not None:
            total_tokens = (input_tokens or 0) + (output_tokens or 0)
        else:
            total_tokens = None
        model_name = str(event.get("model") or "").strip() or None
        cost_usd = (
            _estimate_cost_usd(model_name, input_tokens or 0, output_tokens or 0)
            if input_tokens is not None and output_tokens is not None
            else None
        )
        stable_id = subagent_id or f"turn-{turn_id}-subagent-{event_index}"
        chunks.append(
            {
                "type": "data-subagent",
                "id": f"turn-{turn_id}-subagent-{stable_id}-{status}",
                "data": {
                    "subagent_id": subagent_id or None,
                    "phase": phase or None,
                    "status": status,
                    "name": event.get("name"),
                    "summary": event.get("summary"),
                    "error": event.get("error"),
                    "branch_index": event.get("branch_index"),
                    "total_branches": event.get("total_branches"),
                    "completed": event.get("completed"),
                    "acceptable": event.get("acceptable"),
                    "failed": event.get("failed"),
                    "completed_count": event.get("completed_count"),
                    "acceptable_count": event.get("acceptable_count"),
                    "failed_count": event.get("failed_count"),
                    "is_acceptable": event.get("is_acceptable"),
                    "turns": event.get("turns"),
                    "tool_calls": event.get("tool_calls"),
                    "duration_s": event.get("duration_s"),
                    "max_parallel": event.get("max_parallel"),
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cost_usd": cost_usd,
                    "model": model_name,
                },
            }
        )
    elif event_type == "error":
        chunks.append(
            {"type": "error", "errorText": str(event.get("error") or event.get("message") or "")}
        )
    elif event_type == "result":
        text = str(event.get("result") or "")
        if text:
            text_id = f"turn-{turn_id}-result-{event_index}"
            chunks.append({"type": "text-start", "id": text_id})
            chunks.append({"type": "text-delta", "id": text_id, "delta": text})
            chunks.append({"type": "text-end", "id": text_id})
    elif event_type in {"item.started", "item.updated", "item.completed"}:
        item = event.get("item") if isinstance(event.get("item"), dict) else {}
        item_type = str(item.get("type") or "")

        if item_type in {"mcp_tool_call", "tool_call", "function_call", "custom_tool_call"}:
            item_id = _raw_item_call_id(
                item,
                turn_id,
                event_type=str(event_type),
                event_index=event_index,
                pending_ids=pending_tool_ids,
                call_counters=tool_call_counters,
            )
            tool_name = str(item.get("tool") or item.get("name") or item.get("tool_name") or "tool")
            tool_input = item.get("arguments") or item.get("input") or item.get("args") or {}
            if event_type == "item.started":
                chunks.append(
                    {
                        "type": "tool-input-available",
                        "toolCallId": item_id,
                        "toolName": tool_name,
                        "input": tool_input if isinstance(tool_input, dict) else {},
                    }
                )
            elif event_type == "item.completed":
                output = item.get("result")
                if output is None and item.get("error") is not None:
                    output = item.get("error")
                chunks.append(
                    {
                        "type": "tool-output-available",
                        "toolCallId": item_id,
                        "output": output,
                    }
                )
        elif item_type == "command_execution" and event_type == "item.completed":
            chunks.append(
                {
                    "type": "data-shell-command",
                    "id": f"turn-{turn_id}-item-command-{event_index}",
                    "data": {
                        "command": item.get("command") or "",
                        "output": item.get("aggregated_output") or item.get("output") or "",
                        "exitCode": item.get("exit_code"),
                        "status": item.get("status"),
                    },
                }
            )
        elif item_type == "reasoning" and event_type in {"item.updated", "item.completed"}:
            text = str(item.get("text") or item.get("thinking") or "")
            if text:
                reasoning_id = f"turn-{turn_id}-item-reasoning-{event_index}"
                chunks.append({"type": "reasoning-start", "id": reasoning_id})
                chunks.append({"type": "reasoning-delta", "id": reasoning_id, "delta": text})
                chunks.append({"type": "reasoning-end", "id": reasoning_id})
        elif event_type == "item.completed":
            text = str(item.get("text") or "")
            if text:
                text_id = f"turn-{turn_id}-item-result-{event_index}"
                chunks.append({"type": "text-start", "id": text_id})
                chunks.append({"type": "text-delta", "id": text_id, "delta": text})
                chunks.append({"type": "text-end", "id": text_id})

    return chunks


@router.get("/stream-ui")
async def stream_thread_ui(
    request: Request,
    key: str,
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> StreamingResponse:
    """SSE UIMessageStream endpoint for ai SDK compatible thread streaming."""
    live_only = request.query_params.get("live_only", "").strip().lower() in {"1", "true", "yes"}

    async def generate():
        nonlocal key
        session = get_session_state(key)
        if not session and not key.startswith("slack:"):
            session = get_session_state(f"slack:{key}")
            if session:
                key = f"slack:{key}"
        yield f"data: {json.dumps({'type': 'start', 'messageId': f'thread-{key}'})}\n\n"
        last_event_indices: dict[int, int] = {}
        emitted_finish_for_snapshot = False
        ticks_since_data = 0
        last_state = ""
        usage_by_turn: dict[int, dict[str, int]] = {}
        usage_authoritative_turns: set[int] = set()
        last_usage_total = -1
        last_phase_by_turn: dict[int, str] = {}
        usage_seen = False
        usage_model: str | None = None
        initialized_live_cursor = False
        turns_with_stream_chunks: set[int] = set()
        emitted_turn_user_messages: set[str] = set()
        pending_tool_ids: dict[tuple[int, str], list[str]] = {}
        tool_call_counters: dict[tuple[int, str], int] = {}

        while True:
            if await request.is_disconnected():
                break

            session = get_session_state(key)
            detail: dict[str, Any] | None
            if session:
                detail = _build_live_detail(key, session)
            else:
                if emitted_finish_for_snapshot:
                    break
                try:
                    detail = await _fetch_pg_detail(pool, key)
                except HTTPException:
                    if not key.startswith("slack:"):
                        try:
                            detail = await _fetch_pg_detail(pool, f"slack:{key}")
                            key = f"slack:{key}"
                        except HTTPException:
                            detail = None
                    else:
                        detail = None
                if detail is None:
                    yield f"data: {json.dumps({'type': 'error', 'errorText': 'not_found'})}\n\n"
                    yield f"data: {json.dumps({'type': 'finish'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

            any_new_data = False
            turns = detail.get("turns") or []
            if live_only and not initialized_live_cursor:
                for turn in turns:
                    turn_id = int(turn.get("turn_id") or 0)
                    if turn_id <= 0:
                        continue
                    events_raw = turn.get("events")
                    events = events_raw if isinstance(events_raw, list) else []
                    last_event_indices[turn_id] = len(events)
                    if turn.get("result"):
                        last_event_indices[-turn_id] = 1
                    command_event = _latest_command_message_event(events)
                    if command_event or _display_user_message(str(turn.get("user_message") or "")):
                        emitted_turn_user_messages.add(_turn_user_message_key(turn_id))
                    phase = _parse_phase_label(str(turn.get("user_message") or ""))
                    if phase:
                        last_phase_by_turn[turn_id] = phase
                initialized_live_cursor = True
            state = str(detail.get("state") or "")
            if state != last_state:
                last_state = state
                any_new_data = True
                yield f"data: {json.dumps({'type': 'data-agent-status', 'data': {'text': state.capitalize() if state else 'Working...'}, 'transient': True})}\n\n"
            for turn in turns:
                turn_id = int(turn.get("turn_id") or 0)
                phase = _parse_phase_label(str(turn.get("user_message") or ""))
                if phase and last_phase_by_turn.get(turn_id) != phase:
                    last_phase_by_turn[turn_id] = phase
                    any_new_data = True
                    yield f"data: {json.dumps({'type': 'data-phase-progress', 'id': f'turn-{turn_id}-phase', 'data': {'phase': phase, 'turn_id': turn_id}})}\n\n"
                events_raw = turn.get("events")
                events = events_raw if isinstance(events_raw, list) else []
                command_event = _latest_command_message_event(events)
                if not command_event:
                    fallback_text = _display_user_message(str(turn.get("user_message") or ""))
                    fallback_key = _turn_user_message_key(turn_id)
                    if fallback_text and fallback_key not in emitted_turn_user_messages:
                        emitted_turn_user_messages.add(fallback_key)
                        fallback_id = f"turn-{turn_id}-user-message"
                        any_new_data = True
                        yield f"data: {json.dumps({'type': 'start-step'})}\n\n"
                        yield f"data: {json.dumps({'type': 'data-user-message', 'id': fallback_id, 'data': {'id': fallback_id, 'turn_id': turn_id, 'text': fallback_text, 'source': 'unknown', 'user_id': str(turn.get('user_id') or '').strip() or None, 'created_at': ''}})}\n\n"
                        yield f"data: {json.dumps({'type': 'finish-step'})}\n\n"
                start_index = last_event_indices.get(turn_id, 0)
                turn_had_chunks = False
                if start_index < len(events):
                    for index in range(start_index, len(events)):
                        event = events[index]
                        if not isinstance(event, dict):
                            continue
                        message_model = _extract_usage_model(event)
                        if message_model:
                            usage_model = message_model
                        explicit_usage, is_authoritative = _extract_usage_from_event(event)
                        if _has_usage(explicit_usage):
                            usage_seen = True
                            if is_authoritative:
                                usage_by_turn[turn_id] = explicit_usage
                                usage_authoritative_turns.add(turn_id)
                            elif turn_id not in usage_authoritative_turns:
                                previous = usage_by_turn.get(
                                    turn_id,
                                    {"input_tokens": 0, "output_tokens": 0},
                                )
                                usage_by_turn[turn_id] = {
                                    "input_tokens": previous["input_tokens"]
                                    + explicit_usage["input_tokens"],
                                    "output_tokens": previous["output_tokens"]
                                    + explicit_usage["output_tokens"],
                                }
                        chunks = _ui_stream_chunks_for_event(
                            turn_id,
                            index,
                            event,
                            pending_tool_ids,
                            tool_call_counters,
                        )
                        if not chunks:
                            continue
                        filtered_chunks: list[dict[str, Any]] = []
                        for chunk in chunks:
                            chunk_type = str(chunk.get("type") or "")
                            if chunk_type != "data-user-message":
                                filtered_chunks.append(chunk)
                                continue
                            dedupe_key = _turn_user_message_key(turn_id)
                            if dedupe_key in emitted_turn_user_messages:
                                continue
                            stable_id = f"turn-{turn_id}-user-message"
                            chunk_data = chunk.get("data")
                            if isinstance(chunk_data, dict):
                                chunk["data"] = {**chunk_data, "id": stable_id}
                            chunk["id"] = stable_id
                            emitted_turn_user_messages.add(dedupe_key)
                            filtered_chunks.append(chunk)
                        if not filtered_chunks:
                            continue
                        turn_had_chunks = True
                        turns_with_stream_chunks.add(turn_id)
                        any_new_data = True
                        yield f"data: {json.dumps({'type': 'start-step'})}\n\n"
                        for chunk in filtered_chunks:
                            chunk_type = str(chunk.get("type") or "")
                            any_new_data = True
                            yield f"data: {json.dumps(chunk, default=str)}\n\n"
                            if chunk_type in {"reasoning-start", "reasoning-delta"}:
                                yield f"data: {json.dumps({'type': 'data-agent-status', 'data': {'text': 'Thinking...'}, 'transient': True})}\n\n"
                            elif chunk_type == "tool-input-available":
                                tool_name = str(chunk.get("toolName") or "tool")
                                yield f"data: {json.dumps({'type': 'data-agent-status', 'data': {'text': f'Running {tool_name}...'}, 'transient': True})}\n\n"
                            elif chunk_type in {"text-start", "text-delta"}:
                                yield f"data: {json.dumps({'type': 'data-agent-status', 'data': {'text': 'Writing response...'}, 'transient': True})}\n\n"
                        yield f"data: {json.dumps({'type': 'finish-step'})}\n\n"
                last_event_indices[turn_id] = len(events)

                if (
                    turn.get("result")
                    and not turn_had_chunks
                    and turn_id not in turns_with_stream_chunks
                ):
                    result_id = f"turn-{turn_id}-turn-result"
                    if last_event_indices.get(-turn_id) != 1:
                        any_new_data = True
                        yield f"data: {json.dumps({'type': 'start-step'})}\n\n"
                        yield f"data: {json.dumps({'type': 'text-start', 'id': result_id})}\n\n"
                        yield f"data: {json.dumps({'type': 'text-delta', 'id': result_id, 'delta': turn.get('result')})}\n\n"
                        yield f"data: {json.dumps({'type': 'text-end', 'id': result_id})}\n\n"
                        yield f"data: {json.dumps({'type': 'finish-step'})}\n\n"
                        turns_with_stream_chunks.add(turn_id)
                        last_event_indices[-turn_id] = 1

            total_input_tokens = sum(item["input_tokens"] for item in usage_by_turn.values())
            total_output_tokens = sum(item["output_tokens"] for item in usage_by_turn.values())
            usage_total = total_input_tokens + total_output_tokens
            if usage_seen and usage_total != last_usage_total:
                last_usage_total = usage_total
                any_new_data = True
                authoritative_usage = bool(usage_by_turn) and all(
                    turn_id in usage_authoritative_turns for turn_id in usage_by_turn
                )
                yield f"data: {json.dumps({'type': 'data-token-usage', 'id': 'thread-token-usage', 'data': {'input_tokens': total_input_tokens, 'output_tokens': total_output_tokens, 'total_tokens': usage_total, 'cost_usd': _estimate_cost_usd(usage_model, total_input_tokens, total_output_tokens), 'estimated': not authoritative_usage, 'authoritative': authoritative_usage, 'model': usage_model}})}\n\n"

            if any_new_data:
                ticks_since_data = 0
            else:
                ticks_since_data += 1

            if not session:
                emitted_finish_for_snapshot = True
                yield f"data: {json.dumps({'type': 'data-agent-status', 'data': {'text': ''}, 'transient': True})}\n\n"
                yield f"data: {json.dumps({'type': 'finish'})}\n\n"
                yield "data: [DONE]\n\n"
                return

            if ticks_since_data * 0.3 >= _SSE_KEEPALIVE_INTERVAL_S:
                yield ":keepalive\n\n"
                ticks_since_data = 0

            await asyncio.sleep(0.3)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "x-vercel-ai-ui-message-stream": "v1",
        },
    )


@router.get("/stream", include_in_schema=False)
async def stream_thread_redirect(request: Request) -> RedirectResponse:
    """Legacy alias for clients still using /stream."""
    target = "/api/threads/stream-ui"
    query = request.url.query
    if query:
        target = f"{target}?{query}"
    return RedirectResponse(
        url=target,
        status_code=307,
        headers={"Cache-Control": "no-store, no-cache, max-age=0"},
    )
