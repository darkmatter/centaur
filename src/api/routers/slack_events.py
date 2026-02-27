from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time
from collections import OrderedDict

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from starlette.responses import JSONResponse

from api.deps import verify_api_key
from shared.engineer.orchestrator import EngineerOrchestrator
from shared.engineer.session import (
    create_session,
    get_session,
    has_active_session,
    register_task,
    remove_session,
)
from shared.engineer.settings import EngineerSettings, engineer_settings

router = APIRouter(prefix="/slack")
log = structlog.get_logger()

_MENTION_RE = re.compile(r"<@[^>]+>")
_seen_events: OrderedDict[str, float] = OrderedDict()
_seen_events_lock = asyncio.Lock()
_SEEN_EVENT_TTL_SECONDS = 3600.0
_MAX_SEEN_EVENTS = 4000
_MAX_SLACK_MESSAGE_CHARS = 3800
_ENG_FLAG_RE = re.compile(r"(^|\s)--eng(?=\s|$)", re.IGNORECASE)
_HARNESS_EQ_RE = re.compile(r"\bharness\s*=\s*(amp|claude-code|codex|pi-mono)\b", re.IGNORECASE)
_ENGINE_FLAG_RE = re.compile(
    r"(^|\s)--engine\s+(amp|claude-code|codex|pi-mono)(?=\s|$)", re.IGNORECASE
)
_MODEL_EQ_RE = re.compile(r"\bmodel\s*=\s*([A-Za-z0-9._-]+)\b", re.IGNORECASE)
_MODEL_FLAG_RE = re.compile(r"(^|\s)--model\s+([A-Za-z0-9._-]+)(?=\s|$)", re.IGNORECASE)
_MODEL_FLAG_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(^|\s)--amp(?=\s|$)", re.IGNORECASE), "amp"),
    (re.compile(r"(^|\s)--claude(?=\s|$)", re.IGNORECASE), "claude-code"),
    (re.compile(r"(^|\s)--claude-code(?=\s|$)", re.IGNORECASE), "claude-code"),
    (re.compile(r"(^|\s)--codex(?=\s|$)", re.IGNORECASE), "codex"),
    (re.compile(r"(^|\s)--pi(?=\s|$)", re.IGNORECASE), "pi-mono"),
    (re.compile(r"(^|\s)--pi-mono(?=\s|$)", re.IGNORECASE), "pi-mono"),
]
_session_start_locks: dict[str, asyncio.Lock] = {}


def _normalize_attachments(items: list[dict[str, str]] | None) -> list[dict[str, str]]:
    if not items:
        return []
    normalized: list[dict[str, str]] = []
    for item in items:
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()
        if not name or not url:
            continue
        normalized.append({"name": name, "url": url})
    return normalized


def _attachments_from_event(event: dict) -> list[dict[str, str]]:
    files = event.get("files", [])
    if not isinstance(files, list):
        return []
    parsed: list[dict[str, str]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("title") or "attachment").strip()
        url = str(
            item.get("url_private_download")
            or item.get("url_private")
            or item.get("permalink")
            or ""
        ).strip()
        if not name or not url:
            continue
        parsed.append({"name": name, "url": url})
    return parsed


def _append_attachments(text: str, attachments: list[dict[str, str]] | None) -> str:
    items = _normalize_attachments(attachments)
    if not items:
        return text
    lines = ["Attachments:"]
    for item in items:
        lines.append(f"- {item['name']}: {item['url']}")
    return f"{text}\n\n" + "\n".join(lines)


def _get_start_lock(thread_key: str) -> asyncio.Lock:
    return _session_start_locks.setdefault(thread_key, asyncio.Lock())


async def _mark_event_seen(event_id: str) -> bool:
    now = time.time()
    async with _seen_events_lock:
        expired = [evt for evt, ts in _seen_events.items() if now - ts > _SEEN_EVENT_TTL_SECONDS]
        for evt in expired:
            _seen_events.pop(evt, None)
        if event_id in _seen_events:
            _seen_events.move_to_end(event_id)
            return True
        _seen_events[event_id] = now
        while len(_seen_events) > _MAX_SEEN_EVENTS:
            _seen_events.popitem(last=False)
    return False


def _verify_slack_signature(request: Request, body: bytes, signing_secret: str) -> bool:
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")
    if not timestamp or not signature:
        return False

    try:
        ts = int(timestamp)
    except ValueError:
        return False

    if abs(time.time() - ts) > 60 * 5:
        return False

    basestring = f"v0:{timestamp}:{body.decode('utf-8', errors='replace')}"
    digest = (
        "v0="
        + hmac.new(
            signing_secret.encode("utf-8"),
            basestring.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    )
    return hmac.compare_digest(digest, signature)


def _extract_task_text(text: str) -> str:
    return _MENTION_RE.sub("", text).strip()


def _parse_engineer_directives(text: str) -> tuple[str, bool, str | None]:
    """Return (task_text, eng_enabled, model_preference)."""
    cleaned = _extract_task_text(text)
    eng_enabled = bool(_ENG_FLAG_RE.search(cleaned))
    if eng_enabled:
        cleaned = _ENG_FLAG_RE.sub(" ", cleaned)

    model_preference: str | None = None
    kv = _HARNESS_EQ_RE.search(cleaned)
    if kv:
        model_preference = kv.group(1).lower()
        cleaned = _HARNESS_EQ_RE.sub(" ", cleaned)

    for pattern, preference in _MODEL_FLAG_PATTERNS:
        if pattern.search(cleaned):
            model_preference = preference
            cleaned = pattern.sub(" ", cleaned)

    engine_flag = _ENGINE_FLAG_RE.search(cleaned)
    if engine_flag:
        model_preference = engine_flag.group(2).lower()
        cleaned = _ENGINE_FLAG_RE.sub(" ", cleaned)

    model_eq = _MODEL_EQ_RE.search(cleaned)
    if model_eq:
        model_preference = model_eq.group(1)
        cleaned = _MODEL_EQ_RE.sub(" ", cleaned)

    model_flag = _MODEL_FLAG_RE.search(cleaned)
    if model_flag:
        model_preference = model_flag.group(2)
        cleaned = _MODEL_FLAG_RE.sub(" ", cleaned)

    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned, eng_enabled, model_preference


async def _post_thread_message(
    *,
    token: str,
    channel: str,
    thread_ts: str,
    text: str,
) -> None:
    safe_text = text.strip()
    if len(safe_text) > _MAX_SLACK_MESSAGE_CHARS:
        safe_text = safe_text[: _MAX_SLACK_MESSAGE_CHARS - 18].rstrip() + "\n\n... (truncated)"
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "channel": channel,
        "thread_ts": thread_ts,
        "text": safe_text,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            "https://slack.com/api/chat.postMessage",
            headers=headers,
            json=payload,
        )
    if resp.status_code >= 300:
        raise RuntimeError(f"Slack message failed: {resp.status_code} {resp.text}")
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Slack message failed: {data}")


def _route_reply_to_session(thread_key: str, reply_text: str) -> str:
    if not has_active_session(thread_key):
        return "no_active_session"
    session = get_session(thread_key)
    if session is None:
        return "no_active_session"
    session.receive_user_reply(reply_text)
    return "accepted"


async def _start_engineer_session(
    *,
    settings: EngineerSettings,
    bot_token: str,
    channel: str,
    thread_ts: str,
    thread_key: str,
    task_text: str,
    model_preference: str | None,
) -> dict[str, str]:
    async with _get_start_lock(thread_key):
        if has_active_session(thread_key):
            existing = get_session(thread_key)
            return {"status": "already_running", "run_id": existing.run_id if existing else ""}

        session = create_session(thread_key, task_text)
        session.model_preference = model_preference

        async def _send(text: str) -> None:
            try:
                await _post_thread_message(
                    token=bot_token,
                    channel=channel,
                    thread_ts=thread_ts,
                    text=text,
                )
            except Exception:
                log.exception("engineer_message_failed", channel=channel)

        async def _run() -> None:
            try:
                preference_msg = f" (model preference: {model_preference})" if model_preference else ""
                await _send(f"Engineer started{preference_msg}: `{task_text}`")
                orchestrator = EngineerOrchestrator(
                    settings=settings,
                    model_preference=model_preference,
                )
                result = await orchestrator.run(session, post_message=_send)

                if result.success and result.pr_url:
                    await _send(f"Engineer complete! PR: {result.pr_url}")
                elif not result.success:
                    await _send(f"Engineer failed: {result.error or 'unknown error'}")
            except Exception:
                log.exception("engineer_task_crashed", thread_key=thread_key)
                await _send("Engineer crashed unexpectedly. Check logs.")
            finally:
                remove_session(thread_key)

        task = asyncio.create_task(_run())
        register_task(thread_key, task)
        return {"status": "started", "run_id": session.run_id}


class EngineerStartRequest(BaseModel):
    thread_key: str
    channel: str
    thread_ts: str
    task: str
    model_preference: str | None = None
    attachments: list[dict[str, str]] | None = None


class EngineerReplyRequest(BaseModel):
    thread_key: str
    reply: str
    attachments: list[dict[str, str]] | None = None


@router.post("/start", dependencies=[Depends(verify_api_key)])
async def start_engineer(payload: EngineerStartRequest) -> JSONResponse:
    settings = engineer_settings
    bot_token = settings.slack_bot_token
    if not bot_token:
        raise HTTPException(status_code=500, detail="Slack bot token is not configured")

    task_text = _append_attachments(payload.task.strip(), payload.attachments)
    if not task_text:
        raise HTTPException(status_code=400, detail="Task must not be empty")

    thread_key = payload.thread_key.strip() or f"{payload.channel}:{payload.thread_ts}"
    if ":" not in thread_key:
        thread_key = f"{payload.channel}:{payload.thread_ts}"

    result = await _start_engineer_session(
        settings=settings,
        bot_token=bot_token,
        channel=payload.channel,
        thread_ts=payload.thread_ts,
        thread_key=thread_key,
        task_text=task_text,
        model_preference=payload.model_preference,
    )
    return JSONResponse(result)


@router.post("/reply", dependencies=[Depends(verify_api_key)])
async def reply_engineer(payload: EngineerReplyRequest) -> JSONResponse:
    thread_key = payload.thread_key.strip()
    reply_text = _append_attachments(payload.reply.strip(), payload.attachments)
    if not thread_key:
        raise HTTPException(status_code=400, detail="thread_key is required")
    if not reply_text:
        return JSONResponse({"status": "ignored_empty"})
    status = _route_reply_to_session(thread_key, reply_text)
    return JSONResponse({"status": status})


@router.post("/events")
async def slack_events(request: Request) -> JSONResponse:
    body = await request.body()
    settings = engineer_settings

    if not settings.slack_signing_secret:
        raise HTTPException(status_code=500, detail="Slack signing secret is not configured")

    if not _verify_slack_signature(request, body, settings.slack_signing_secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    payload = json.loads(body.decode("utf-8"))
    if payload.get("type") == "url_verification":
        return JSONResponse({"challenge": payload.get("challenge", "")})

    if payload.get("type") != "event_callback":
        return JSONResponse({"ok": True})

    event = payload.get("event", {})
    event_id = str(payload.get("event_id", ""))
    event_type = str(event.get("type", ""))
    if event_type != "app_mention" or not event_id:
        return JSONResponse({"ok": True})

    channel = str(event.get("channel", ""))
    if settings.slack_channel_id and channel != settings.slack_channel_id:
        return JSONResponse({"ok": True})

    user_id = str(event.get("user", ""))
    if not user_id or event.get("bot_id"):
        return JSONResponse({"ok": True})

    if settings.authorized_user_id_set and user_id not in settings.authorized_user_id_set:
        return JSONResponse({"ok": True})

    if await _mark_event_seen(event_id):
        return JSONResponse({"ok": True})

    thread_ts = str(event.get("thread_ts") or event.get("ts") or "")
    task_text, eng_enabled, model_preference = _parse_engineer_directives(str(event.get("text", "")))
    task_text = _append_attachments(task_text, _attachments_from_event(event))
    if not thread_ts or not task_text:
        return JSONResponse({"ok": True})

    bot_token = settings.slack_bot_token
    if not bot_token:
        raise HTTPException(status_code=500, detail="Slack bot token is not configured")

    thread_key = f"{channel}:{thread_ts}"

    if _route_reply_to_session(thread_key, task_text) == "accepted":
        return JSONResponse({"ok": True})

    if not eng_enabled:
        return JSONResponse({"ok": True})

    async def _start_from_event() -> None:
        try:
            await _start_engineer_session(
                settings=settings,
                bot_token=bot_token,
                channel=channel,
                thread_ts=thread_ts,
                thread_key=thread_key,
                task_text=task_text,
                model_preference=model_preference,
            )
        except Exception:
            log.exception("engineer_start_from_event_failed", thread_key=thread_key)

    start_task = asyncio.create_task(_start_from_event())
    start_task.add_done_callback(lambda task: task.exception())
    return JSONResponse({"ok": True})
