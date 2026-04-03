"""Durable runtime control-plane helpers for spawn/message/execute flows."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import uuid
from typing import Any

import structlog

from api.agent import (
    _get_runtime,
    _stream_stdout,
    get_or_spawn,
    inject_stdin,
    stop_session,
)
from api.observability import (
    ExecutionObservationAccumulator,
    extract_usage_metrics,
    payload_size_bytes,
    project_execution_observations,
    summarize_message_parts,
)
from api.metrics import (
    record_agent_execution,
    record_execution_claimed,
    record_execution_enqueued,
    record_execution_terminal,
    record_execution_watchdog_timeout,
    record_message_observation,
    record_usage_observation,
)
from api.sandbox.normalize import normalize_harness_event
from api.sandbox.registry import get_backend

log = structlog.get_logger()

EXECUTION_SILENCE_TIMEOUT_S = int(os.getenv("EXECUTION_SILENCE_TIMEOUT_S", "600"))
EXECUTION_TOOL_SILENCE_TIMEOUT_S = int(os.getenv("EXECUTION_TOOL_SILENCE_TIMEOUT_S", "1800"))
EXECUTION_HARD_TIMEOUT_S = int(os.getenv("EXECUTION_HARD_TIMEOUT_S", "3600"))
EXECUTION_WATCHDOG_POLL_S = float(os.getenv("EXECUTION_WATCHDOG_POLL_S", "1.0"))
EXECUTION_RECONCILE_INTERVAL_S = float(os.getenv("EXECUTION_RECONCILE_INTERVAL_S", "0.5"))
EXECUTION_STALE_RECOVERY_INTERVAL_S = float(
    os.getenv("EXECUTION_STALE_RECOVERY_INTERVAL_S", "5.0")
)
EXECUTION_WORKER_CONCURRENCY = max(
    int(os.getenv("EXECUTION_WORKER_CONCURRENCY", "4")),
    1,
)
EXECUTION_WORKER_LEASE_S = max(
    float(os.getenv("EXECUTION_WORKER_LEASE_S", "5.0")),
    max(EXECUTION_WATCHDOG_POLL_S * 2, 1.0),
)
FINAL_DELIVERY_READY_GRACE_S = max(
    float(os.getenv("FINAL_DELIVERY_READY_GRACE_S", "2.0")),
    0.0,
)
WORKER_INSTANCE_ID = f"{os.getenv('HOSTNAME') or 'api'}:{uuid.uuid4().hex[:8]}"

_worker_tasks: list[asyncio.Task] = []
_worker_wake = asyncio.Event()
_recover_stale_running_lock = asyncio.Lock()
_last_recover_stale_running_at = 0.0


class ControlPlaneError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def canonical_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def request_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def decode_jsonb(value: Any, fallback: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            return json.loads(value)
    return fallback


def prompt_identity(
    *, harness: str, persona_id: str | None, agents_md_override: str | None
) -> tuple[str, str]:
    prompt_ref = (
        f"persona:{persona_id}"
        if persona_id
        else f"harness:{harness}"
    )
    effective = agents_md_override if agents_md_override is not None else prompt_ref
    sha = hashlib.sha256(effective.encode("utf-8")).hexdigest()
    return prompt_ref, sha


def flatten_event_parts(event: dict[str, Any]) -> list[dict[str, Any]]:
    message = event.get("message") if isinstance(event, dict) else None
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, list):
        return [p for p in content if isinstance(p, dict)]
    return []


def event_role(event: dict[str, Any]) -> str:
    message = event.get("message") if isinstance(event, dict) else None
    if isinstance(message, dict):
        role = message.get("role")
        if isinstance(role, str) and role:
            return role
    return "user"


def _event_silence_timeout_s(event: dict[str, Any]) -> float:
    parts = flatten_event_parts(event)
    if any(part.get("type") == "tool_use" for part in parts):
        return float(max(EXECUTION_TOOL_SILENCE_TIMEOUT_S, EXECUTION_SILENCE_TIMEOUT_S))
    return float(EXECUTION_SILENCE_TIMEOUT_S)


def _attachment_name_from_source_path(source_path: str | None, attachment_id: str) -> str:
    if not source_path:
        return f"{attachment_id}.bin"
    with contextlib.suppress(Exception):
        parsed = pathlib.PurePosixPath(source_path)
        if parsed.name:
            return parsed.name
    return f"{attachment_id}.bin"


def _metadata_platform(metadata: dict[str, Any]) -> str | None:
    platform = metadata.get("platform") if isinstance(metadata, dict) else None
    return platform if isinstance(platform, str) and platform else None


def _delivery_platform(delivery: dict[str, Any]) -> str | None:
    platform = delivery.get("platform") if isinstance(delivery, dict) else None
    return platform if isinstance(platform, str) and platform else None


async def _write_agents_override(runtime_id: str, agents_md_override: str) -> None:
    backend = get_backend()
    code, output = await backend.exec_run(
        runtime_id,
        [
            "sh",
            "-c",
            "mkdir -p /home/agent/workspace && printf '%s' \"$_CONTENT\" > /home/agent/workspace/AGENTS.md",
        ],
        environment={"_CONTENT": agents_md_override},
        user="agent",
    )
    if code != 0:
        raise ControlPlaneError(
            "AGENTS_OVERRIDE_FAILED",
            f"failed to apply AGENTS override: {output.decode('utf-8', errors='replace')[:200]}",
            500,
        )


async def get_active_assignment(pool, thread_key: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT thread_key, assignment_generation, runtime_id, harness, engine, persona_id, "
        "prompt_ref, effective_agents_md_sha256, agents_md_override, state "
        "FROM agent_runtime_assignments "
        "WHERE thread_key = $1 AND state = 'active' "
        "ORDER BY assignment_generation DESC LIMIT 1",
        thread_key,
    )
    return dict(row) if row else None


async def spawn_assignment(
    pool,
    *,
    thread_key: str,
    spawn_id: str,
    harness: str | None,
    engine: str | None,
    persona_id: str | None,
    agents_md_override: str | None,
) -> dict[str, Any]:
    if persona_id:
        from api.app import get_tool_manager

        persona = get_tool_manager().get_persona(persona_id)
        if persona is None:
            raise ControlPlaneError(
                "UNKNOWN_PERSONA_ID",
                f"unknown persona_id: {persona_id}",
                422,
            )

    attach_active_assignment = (
        harness is None
        and engine is None
        and persona_id is None
        and agents_md_override is None
    )
    active_assignment = (
        await get_active_assignment(pool, thread_key)
        if attach_active_assignment
        else None
    )

    effective_persona_id = persona_id
    effective_engine = engine
    effective_agents_md_override = agents_md_override
    requested_harness = persona_id or harness or "amp"

    if active_assignment:
        effective_persona_id = active_assignment.get("persona_id")
        effective_engine = active_assignment.get("engine")
        effective_agents_md_override = active_assignment.get("agents_md_override")
        requested_harness = (
            active_assignment.get("persona_id")
            or active_assignment.get("harness")
            or "amp"
        )

    payload = {
        "thread_key": thread_key,
        "spawn_id": spawn_id,
        "harness": requested_harness,
        "engine": effective_engine,
        "persona_id": effective_persona_id,
        "agents_md_override": effective_agents_md_override,
    }
    req_hash = request_hash(payload)

    existing_idem = await pool.fetchrow(
        "SELECT request_hash, response_json FROM agent_spawn_requests "
        "WHERE thread_key = $1 AND spawn_id = $2",
        thread_key,
        spawn_id,
    )
    if existing_idem:
        if existing_idem["request_hash"] != req_hash:
            raise ControlPlaneError(
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                "spawn_id was already used with a different payload",
                409,
            )
        return decode_jsonb(existing_idem["response_json"], {})

    session = await get_or_spawn(thread_key, requested_harness, engine=effective_engine)
    if effective_agents_md_override is not None:
        await _write_agents_override(session.sandbox_id, effective_agents_md_override)

    persona = effective_persona_id
    if persona is None and requested_harness not in {"amp", "claude-code", "codex", "pi-mono"}:
        persona = requested_harness

    prompt_ref, prompt_sha = prompt_identity(
        harness=session.harness,
        persona_id=persona,
        agents_md_override=effective_agents_md_override,
    )

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", thread_key)

            existing_idem = await conn.fetchrow(
                "SELECT request_hash, response_json FROM agent_spawn_requests "
                "WHERE thread_key = $1 AND spawn_id = $2",
                thread_key,
                spawn_id,
            )
            if existing_idem:
                if existing_idem["request_hash"] != req_hash:
                    raise ControlPlaneError(
                        "IDEMPOTENCY_PAYLOAD_MISMATCH",
                        "spawn_id was already used with a different payload",
                        409,
                    )
                return decode_jsonb(existing_idem["response_json"], {})

            active = await conn.fetchrow(
                "SELECT assignment_generation, runtime_id, harness, engine, persona_id, "
                "prompt_ref, effective_agents_md_sha256, agents_md_override "
                "FROM agent_runtime_assignments "
                "WHERE thread_key = $1 AND state = 'active' "
                "ORDER BY assignment_generation DESC LIMIT 1",
                thread_key,
            )

            if active:
                if (
                    active["effective_agents_md_sha256"] != prompt_sha
                    or active["harness"] != session.harness
                ):
                    raise ControlPlaneError(
                        "ACTIVE_ASSIGNMENT_PROMPT_MISMATCH",
                        "active assignment exists with different prompt identity",
                        409,
                    )
                generation = int(active["assignment_generation"])
                runtime_id = active["runtime_id"]
                if runtime_id != session.sandbox_id:
                    await conn.execute(
                        "UPDATE agent_runtime_assignments SET runtime_id = $1, updated_at = NOW() "
                        "WHERE thread_key = $2 AND assignment_generation = $3",
                        session.sandbox_id,
                        thread_key,
                        generation,
                    )
                    runtime_id = session.sandbox_id
                assignment_state = "assigned_idle"
                resolved_persona = active["persona_id"]
                resolved_prompt_ref = active["prompt_ref"]
                resolved_prompt_sha = active["effective_agents_md_sha256"]
            else:
                generation = int(
                    await conn.fetchval(
                        "SELECT COALESCE(MAX(assignment_generation), 0) "
                        "FROM agent_runtime_assignments WHERE thread_key = $1",
                        thread_key,
                    )
                ) + 1
                await conn.execute(
                    "INSERT INTO agent_runtime_assignments ("
                    "thread_key, assignment_generation, runtime_id, harness, engine, "
                    "persona_id, prompt_ref, effective_agents_md_sha256, agents_md_override, state"
                    ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')",
                    thread_key,
                    generation,
                    session.sandbox_id,
                    session.harness,
                    session.engine,
                    persona,
                    prompt_ref,
                    prompt_sha,
                    effective_agents_md_override,
                )
                runtime_id = session.sandbox_id
                assignment_state = "assigned_idle"
                resolved_persona = persona
                resolved_prompt_ref = prompt_ref
                resolved_prompt_sha = prompt_sha

            response = {
                "ok": True,
                "runtime_id": runtime_id,
                "thread_key": thread_key,
                "assignment_state": assignment_state,
                "assignment_generation": generation,
                "persona_id": resolved_persona,
                "prompt_ref": resolved_prompt_ref,
                "effective_agents_md_sha256": resolved_prompt_sha,
            }
            await conn.execute(
                "INSERT INTO agent_spawn_requests (thread_key, spawn_id, request_hash, response_json) "
                "VALUES ($1, $2, $3, $4::jsonb)",
                thread_key,
                spawn_id,
                req_hash,
                canonical_json(response),
            )

            log.info(
                "spawn_completed",
                thread_key=thread_key,
                spawn_id=spawn_id,
                runtime_id=runtime_id,
                assignment_generation=generation,
                harness=session.harness,
                engine=session.engine,
                persona_id=resolved_persona,
                prompt_ref=resolved_prompt_ref,
                prompt_sha=resolved_prompt_sha,
            )
            return response


async def extract_inline_attachments(
    pool,
    *,
    thread_key: str,
    chat_message_id: str,
    parts: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    transformed: list[dict[str, Any]] = []
    attachment_ids: list[str] = []

    for part in parts:
        part_type = part.get("type")
        source = part.get("source") if isinstance(part, dict) else None
        if (
            part_type in {"image", "document"}
            and isinstance(source, dict)
            and source.get("type") == "base64"
            and isinstance(source.get("data"), str)
        ):
            media_type = str(source.get("media_type") or "application/octet-stream")
            try:
                raw = base64.b64decode(source["data"])
            except Exception as exc:
                raise ControlPlaneError(
                    "INVALID_BASE64_ATTACHMENT",
                    f"invalid base64 attachment: {exc}",
                    422,
                ) from exc
            attachment_id = f"att-{uuid.uuid4().hex[:16]}"
            source_path = part.get("source_path") if isinstance(part.get("source_path"), str) else None
            name = _attachment_name_from_source_path(source_path, attachment_id)
            await pool.execute(
                "INSERT INTO attachments (id, thread_key, message_id, name, mime_type, data) "
                "VALUES ($1, $2, $3, $4, $5, $6)",
                attachment_id,
                thread_key,
                chat_message_id,
                name,
                media_type,
                raw,
            )
            transformed.append(
                {
                    "type": "attachment_ref",
                    "attachment_id": attachment_id,
                    "media_type": media_type,
                    **({"source_path": source_path} if source_path else {}),
                }
            )
            attachment_ids.append(attachment_id)
            continue

        transformed.append(part)

    return transformed, attachment_ids


def event_to_chat_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chat_parts: list[dict[str, Any]] = []
    for part in parts:
        part_type = part.get("type")
        if part_type == "text":
            chat_parts.append({"type": "text", "text": str(part.get("text") or "")})
        elif part_type == "attachment_ref":
            attachment_id = str(part.get("attachment_id") or "")
            media_type = str(part.get("media_type") or "application/octet-stream")
            source_path = part.get("source_path") if isinstance(part.get("source_path"), str) else None
            name = _attachment_name_from_source_path(source_path, attachment_id)
            chat_parts.append(
                {
                    "type": "attachment_ref",
                    "id": attachment_id,
                    "name": name,
                    "mime_type": media_type,
                }
            )
        else:
            chat_parts.append(part)
    return chat_parts


async def append_message(
    pool,
    *,
    thread_key: str,
    assignment_generation: int,
    message_id: str,
    event: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "thread_key": thread_key,
        "assignment_generation": assignment_generation,
        "message_id": message_id,
        "event": event,
        "metadata": metadata,
    }
    req_hash = request_hash(payload)

    existing = await pool.fetchrow(
        "SELECT request_hash FROM agent_message_requests "
        "WHERE thread_key = $1 AND message_id = $2",
        thread_key,
        message_id,
    )
    if existing:
        if existing["request_hash"] != req_hash:
            raise ControlPlaneError(
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                "message_id was already used with a different payload",
                409,
            )
        return {
            "ok": True,
            "message_id": message_id,
            "stored_event_id": f"{thread_key}:{message_id}",
            "attachment_ids": [],
            "idempotent": True,
        }

    role = event_role(event)
    content_parts = flatten_event_parts(event)
    if not content_parts:
        raise ControlPlaneError("INVALID_AMP_EVENT_ENVELOPE", "event.message.content is required", 400)

    chat_message_id = f"msg:{thread_key}:{message_id}"
    attachment_ids: list[str] = []

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", thread_key)

            existing = await conn.fetchrow(
                "SELECT request_hash FROM agent_message_requests "
                "WHERE thread_key = $1 AND message_id = $2",
                thread_key,
                message_id,
            )
            if existing:
                if existing["request_hash"] != req_hash:
                    raise ControlPlaneError(
                        "IDEMPOTENCY_PAYLOAD_MISMATCH",
                        "message_id was already used with a different payload",
                        409,
                    )
                return {
                    "ok": True,
                    "message_id": message_id,
                    "stored_event_id": f"{thread_key}:{message_id}",
                    "attachment_ids": [],
                    "idempotent": True,
                }

            active = await conn.fetchrow(
                "SELECT assignment_generation, harness, engine, persona_id, prompt_ref, effective_agents_md_sha256 "
                "FROM agent_runtime_assignments "
                "WHERE thread_key = $1 AND state = 'active' "
                "ORDER BY assignment_generation DESC LIMIT 1",
                thread_key,
            )
            if not active:
                raise ControlPlaneError(
                    "NO_ACTIVE_ASSIGNMENT",
                    "No active runtime assignment for thread_key",
                    409,
                )
            active_generation = int(active["assignment_generation"])
            if active_generation != int(assignment_generation):
                raise ControlPlaneError(
                    "ASSIGNMENT_GENERATION_STALE",
                    "assignment_generation does not match the active assignment",
                    409,
                )

            await conn.execute(
                "INSERT INTO chat_messages (id, thread_key, role, parts, user_id, metadata) "
                "VALUES ($1, $2, $3, '[]'::jsonb, $4, $5::jsonb) "
                "ON CONFLICT (id) DO NOTHING",
                chat_message_id,
                thread_key,
                role,
                metadata.get("user_id") if isinstance(metadata, dict) else None,
                canonical_json(metadata),
            )

            normalized_parts, attachment_ids = await extract_inline_attachments(
                conn,
                thread_key=thread_key,
                chat_message_id=chat_message_id,
                parts=content_parts,
            )
            normalized_event = {
                "type": str(event.get("type") or "user"),
                "message": {
                    "role": role,
                    "content": normalized_parts,
                },
            }
            chat_parts = event_to_chat_parts(normalized_parts)

            await conn.execute(
                "INSERT INTO agent_message_requests ("
                "thread_key, message_id, assignment_generation, request_hash, event_json, metadata"
                ") VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)",
                thread_key,
                message_id,
                assignment_generation,
                req_hash,
                canonical_json(normalized_event),
                canonical_json(metadata),
            )
            await conn.execute(
                "UPDATE chat_messages SET parts = $1::jsonb, metadata = $2::jsonb WHERE id = $3",
                canonical_json(chat_parts),
                canonical_json(
                    {
                        **metadata,
                        "message_id": message_id,
                        "assignment_generation": assignment_generation,
                    }
                ),
                chat_message_id,
            )

    message_summary = summarize_message_parts(normalized_parts)
    record_message_observation(
        role=role,
        text_chars=message_summary["text_chars"],
        attachment_count=message_summary["attachment_ref_count"],
    )
    log.info(
        "message_stored",
        thread_key=thread_key,
        message_id=message_id,
        assignment_generation=assignment_generation,
        role=role,
        source_platform=_metadata_platform(metadata),
        event_size_bytes=payload_size_bytes(normalized_event),
        **message_summary,
    )

    return {
        "ok": True,
        "message_id": message_id,
        "stored_event_id": f"{thread_key}:{message_id}",
        "attachment_ids": attachment_ids,
    }


def execution_terminal(status: str) -> bool:
    return status in {"completed", "failed_permanent", "cancelled"}


def build_execution_state_payload(
    *,
    execution_id: str,
    thread_key: str,
    status: str,
    terminal_reason: str | None = None,
    result_text: str | None = None,
    error_text: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "type": "execution.state",
        "execution_id": execution_id,
        "thread_key": thread_key,
        "status": status,
    }
    if terminal_reason is not None:
        payload["terminal_reason"] = terminal_reason
    if result_text is not None:
        payload["result_text"] = result_text
    if error_text:
        payload["error_text"] = error_text
    if extra:
        payload.update(extra)
    return payload


async def append_execution_event(
    pool,
    *,
    thread_key: str,
    execution_id: str | None,
    event_kind: str,
    event_json: dict[str, Any],
) -> int:
    return int(
        await pool.fetchval(
            "INSERT INTO agent_execution_events (thread_key, execution_id, event_kind, event_json) "
            "VALUES ($1, $2, $3, $4::jsonb) RETURNING event_id",
            thread_key,
            execution_id,
            event_kind,
            canonical_json(event_json),
        )
    )


async def append_execution_state(
    pool,
    *,
    execution_id: str,
    thread_key: str,
    status: str,
    extra: dict[str, Any] | None = None,
) -> int:
    payload = build_execution_state_payload(
        execution_id=execution_id,
        thread_key=thread_key,
        status=status,
        extra=extra,
    )
    return await append_execution_event(
        pool,
        thread_key=thread_key,
        execution_id=execution_id,
        event_kind="execution_state",
        event_json=payload,
    )


async def get_execution_terminal_snapshot(pool, execution_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT thread_key, status, terminal_reason, result_text, error_text "
        "FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    if not row or not execution_terminal(str(row["status"] or "")):
        return None

    latest_event_id = await pool.fetchval(
        "SELECT COALESCE(MAX(event_id), 0) FROM agent_execution_events WHERE execution_id = $1",
        execution_id,
    )
    return {
        "event_id": int(latest_event_id or 0),
        "event_kind": "execution_state",
        "event_json": build_execution_state_payload(
            execution_id=execution_id,
            thread_key=str(row["thread_key"]),
            status=str(row["status"]),
            terminal_reason=(
                str(row["terminal_reason"])
                if row["terminal_reason"] is not None
                else None
            ),
            result_text=(
                str(row["result_text"])
                if row["result_text"] is not None
                else None
            ),
            error_text=(
                str(row["error_text"])
                if row["error_text"] is not None
                else None
            ),
        ),
    }


async def enqueue_execution(
    pool,
    *,
    thread_key: str,
    assignment_generation: int,
    execute_id: str,
    harness: str | None,
    delivery: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "thread_key": thread_key,
        "assignment_generation": assignment_generation,
        "execute_id": execute_id,
        "harness": harness,
        "delivery": delivery,
        "metadata": metadata,
    }
    req_hash = request_hash(payload)

    existing = await pool.fetchrow(
        "SELECT execution_id, request_hash, status, assignment_generation "
        "FROM agent_execution_requests WHERE thread_key = $1 AND execute_id = $2",
        thread_key,
        execute_id,
    )
    if existing:
        if existing["request_hash"] != req_hash:
            raise ControlPlaneError(
                "IDEMPOTENCY_PAYLOAD_MISMATCH",
                "execute_id was already used with a different payload",
                409,
            )
        return {
            "ok": True,
            "execution_id": existing["execution_id"],
            "execute_id": execute_id,
            "assignment_generation": int(existing["assignment_generation"]),
            "status": existing["status"],
            "final_key": existing["execution_id"],
            "delivery_token": existing["execution_id"],
            "idempotent": True,
        }

    execution_id = f"exe_{uuid.uuid4().hex[:16]}"
    now = dt.datetime.now(dt.timezone.utc)
    silence_deadline = now + dt.timedelta(seconds=EXECUTION_SILENCE_TIMEOUT_S)
    hard_deadline = now + dt.timedelta(seconds=EXECUTION_HARD_TIMEOUT_S)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", thread_key)

            existing = await conn.fetchrow(
                "SELECT execution_id, request_hash, status, assignment_generation "
                "FROM agent_execution_requests WHERE thread_key = $1 AND execute_id = $2",
                thread_key,
                execute_id,
            )
            if existing:
                if existing["request_hash"] != req_hash:
                    raise ControlPlaneError(
                        "IDEMPOTENCY_PAYLOAD_MISMATCH",
                        "execute_id was already used with a different payload",
                        409,
                    )
                return {
                    "ok": True,
                    "execution_id": existing["execution_id"],
                    "execute_id": execute_id,
                    "assignment_generation": int(existing["assignment_generation"]),
                    "status": existing["status"],
                    "final_key": existing["execution_id"],
                    "delivery_token": existing["execution_id"],
                    "idempotent": True,
                }

            active = await conn.fetchrow(
                "SELECT assignment_generation FROM agent_runtime_assignments "
                "WHERE thread_key = $1 AND state = 'active' "
                "ORDER BY assignment_generation DESC LIMIT 1",
                thread_key,
            )
            if not active:
                raise ControlPlaneError(
                    "NO_ACTIVE_ASSIGNMENT",
                    "No active runtime assignment for thread_key",
                    409,
                )
            active_generation = int(active["assignment_generation"])
            if active_generation != int(assignment_generation):
                raise ControlPlaneError(
                    "ASSIGNMENT_GENERATION_STALE",
                    "assignment_generation does not match the active assignment",
                    409,
                )

            await conn.execute(
                "INSERT INTO agent_execution_requests ("
                "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
                "delivery, metadata, last_progress_at, silence_deadline_at, hard_deadline_at"
                ") VALUES ($1, $2, $3, $4, $5, 'queued', $6::jsonb, $7::jsonb, NOW(), $8, $9)",
                execution_id,
                thread_key,
                assignment_generation,
                execute_id,
                req_hash,
                canonical_json(delivery),
                canonical_json(metadata),
                silence_deadline,
                hard_deadline,
            )
            await conn.execute(
                "INSERT INTO agent_final_delivery_outbox ("
                "execution_id, thread_key, delivery, state"
                ") VALUES ($1, $2, $3::jsonb, 'awaiting_terminal') "
                "ON CONFLICT (execution_id) DO NOTHING",
                execution_id,
                thread_key,
                canonical_json(delivery),
            )
            await append_execution_state(
                conn,
                execution_id=execution_id,
                thread_key=thread_key,
                status="queued",
            )

    _worker_wake.set()

    resolved_harness = str(active["harness"] or harness or "amp")
    log.info(
        "execute_queued",
        thread_key=thread_key,
        execution_id=execution_id,
        assignment_generation=assignment_generation,
        harness=resolved_harness,
        engine=active["engine"],
        persona_id=active["persona_id"],
        prompt_ref=active["prompt_ref"],
        prompt_sha=active["effective_agents_md_sha256"],
        delivery_platform=_delivery_platform(delivery),
    )
    record_execution_enqueued(resolved_harness)

    return {
        "ok": True,
        "execution_id": execution_id,
        "execute_id": execute_id,
        "assignment_generation": assignment_generation,
        "status": "queued",
        "final_key": execution_id,
        "delivery_token": execution_id,
    }


async def get_execution(pool, execution_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT execution_id, thread_key, assignment_generation, execute_id, status, "
        "durable_turn_id, terminal_reason, result_text, error_text, created_at, "
        "started_at, completed_at, updated_at "
        "FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    if not row:
        return None
    return {
        "execution_id": row["execution_id"],
        "thread_key": row["thread_key"],
        "assignment_generation": int(row["assignment_generation"]),
        "execute_id": row["execute_id"],
        "status": row["status"],
        "durable_turn_id": row["durable_turn_id"],
        "terminal_reason": row["terminal_reason"],
        "result_text": row["result_text"],
        "error_text": row["error_text"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


async def list_thread_executions(pool, thread_key: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        "SELECT execution_id, execute_id, status, created_at, started_at, completed_at "
        "FROM agent_execution_requests WHERE thread_key = $1 "
        "ORDER BY created_at DESC LIMIT $2",
        thread_key,
        max(1, min(limit, 100)),
    )
    return [
        {
            "execution_id": r["execution_id"],
            "execute_id": r["execute_id"],
            "status": r["status"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
        }
        for r in rows
    ]


async def cancel_execution(pool, execution_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT execution_id, thread_key, assignment_generation, status FROM agent_execution_requests "
        "WHERE execution_id = $1",
        execution_id,
    )
    if not row:
        return None

    status = row["status"]
    thread_key = row["thread_key"]
    assignment_generation = int(row["assignment_generation"])
    if execution_terminal(status):
        return {
            "ok": True,
            "execution_id": execution_id,
            "thread_key": thread_key,
            "status": status,
            "idempotent": True,
        }

    if status == "cancel_requested":
        return {
            "ok": True,
            "execution_id": execution_id,
            "thread_key": thread_key,
            "status": status,
            "idempotent": True,
        }

    if status == "queued":
        await _mark_execution_terminal(
            pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status="cancelled",
            terminal_reason="cancelled",
            result_text="",
            error_text="cancelled",
        )
    else:
        await pool.execute(
            "UPDATE agent_execution_requests SET status = 'cancel_requested', updated_at = NOW() "
            "WHERE execution_id = $1",
            execution_id,
        )
        await append_execution_state(
            pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status="cancel_requested",
        )
        await pool.execute(
            "UPDATE sandbox_sessions SET state = 'idle', inflight_turn_id = NULL, inflight_turn_input = NULL, "
            "inflight_started_at = NULL, inflight_attempts = 0, updated_at = NOW() "
            "WHERE thread_key = $1",
            thread_key,
        )
        runtime_id = await pool.fetchval(
            "SELECT runtime_id FROM agent_runtime_assignments "
            "WHERE thread_key = $1 AND assignment_generation = $2",
            thread_key,
            assignment_generation,
        )
        if runtime_id:
            try:
                await get_backend().interrupt_by_id(str(runtime_id))
            except NotImplementedError:
                log.warning(
                    "execution_interrupt_not_supported",
                    thread_key=thread_key,
                    execution_id=execution_id,
                    runtime_id=str(runtime_id)[:12],
                )
            except Exception:
                log.warning(
                    "execution_interrupt_failed",
                    thread_key=thread_key,
                    execution_id=execution_id,
                    runtime_id=str(runtime_id)[:12],
                    exc_info=True,
                )

    _worker_wake.set()
    return {
        "ok": True,
        "execution_id": execution_id,
        "thread_key": thread_key,
        "status": "cancel_requested" if status != "queued" else "cancelled",
    }


async def release_assignment(
    pool,
    *,
    thread_key: str,
    release_id: str,
    cancel_inflight: bool,
) -> dict[str, Any]:
    payload = {
        "thread_key": thread_key,
        "release_id": release_id,
        "cancel_inflight": cancel_inflight,
    }
    req_hash = request_hash(payload)

    response: dict[str, Any]
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", thread_key)

            existing = await conn.fetchrow(
                "SELECT request_hash, response_json FROM agent_release_requests "
                "WHERE thread_key = $1 AND release_id = $2",
                thread_key,
                release_id,
            )
            if existing:
                if existing["request_hash"] != req_hash:
                    raise ControlPlaneError(
                        "IDEMPOTENCY_PAYLOAD_MISMATCH",
                        "release_id was already used with a different payload",
                        409,
                    )
                return decode_jsonb(existing["response_json"], {})

            active = await conn.fetchrow(
                "SELECT assignment_generation, runtime_id FROM agent_runtime_assignments "
                "WHERE thread_key = $1 AND state = 'active' "
                "ORDER BY assignment_generation DESC LIMIT 1",
                thread_key,
            )
            if not active:
                response = {
                    "ok": True,
                    "thread_key": thread_key,
                    "released": False,
                    "reason": "no_active_assignment",
                }
            else:
                generation = int(active["assignment_generation"])
                await conn.execute(
                    "UPDATE agent_runtime_assignments SET state = 'released', released_at = NOW(), updated_at = NOW() "
                    "WHERE thread_key = $1 AND assignment_generation = $2",
                    thread_key,
                    generation,
                )
                if cancel_inflight:
                    await conn.execute(
                        "UPDATE agent_execution_requests SET status = 'cancelled', terminal_reason = 'released', "
                        "completed_at = NOW(), updated_at = NOW() "
                        "WHERE thread_key = $1 AND status IN ('queued', 'running', 'cancel_requested', 'retry_wait')",
                        thread_key,
                    )
                response = {
                    "ok": True,
                    "thread_key": thread_key,
                    "released": True,
                    "assignment_generation": generation,
                    "runtime_id": active["runtime_id"],
                }

            await conn.execute(
                "INSERT INTO agent_release_requests (thread_key, release_id, request_hash, response_json) "
                "VALUES ($1, $2, $3, $4::jsonb)",
                thread_key,
                release_id,
                req_hash,
                canonical_json(response),
            )
    if response.get("released"):
        with contextlib.suppress(Exception):
            await stop_session(thread_key)
    log.info(
        "thread_released",
        thread_key=thread_key,
        release_id=release_id,
        released=response.get("released"),
        assignment_generation=response.get("assignment_generation"),
        runtime_id=response.get("runtime_id"),
        cancel_inflight=cancel_inflight,
    )
    return response


async def _mark_execution_terminal(
    pool,
    *,
    execution_id: str,
    thread_key: str,
    status: str,
    terminal_reason: str,
    result_text: str,
    error_text: str | None,
) -> None:
    next_attempt_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(
        seconds=FINAL_DELIVERY_READY_GRACE_S,
    )
    completed_at = dt.datetime.now(dt.timezone.utc)
    row = await pool.fetchrow(
        "UPDATE agent_execution_requests SET status = $1, terminal_reason = $2, "
        "result_text = $3, error_text = $4, completed_at = $6, "
        "worker_id = NULL, worker_lease_expires_at = NULL, updated_at = NOW() "
        "WHERE execution_id = $5 "
        "RETURNING started_at, assignment_generation",
        status,
        terminal_reason,
        result_text,
        error_text,
        execution_id,
        completed_at,
    )
    harness = None
    engine = None
    persona_id = None
    prompt_ref = None
    prompt_sha = None
    if row:
        ag = row["assignment_generation"]
        assignment_row = await pool.fetchrow(
            "SELECT harness, engine, persona_id, prompt_ref, effective_agents_md_sha256 "
            "FROM agent_runtime_assignments WHERE thread_key = $1 AND assignment_generation = $2",
            thread_key,
            ag,
        )
        if assignment_row:
            harness = assignment_row["harness"]
            engine = assignment_row["engine"]
            persona_id = assignment_row["persona_id"]
            prompt_ref = assignment_row["prompt_ref"]
            prompt_sha = assignment_row["effective_agents_md_sha256"]
    duration_s = 0.0
    if row and row.get("started_at") and completed_at:
        duration_s = (completed_at - row["started_at"]).total_seconds()
    log.info(
        "execute_completed",
        execution_id=execution_id,
        thread_key=thread_key,
        status=status,
        terminal_reason=terminal_reason,
        duration_s=round(duration_s, 2),
        harness=harness,
        engine=engine,
        persona_id=persona_id,
        prompt_ref=prompt_ref,
        prompt_sha=prompt_sha,
        result_size_bytes=payload_size_bytes(result_text),
        error_size_bytes=payload_size_bytes(error_text) if error_text else 0,
    )
    record_agent_execution(harness, status, duration_s)
    record_execution_terminal(harness or "unknown", status, terminal_reason)
    await append_execution_state(
        pool,
        execution_id=execution_id,
        thread_key=thread_key,
        status=status,
        extra={
            "terminal_reason": terminal_reason,
            "result_text": result_text,
            **({"error_text": error_text} if error_text else {}),
        },
    )
    await pool.execute(
        "UPDATE agent_final_delivery_outbox SET state = 'pending', final_payload = $1::jsonb, "
        "next_attempt_at = $2, updated_at = NOW() "
        "WHERE execution_id = $3",
        canonical_json(
            {
                "execution_id": execution_id,
                "thread_key": thread_key,
                "status": status,
                "terminal_reason": terminal_reason,
                "result_text": result_text,
                **({"error_text": error_text} if error_text else {}),
            }
        ),
        next_attempt_at,
        execution_id,
    )
    await append_execution_event(
        pool,
        thread_key=thread_key,
        execution_id=execution_id,
        event_kind="final_delivery_ready",
        event_json={
            "type": "final_delivery.ready",
            "execution_id": execution_id,
            "thread_key": thread_key,
            "status": status,
            "terminal_reason": terminal_reason,
            "result_text": result_text,
            **({"error_text": error_text} if error_text else {}),
        },
    )
    log.info(
        "final_delivery_ready",
        execution_id=execution_id,
        thread_key=thread_key,
        status=status,
        terminal_reason=terminal_reason,
    )


async def _touch_execution_progress(
    pool,
    execution_id: str,
    *,
    timeout_s: float | None = None,
) -> dt.datetime:
    silence_timeout_s = float(
        EXECUTION_SILENCE_TIMEOUT_S if timeout_s is None else timeout_s
    )
    row = await pool.fetchrow(
        "UPDATE agent_execution_requests SET last_progress_at = NOW(), "
        "silence_deadline_at = NOW() + make_interval(secs => $1::double precision), "
        "worker_lease_expires_at = NOW() + make_interval(secs => $2::double precision), "
        "updated_at = NOW() WHERE execution_id = $3 RETURNING silence_deadline_at",
        silence_timeout_s,
        float(EXECUTION_WORKER_LEASE_S),
        execution_id,
    )
    if row and row["silence_deadline_at"]:
        return row["silence_deadline_at"]
    return dt.datetime.now(dt.timezone.utc) + dt.timedelta(
        seconds=silence_timeout_s
    )


async def _heartbeat_execution_lease(pool, execution_id: str) -> None:
    await pool.execute(
        "UPDATE agent_execution_requests SET "
        "worker_lease_expires_at = NOW() + make_interval(secs => $1::double precision), "
        "updated_at = NOW() "
        "WHERE execution_id = $2 AND status IN ('running', 'cancel_requested', 'retry_wait')",
        float(EXECUTION_WORKER_LEASE_S),
        execution_id,
    )


async def _stop_execution_session(thread_key: str, *, reason: str) -> None:
    try:
        await stop_session(thread_key)
    except Exception:
        log.warning(
            "execution_session_stop_failed",
            thread_key=thread_key,
            reason=reason,
            exc_info=True,
        )


async def _claim_next_execution(pool) -> dict[str, Any] | None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            candidates = await conn.fetch(
                "SELECT er.execution_id, er.thread_key "
                "FROM agent_execution_requests er "
                "WHERE ("
                "  er.status = 'queued' "
                "  OR ("
                "    er.status = 'cancel_requested' "
                "    AND (er.worker_lease_expires_at IS NULL OR er.worker_lease_expires_at <= NOW())"
                "  )"
                ") "
                "AND NOT EXISTS ("
                "  SELECT 1 FROM agent_execution_requests active "
                "  WHERE active.thread_key = er.thread_key "
                "  AND active.execution_id <> er.execution_id "
                "  AND ("
                "    active.status IN ('running', 'retry_wait') "
                "    OR ("
                "      active.status = 'cancel_requested' "
                "      AND active.worker_lease_expires_at > NOW()"
                "    )"
                "  )"
                ") "
                "ORDER BY er.created_at ASC "
                "LIMIT 32 "
                "FOR UPDATE SKIP LOCKED"
            )
            for candidate in candidates:
                thread_key = str(candidate["thread_key"])
                lock_acquired = await conn.fetchval(
                    "SELECT pg_try_advisory_xact_lock("
                    "hashtext('agent_execution_thread'), hashtext($1)"
                    ")",
                    thread_key,
                )
                if not lock_acquired:
                    continue
                has_active = await conn.fetchval(
                    "SELECT 1 FROM agent_execution_requests "
                    "WHERE thread_key = $1 "
                    "AND execution_id <> $2 "
                    "AND ("
                    "  status IN ('running', 'retry_wait') "
                    "  OR (status = 'cancel_requested' AND worker_lease_expires_at > NOW())"
                    ") "
                    "LIMIT 1",
                    thread_key,
                    candidate["execution_id"],
                )
                if has_active:
                    continue
                row = await conn.fetchrow(
                    "UPDATE agent_execution_requests er "
                    "SET status = CASE WHEN er.status = 'queued' THEN 'running' ELSE er.status END, "
                    "claimed_at = NOW(), "
                    "started_at = COALESCE(er.started_at, NOW()), "
                    "last_progress_at = COALESCE(er.last_progress_at, NOW()), "
                    "silence_deadline_at = COALESCE(er.silence_deadline_at, NOW() + make_interval(secs => $1::double precision)), "
                    "worker_id = $2, "
                    "worker_lease_expires_at = NOW() + make_interval(secs => $3::double precision), "
                    "updated_at = NOW() "
                    "WHERE er.execution_id = $4 AND er.status IN ('queued', 'cancel_requested') "
                    "RETURNING er.execution_id, er.thread_key, er.assignment_generation, "
                    "er.execute_id, er.durable_turn_id, er.status, er.delivery, er.metadata, er.silence_deadline_at, "
                    "er.hard_deadline_at, er.created_at, er.claimed_at",
                    float(EXECUTION_SILENCE_TIMEOUT_S),
                    WORKER_INSTANCE_ID,
                    float(EXECUTION_WORKER_LEASE_S),
                    candidate["execution_id"],
                )
                if row:
                    return dict(row)
    return None


async def _process_execution(pool, row: dict[str, Any]) -> None:
    execution_id = row["execution_id"]
    thread_key = row["thread_key"]
    assignment_generation = int(row["assignment_generation"])
    execution_status = str(row.get("status") or "running")
    delivery = decode_jsonb(row.get("delivery"), {})

    if execution_status == "cancel_requested":
        await _stop_execution_session(
            thread_key,
            reason="cancel_requested",
        )
        await _mark_execution_terminal(
            pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status="cancelled",
            terminal_reason="cancel_requested",
            result_text="",
            error_text="cancel_requested",
        )
        return

    await append_execution_state(
        pool,
        execution_id=execution_id,
        thread_key=thread_key,
        status="running",
    )

    assignment = await pool.fetchrow(
        "SELECT harness, engine, runtime_id, agents_md_override, persona_id, prompt_ref, effective_agents_md_sha256 "
        "FROM agent_runtime_assignments "
        "WHERE thread_key = $1 AND assignment_generation = $2",
        thread_key,
        assignment_generation,
    )
    if not assignment:
        await _mark_execution_terminal(
            pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status="failed_permanent",
            terminal_reason="assignment_missing",
            result_text="",
            error_text="assignment not found",
        )
        return

    harness = str(assignment["harness"])
    engine = str(assignment["engine"] or harness)
    persona_id = assignment["persona_id"]
    prompt_ref = assignment["prompt_ref"]
    prompt_sha = assignment["effective_agents_md_sha256"]
    claimed_at = row.get("claimed_at")
    queue_delay_s = (claimed_at - row["created_at"]).total_seconds() if claimed_at and row.get("created_at") else 0
    log.info(
        "execute_claimed",
        execution_id=execution_id,
        thread_key=thread_key,
        harness=harness,
        engine=engine,
        persona_id=persona_id,
        prompt_ref=prompt_ref,
        prompt_sha=prompt_sha,
        queue_delay_s=round(queue_delay_s, 2),
    )
    record_execution_claimed(harness, queue_delay_s)

    if row.get("hard_deadline_at"):
        hard_deadline = row["hard_deadline_at"]
    else:
        hard_deadline = dt.datetime.now(dt.timezone.utc) + dt.timedelta(
            seconds=EXECUTION_HARD_TIMEOUT_S
        )
    silence_deadline = row.get("silence_deadline_at")
    if not isinstance(silence_deadline, dt.datetime):
        silence_deadline = dt.datetime.now(dt.timezone.utc) + dt.timedelta(
            seconds=EXECUTION_SILENCE_TIMEOUT_S
        )

    session = await get_or_spawn(
        thread_key,
        assignment["harness"],
        engine=assignment["engine"],
    )
    if session.sandbox_id != assignment["runtime_id"]:
        await pool.execute(
            "UPDATE agent_runtime_assignments SET runtime_id = $1, updated_at = NOW() "
            "WHERE thread_key = $2 AND assignment_generation = $3",
            session.sandbox_id,
            thread_key,
            assignment_generation,
        )

    assignment_override = assignment["agents_md_override"]
    if assignment_override:
        await _write_agents_override(session.sandbox_id, str(assignment_override))

    durable_turn_id = str(row.get("durable_turn_id") or "")
    if durable_turn_id:
        await _heartbeat_execution_lease(pool, execution_id)
    else:
        inject_result = await inject_stdin(
            session,
            "",
            platform=delivery.get("platform") if isinstance(delivery, dict) else None,
            user_id=delivery.get("recipient_user_id") if isinstance(delivery, dict) else None,
        )
        durable_turn_id = str(inject_result.get("durable_turn_id") or "")
        await pool.execute(
            "UPDATE agent_execution_requests SET durable_turn_id = $1, updated_at = NOW() "
            "WHERE execution_id = $2",
            durable_turn_id or None,
            execution_id,
        )
        if inject_result.get("injected"):
            await pool.execute(
                "UPDATE agent_message_requests SET delivered_execution_id = $1 "
                "WHERE thread_key = $2 AND assignment_generation = $3 AND delivered_execution_id IS NULL",
                execution_id,
                thread_key,
                assignment_generation,
            )
            silence_deadline = await _touch_execution_progress(pool, execution_id)

    backend = get_backend()
    await backend.attach(session)
    rt = _get_runtime(session.sandbox_id)
    observations = ExecutionObservationAccumulator()
    started_at = claimed_at or row.get("created_at")

    async def _finalize_execution(
        *,
        status: str,
        terminal_reason: str,
        result_text: str,
        error_text: str | None,
    ) -> None:
        duration_s = 0.0
        completed_at = dt.datetime.now(dt.timezone.utc)
        if isinstance(started_at, dt.datetime):
            duration_s = max((completed_at - started_at).total_seconds(), 0.0)
        summary_payload = observations.build_summary(
            execution_id=execution_id,
            thread_key=thread_key,
            assignment_generation=assignment_generation,
            harness=harness,
            engine=engine,
            persona_id=persona_id,
            prompt_ref=prompt_ref,
            prompt_sha=prompt_sha,
            status=status,
            terminal_reason=terminal_reason,
            duration_s=duration_s,
        )
        await append_execution_event(
            pool,
            thread_key=thread_key,
            execution_id=execution_id,
            event_kind="execution_summary",
            event_json=summary_payload,
        )
        log.info("execution_summary", **summary_payload)
        await _mark_execution_terminal(
            pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status=status,
            terminal_reason=terminal_reason,
            result_text=result_text,
            error_text=error_text,
        )

    execution_started_payload = {
        "type": "obs.execution_started",
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": assignment_generation,
        "harness": harness,
        "engine": engine,
        "persona_id": persona_id,
        "prompt_ref": prompt_ref,
        "prompt_sha": prompt_sha,
        "runtime_id": session.sandbox_id,
        "queue_delay_s": round(queue_delay_s, 3),
        "delivery_platform": _delivery_platform(delivery),
    }
    await append_execution_event(
        pool,
        thread_key=thread_key,
        execution_id=execution_id,
        event_kind="execution_started",
        event_json=execution_started_payload,
    )
    log.info("execute_started", **execution_started_payload)

    turn_done_event: dict[str, Any] | None = None
    pending_event: asyncio.Task | None = None
    stream = _stream_stdout(
        session,
        backend,
        rt,
        rt.turn_counter,
        dt.datetime.now(dt.timezone.utc).timestamp(),
    )
    try:
        stream_iter = stream.__aiter__()
        while True:
            now = dt.datetime.now(dt.timezone.utc)
            if now >= hard_deadline:
                await _finalize_execution(
                    status="failed_permanent",
                    terminal_reason="hard_deadline_exceeded",
                    result_text="",
                    error_text="execution exceeded hard deadline",
                )
                await _stop_execution_session(
                    thread_key,
                    reason="hard_deadline_exceeded",
                )
                record_execution_watchdog_timeout(harness, "hard_deadline_exceeded")
                return
            if now >= silence_deadline:
                await _finalize_execution(
                    status="failed_permanent",
                    terminal_reason="silence_deadline_exceeded",
                    result_text="",
                    error_text="execution made no progress before silence deadline",
                )
                await _stop_execution_session(
                    thread_key,
                    reason="silence_deadline_exceeded",
                )
                record_execution_watchdog_timeout(harness, "silence_deadline_exceeded")
                return

            if pending_event is None:
                pending_event = asyncio.create_task(stream_iter.__anext__())

            wait_s = min(
                max((hard_deadline - now).total_seconds(), 0.0),
                max((silence_deadline - now).total_seconds(), 0.0),
                EXECUTION_WATCHDOG_POLL_S,
            )
            done, _ = await asyncio.wait({pending_event}, timeout=wait_s)
            if not done:
                await _heartbeat_execution_lease(pool, execution_id)
                status_row = await pool.fetchrow(
                    "SELECT status FROM agent_execution_requests WHERE execution_id = $1",
                    execution_id,
                )
                if status_row and status_row["status"] == "cancel_requested":
                    await _stop_execution_session(
                        thread_key,
                        reason="cancel_requested",
                    )
                    await _finalize_execution(
                        status="cancelled",
                        terminal_reason="cancel_requested",
                        result_text="",
                        error_text="cancel_requested",
                    )
                    return
                continue

            try:
                evt = await pending_event
            except StopAsyncIteration:
                break
            finally:
                pending_event = None

            payload = decode_jsonb(evt.get("data"), {})
            if not isinstance(payload, dict):
                continue
            observations.raw_event_count += 1
            await append_execution_event(
                pool,
                thread_key=thread_key,
                execution_id=execution_id,
                event_kind="amp_raw_event",
                event_json=payload,
            )
            for canonical_event in normalize_harness_event(engine, payload):
                projected = project_execution_observations(
                    canonical_event,
                    execution_id=execution_id,
                    thread_key=thread_key,
                    assignment_generation=assignment_generation,
                    harness=harness,
                    engine=engine,
                    persona_id=persona_id,
                    prompt_ref=prompt_ref,
                    prompt_sha=prompt_sha,
                )
                for event_kind, observation_payload in projected:
                    await append_execution_event(
                        pool,
                        thread_key=thread_key,
                        execution_id=execution_id,
                        event_kind=event_kind,
                        event_json=observation_payload,
                    )
                    log.info(event_kind, **observation_payload)
                    observations.observe(event_kind, observation_payload)
                    if event_kind == "usage_observed":
                        usage_metrics = extract_usage_metrics(
                            {
                                "input_tokens": observation_payload.get("input_tokens"),
                                "output_tokens": observation_payload.get("output_tokens"),
                                "cache_creation_input_tokens": observation_payload.get("cache_creation_input_tokens"),
                                "cache_read_input_tokens": observation_payload.get("cache_read_input_tokens"),
                                "cost_usd": observation_payload.get("cost_usd"),
                            },
                            model=observation_payload.get("model") if isinstance(observation_payload.get("model"), str) else None,
                        )
                        record_usage_observation(
                            harness=harness,
                            model=usage_metrics.get("model"),
                            input_tokens=usage_metrics["input_tokens"],
                            output_tokens=usage_metrics["output_tokens"],
                            cache_creation_input_tokens=usage_metrics["cache_creation_input_tokens"],
                            cache_read_input_tokens=usage_metrics["cache_read_input_tokens"],
                            cost_usd=usage_metrics["cost_usd"],
                        )
            silence_deadline = await _touch_execution_progress(
                pool,
                execution_id,
                timeout_s=_event_silence_timeout_s(payload),
            )

            status_row = await pool.fetchrow(
                "SELECT status FROM agent_execution_requests WHERE execution_id = $1",
                execution_id,
            )
            if status_row and status_row["status"] == "cancel_requested":
                await _stop_execution_session(
                    thread_key,
                    reason="cancel_requested",
                )
                await _finalize_execution(
                    status="cancelled",
                    terminal_reason="cancel_requested",
                    result_text="",
                    error_text="cancel_requested",
                )
                return

            if payload.get("type") == "turn.done":
                turn_done_event = payload
                break
    except Exception as exc:
        await _finalize_execution(
            status="failed_permanent",
            terminal_reason="execution_error",
            result_text="",
            error_text=str(exc),
        )
        return
    finally:
        if pending_event is not None:
            pending_event.cancel()
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration, Exception):
                await pending_event
        with contextlib.suppress(Exception):
            await stream.aclose()

    if turn_done_event is None:
        await _finalize_execution(
            status="failed_permanent",
            terminal_reason="stream_ended_without_turn_done",
            result_text="",
            error_text="stream ended before terminal turn.done",
        )
        await _stop_execution_session(
            thread_key,
            reason="stream_ended_without_turn_done",
        )
        return

    result_text = str(turn_done_event.get("result") or "")
    error_text = turn_done_event.get("error")
    if not isinstance(error_text, str):
        error_text = ""
    is_error = bool(turn_done_event.get("is_error")) or bool(error_text)
    if is_error:
        terminal_reason = "harness_error"
        combined_error = (error_text or result_text or "harness_error").strip()
        if "timed out while reconnecting" in combined_error.lower():
            terminal_reason = "amp_reconnect_timeout"
        await _finalize_execution(
            status="failed_permanent",
            terminal_reason=terminal_reason,
            result_text=result_text,
            error_text=combined_error,
        )
        return

    await _finalize_execution(
        status="completed",
        terminal_reason="completed",
        result_text=result_text,
        error_text=None,
    )


async def _recover_stale_running(pool) -> None:
    await pool.execute(
        "UPDATE agent_execution_requests SET "
        "status = CASE WHEN status IN ('running', 'retry_wait') THEN 'queued' ELSE status END, "
        "worker_id = NULL, worker_lease_expires_at = NULL, updated_at = NOW() "
        "WHERE status IN ('running', 'retry_wait', 'cancel_requested') "
        "AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at <= NOW())",
    )


async def _recover_stale_running_if_due(pool) -> None:
    global _last_recover_stale_running_at
    now = asyncio.get_running_loop().time()
    if now - _last_recover_stale_running_at < EXECUTION_STALE_RECOVERY_INTERVAL_S:
        return
    async with _recover_stale_running_lock:
        now = asyncio.get_running_loop().time()
        if now - _last_recover_stale_running_at < EXECUTION_STALE_RECOVERY_INTERVAL_S:
            return
        await _recover_stale_running(pool)
        _last_recover_stale_running_at = now


async def _execution_worker_loop(pool) -> None:
    while True:
        try:
            await _recover_stale_running_if_due(pool)
            row = await _claim_next_execution(pool)
            if row is None:
                _worker_wake.clear()
                try:
                    await asyncio.wait_for(_worker_wake.wait(), timeout=EXECUTION_RECONCILE_INTERVAL_S)
                except TimeoutError:
                    pass
                continue
            await _process_execution(pool, row)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("execution_worker_tick_error", exc_info=True)
            await asyncio.sleep(0.5)


async def start_execution_worker(pool) -> None:
    global _last_recover_stale_running_at, _worker_tasks
    if any(not task.done() for task in _worker_tasks):
        return
    _last_recover_stale_running_at = 0.0
    _worker_tasks = [
        asyncio.create_task(
            _execution_worker_loop(pool),
            name=f"execution-worker-{index + 1}",
        )
        for index in range(EXECUTION_WORKER_CONCURRENCY)
    ]


async def stop_execution_worker() -> None:
    global _last_recover_stale_running_at, _worker_tasks
    if not _worker_tasks:
        return
    tasks = _worker_tasks
    _worker_tasks = []
    _last_recover_stale_running_at = 0.0
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


def wake_execution_worker() -> None:
    _worker_wake.set()
