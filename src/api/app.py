from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import secrets as _secrets
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
from starlette.responses import JSONResponse, Response, StreamingResponse

from api.agent import reap_stale_running_sessions, session_items_snapshot, signal_shutdown
from api.deps import _TRUSTED_PREFIXES
from api.mcp_server import mcp, set_pool, set_tool_manager
from api.routers import admin, health, query, search, secrets, threads
from api.routers import agent as agent_router_mod
from shared.config import settings
from shared.db import close_pool, create_pool
from shared.tool_manager import ToolManager

# ---------------------------------------------------------------------------
# Structlog configuration — JSON in prod (non-tty), console in dev
# ---------------------------------------------------------------------------
_LOG_LEVELS = {"critical": 50, "error": 40, "warning": 30, "info": 20, "debug": 10}
_log_level = _LOG_LEVELS.get(os.getenv("AI_V2_LOG_LEVEL", "warning").lower(), 30)

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(_log_level),
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.dev.ConsoleRenderer()
        if sys.stderr.isatty()
        else structlog.processors.JSONRenderer(),
    ],
)

log = structlog.get_logger()


def _warm_tool_caches() -> None:
    """Pre-warm slow tool caches in background thread."""
    import threading

    def _warm() -> None:
        try:
            slack_tool = tool_manager.tools.get("slack")
            if not slack_tool or not slack_tool.methods:
                return
            # Get the client instance from any bound tool method
            client = slack_tool.methods[0].fn.__self__
            client._get_user_cache()
            client.list_bot_channels()
            log.info("slack_cache_warmed")
        except Exception as e:
            log.warning("slack_cache_warm_failed", error=str(e))

    threading.Thread(target=_warm, daemon=True).start()


def _recover_agent_sessions() -> None:
    """Recover agent sessions from Postgres + Docker on startup."""
    import threading

    def _recover() -> None:
        try:
            from api.agent import get_agent

            agent = get_agent()
            result = agent.recover_sessions()
            log.info("agent_sessions_recovered", **result)
        except Exception as e:
            log.warning("agent_session_recovery_failed", error=str(e))

    threading.Thread(target=_recover, daemon=True).start()


async def _watch_tools(pm: ToolManager) -> None:
    """Watch the tools directory and auto-reload when files change."""
    from starlette.concurrency import run_in_threadpool
    from watchfiles import awatch

    log.info("tool_watcher_started", path=str(pm.tools_dir))
    async for changes in awatch(pm.tools_dir):
        changed_files = [str(p) for _, p in changes]
        log.info("tool_files_changed", files=changed_files)
        try:
            result = await run_in_threadpool(pm.reload)
            log.info("tools_auto_reloaded", **result)
        except Exception as e:
            log.error("tool_auto_reload_failed", error=str(e))


async def _run_stale_session_reaper(
    interval_s: float = 120.0,
    stale_after_s: int = 600,
) -> None:
    while True:
        await asyncio.sleep(interval_s)
        try:
            result = await asyncio.to_thread(reap_stale_running_sessions, stale_after_s)
            if result.get("reaped"):
                log.info("agent_session_reaper_reaped", **result)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("agent_session_reaper_failed", error=str(e))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    log.info("connecting to database", url=settings.database_url.split("@")[-1])
    pool = await create_pool(settings.database_url)
    app.state.pool = pool
    set_pool(pool)
    log.info("database pool created")
    async with mcp.session_manager.run():
        log.info("mcp session manager started")
        _warm_tool_caches()
        _recover_agent_sessions()
        watcher_task = asyncio.create_task(_watch_tools(tool_manager))
        reaper_task = asyncio.create_task(_run_stale_session_reaper())
        try:
            yield
        finally:
            watcher_task.cancel()
            reaper_task.cancel()
            with suppress(asyncio.CancelledError):
                await watcher_task
            with suppress(asyncio.CancelledError):
                await reaper_task
    signal_shutdown()
    for _ in range(20):
        active = [s for _, s in session_items_snapshot() if s.get("state") == "working"]
        if not active:
            break
        await asyncio.sleep(0.5)
    await close_pool(pool)
    log.info("database pool closed")


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
app.include_router(search.router)
app.include_router(query.router)
app.include_router(secrets.router)
app.include_router(threads.router)
app.include_router(agent_router_mod.router)
app.include_router(admin.router)

# Load tools before creating MCP starlette app
_app_root = Path(__file__).resolve().parent.parent.parent
_tools_dir = Path(os.environ.get("PLUGINS_DIR", _app_root / "tools"))

tool_manager = ToolManager(_tools_dir)
tool_manager.discover()
set_tool_manager(tool_manager)
app.state.tool_manager = tool_manager
app.include_router(tool_manager.create_rest_router())

_mcp_starlette = mcp.streamable_http_app()


class _MCPAuthMiddleware:
    """ASGI middleware that validates Bearer token before forwarding to MCP.

    Only localhost is trusted without a token.
    """

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope, receive)
            client_ip = request.client.host if request.client else ""
            if not client_ip.startswith(_TRUSTED_PREFIXES):
                token: str | None = None
                auth = request.headers.get("authorization", "")
                if auth.lower().startswith("bearer "):
                    token = auth[7:]

                api_key = _get_api_secret_key()
                if not api_key or not token or not _secrets.compare_digest(token, api_key):
                    resp = JSONResponse(
                        {"detail": "Invalid or missing Bearer token"}, status_code=401
                    )
                    await resp(scope, receive, send)
                    return

        await _mcp_starlette(scope, receive, send)


app.mount("/mcp", app=_MCPAuthMiddleware())


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


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    """Verify a Slack request signature (v0 scheme).

    See https://api.slack.com/authentication/verifying-requests-from-slack
    """
    signing_secret = _get_slack_signing_secret()
    if not signing_secret:
        log.warning("slack_signing_secret_not_set")
        return False
    try:
        if abs(time.time() - int(timestamp)) > _SLACK_TIMESTAMP_MAX_AGE:
            return False
    except (ValueError, TypeError):
        return False
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    expected = (
        "v0="
        + hmac.new(signing_secret.encode(), sig_basestring.encode(), hashlib.sha256).hexdigest()
    )
    return hmac.compare_digest(expected, signature)


@app.api_route("/api/webhooks/{path:path}", methods=["GET", "POST"])
async def proxy_webhooks(request: Request, path: str):
    """Forward Slack webhook requests to the slackbot service."""
    body = await request.body()

    slack_signature = request.headers.get("x-slack-signature", "")
    slack_timestamp = request.headers.get("x-slack-request-timestamp", "")
    if not _verify_slack_signature(body, slack_timestamp, slack_signature):
        return JSONResponse({"detail": "Invalid Slack signature"}, status_code=401)

    # Handle Slack URL verification challenge directly
    try:
        payload = json.loads(body)
        if payload.get("type") == "url_verification":
            return JSONResponse({"challenge": payload["challenge"]})
    except (json.JSONDecodeError, KeyError):
        pass

    target = f"{_SLACKBOT_URL}/api/webhooks/{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method=request.method,
            url=target,
            headers={k: v for k, v in request.headers.items() if k.lower() != "host"},
            content=body,
        )
    return StreamingResponse(
        content=iter([resp.content]),
        status_code=resp.status_code,
        headers=dict(resp.headers),
    )
