from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from api.pipe_agent import recover_sessions
from api.routers import admin, health
from api.routers import pipe_agent as pipe_router_mod
from api.warm_pool import start_replenish_loop, stop_replenish_loop
from shared.config import settings
from shared.db import close_pool, create_pool
from shared.tool_manager import ToolManager, load_plugins_config

# ---------------------------------------------------------------------------
# Structlog configuration — JSON in prod (non-tty), console in dev
# ---------------------------------------------------------------------------
_LOG_LEVELS = {"critical": 50, "error": 40, "warning": 30, "info": 20, "debug": 10}
_log_level = _LOG_LEVELS.get(
    (os.getenv("AI_V2_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "info").lower(), 20
)

structlog.configure(
    logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
    wrapper_class=structlog.make_filtering_bound_logger(_log_level),
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", key="timestamp"),
        structlog.dev.ConsoleRenderer()
        if sys.stderr.isatty()
        else structlog.processors.JSONRenderer(),
    ],
)

log = structlog.get_logger().bind(service="api")


def _warm_tool_caches() -> None:
    """Pre-warm slow tool caches in background thread."""
    import threading

    def _warm() -> None:
        try:
            slack_tool = tool_manager.tools.get("slack")
            if not slack_tool or not slack_tool.methods:
                return
            client = slack_tool.methods[0].fn.__self__
            client._get_user_cache()
            client.list_bot_channels()
            log.info("slack_cache_warmed")
        except Exception as e:
            log.warning("slack_cache_warm_failed", error=str(e))

    threading.Thread(target=_warm, daemon=True).start()


async def _watch_tools(pm: ToolManager) -> None:
    """Watch all plugin directories and auto-reload when files change."""
    from starlette.concurrency import run_in_threadpool
    from watchfiles import awatch

    watch_dirs = [d for d in pm.tools_dirs if d.exists()]
    log.info("tool_watcher_started", paths=[str(d) for d in watch_dirs])
    async for changes in awatch(*watch_dirs):
        changed_files = [str(p) for _, p in changes]
        log.info("tool_files_changed", files=changed_files)
        try:
            result = await run_in_threadpool(pm.reload)
            log.info("tools_auto_reloaded", **result)
        except Exception as e:
            log.error("tool_auto_reload_failed", error=str(e))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.db_pool = await create_pool(settings.database_url)
    _warm_tool_caches()
    result = await recover_sessions()
    log.info("pipe_sessions_recovered", **result)
    watcher_task = asyncio.create_task(_watch_tools(tool_manager))
    await start_replenish_loop()
    try:
        yield
    finally:
        await stop_replenish_loop()
        watcher_task.cancel()
        with suppress(asyncio.CancelledError):
            await watcher_task
        await close_pool(app.state.db_pool)


app = FastAPI(
    title="AI v2 API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(pipe_router_mod.router)
app.include_router(admin.router)


# Load tools
_app_root = Path(__file__).resolve().parent.parent.parent
_tools_dir = Path(os.environ.get("PLUGINS_DIR", _app_root / "tools"))

_plugins_config = _app_root / "tools.toml"
_plugin_dirs = load_plugins_config(_plugins_config)
_tools_dirs: list[Path] = _plugin_dirs if _plugin_dirs else [_tools_dir]

tool_manager = ToolManager(_tools_dirs, root_env_path=_app_root / ".env")
tool_manager.discover()
app.state.tool_manager = tool_manager
app.include_router(tool_manager.create_rest_router())


def get_tool_manager() -> ToolManager:
    return tool_manager


# ---------------------------------------------------------------------------
def _get_api_secret_key() -> str:
    from shared.tool_sdk import _sm_read

    return _sm_read("API_SECRET_KEY") or ""


# ---------------------------------------------------------------------------
# Reverse proxy: /api/webhooks/* → slackbot on port 3001
# ---------------------------------------------------------------------------
_SLACKBOT_URL = os.environ.get("SLACKBOT_URL", "http://localhost:3001")
_SLACK_TIMESTAMP_MAX_AGE = 5 * 60  # 5 minutes


def _get_slack_signing_secret() -> str:
    from shared.tool_sdk import _sm_read

    return _sm_read("SLACK_SIGNING_SECRET") or ""


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> tuple[bool, str]:
    signing_secret = _get_slack_signing_secret()
    if not signing_secret:
        log.warning("slack_signing_secret_not_set")
        return False, "signing_secret_missing"
    if not timestamp:
        return False, "timestamp_missing"
    if not signature:
        return False, "signature_missing"
    try:
        timestamp_int = int(timestamp)
    except (ValueError, TypeError):
        return False, "timestamp_invalid"
    if abs(time.time() - timestamp_int) > _SLACK_TIMESTAMP_MAX_AGE:
        return False, "timestamp_stale"
    try:
        body_text = body.decode("utf-8")
    except UnicodeDecodeError:
        return False, "body_decode_failed"
    sig_basestring = f"v0:{timestamp}:{body_text}"
    expected = (
        "v0="
        + hmac.new(signing_secret.encode(), sig_basestring.encode(), hashlib.sha256).hexdigest()
    )
    if not hmac.compare_digest(expected, signature):
        return False, "signature_mismatch"
    return True, "ok"


_HOP_BY_HOP_RESPONSE_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _filter_proxy_response_headers(headers: httpx.Headers) -> dict[str, str]:
    filtered: dict[str, str] = {}
    for key, value in headers.multi_items():
        lower = key.lower()
        if lower in _HOP_BY_HOP_RESPONSE_HEADERS or lower == "content-length":
            continue
        if lower in filtered:
            continue
        filtered[lower] = value
    return filtered


@app.api_route("/api/webhooks/{path:path}", methods=["GET", "POST"])
async def proxy_webhooks(request: Request, path: str):
    """Forward Slack webhook requests to the slackbot service."""
    body = await request.body()

    slack_signature = request.headers.get("x-slack-signature", "")
    slack_timestamp = request.headers.get("x-slack-request-timestamp", "")
    slack_request_id = request.headers.get("x-slack-request-id", "")
    slack_retry_num = request.headers.get("x-slack-retry-num", "")
    is_valid, reject_reason = _verify_slack_signature(body, slack_timestamp, slack_signature)
    if not is_valid:
        log.warning(
            "slack_webhook_rejected",
            path=path,
            reason=reject_reason,
            request_id=slack_request_id,
            retry_num=slack_retry_num,
            has_signature=bool(slack_signature),
            has_timestamp=bool(slack_timestamp),
        )
        return JSONResponse({"detail": "Invalid Slack signature"}, status_code=401)

    try:
        payload = json.loads(body)
        if payload.get("type") == "url_verification":
            return JSONResponse({"challenge": payload["challenge"]})
    except (json.JSONDecodeError, KeyError):
        pass

    target = f"{_SLACKBOT_URL}/api/webhooks/{path}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            resp = await client.request(
                method=request.method,
                url=target,
                headers={k: v for k, v in request.headers.items() if k.lower() != "host"},
                content=body,
            )
    except httpx.TimeoutException:
        log.warning("slack_webhook_upstream_timeout", path=path, target=target)
        return JSONResponse({"detail": "Webhook upstream timeout"}, status_code=504)
    except httpx.RequestError as exc:
        log.warning(
            "slack_webhook_upstream_unreachable", path=path, target=target, error=str(exc)
        )
        return JSONResponse({"detail": "Webhook upstream unavailable"}, status_code=502)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=_filter_proxy_response_headers(resp.headers),
        media_type=resp.headers.get("content-type"),
    )
