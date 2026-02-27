from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import secrets as _secrets
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response, StreamingResponse

from api.mcp_server import mcp, set_plugin_manager, set_pool
from api.routers import admin, agent as agent_router_mod
from api.routers import health, query, search, secrets, threads, ui
from shared.config import settings
from shared.db import close_pool, create_pool
from shared.plugin_manager import PluginManager

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


def _warm_plugin_caches() -> None:
    """Pre-warm slow plugin caches in background thread."""
    import threading

    def _warm() -> None:
        try:
            slack_plugin = plugin_manager.plugins.get("slack")
            if not slack_plugin or not slack_plugin.tools:
                return
            # Get the client instance from any bound tool method
            client = slack_plugin.tools[0].fn.__self__
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


async def _watch_plugins(pm: PluginManager) -> None:
    """Watch the plugins directory and auto-reload when files change."""
    from starlette.concurrency import run_in_threadpool
    from watchfiles import awatch

    log.info("plugin_watcher_started", path=str(pm.plugins_dir))
    async for changes in awatch(pm.plugins_dir):
        changed_files = [str(p) for _, p in changes]
        log.info("plugin_files_changed", files=changed_files)
        try:
            result = await run_in_threadpool(pm.reload)
            log.info("plugins_auto_reloaded", **result)
        except Exception as e:
            log.error("plugin_auto_reload_failed", error=str(e))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    log.info("connecting to database", url=settings.database_url.split("@")[-1])
    pool = await create_pool(settings.database_url)
    app.state.pool = pool
    set_pool(pool)
    log.info("database pool created")
    async with mcp.session_manager.run():
        log.info("mcp session manager started")
        _warm_plugin_caches()
        _recover_agent_sessions()
        watcher_task = asyncio.create_task(_watch_plugins(plugin_manager))
        try:
            yield
        finally:
            watcher_task.cancel()
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
    allow_credentials=True,
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
app.include_router(ui.router)

# Load plugins before creating MCP starlette app
_app_root = Path(__file__).resolve().parent.parent.parent
_plugins_dir = Path(os.environ.get("PLUGINS_DIR", _app_root / "plugins"))

plugin_manager = PluginManager(_plugins_dir)
plugin_manager.discover()
set_plugin_manager(plugin_manager)
app.state.plugin_manager = plugin_manager
app.include_router(plugin_manager.create_rest_router())

_mcp_starlette = mcp.streamable_http_app()


_DOCKER_PREFIXES = ("172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.")


class _MCPAuthMiddleware:
    """ASGI middleware that validates Bearer token before forwarding to MCP.

    Requests from Docker bridge networks (172.17-22.*) skip auth.
    """

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            request = Request(scope, receive)
            client_ip = request.client.host if request.client else ""
            is_docker = client_ip.startswith(_DOCKER_PREFIXES)

            if not is_docker:
                token: str | None = None
                auth = request.headers.get("authorization", "")
                if auth.lower().startswith("bearer "):
                    token = auth[7:]

                if not settings.api_secret_key or not _secrets.compare_digest(
                    token, settings.api_secret_key
                ):
                    resp = JSONResponse(
                        {"detail": "Invalid or missing Bearer token"}, status_code=401
                    )
                    await resp(scope, receive, send)
                    return

        await _mcp_starlette(scope, receive, send)


app.mount("/mcp", app=_MCPAuthMiddleware())


# ---------------------------------------------------------------------------
# Reverse proxy: /api/webhooks/* → slackbot on port 3001
# ---------------------------------------------------------------------------
_SLACKBOT_URL = os.environ.get("SLACKBOT_URL", "http://localhost:3001")
_SLACK_SIGNING_SECRET = os.environ.get("SLACK_SIGNING_SECRET", "")
_SLACK_TIMESTAMP_MAX_AGE = 5 * 60  # 5 minutes


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    """Verify a Slack request signature (v0 scheme).

    See https://api.slack.com/authentication/verifying-requests-from-slack
    """
    if not _SLACK_SIGNING_SECRET:
        log.warning("slack_signing_secret_not_set")
        return False
    try:
        if abs(time.time() - int(timestamp)) > _SLACK_TIMESTAMP_MAX_AGE:
            return False
    except (ValueError, TypeError):
        return False
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        _SLACK_SIGNING_SECRET.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@app.api_route("/api/webhooks/{path:path}", methods=["GET", "POST"])
async def proxy_webhooks(request: Request, path: str):
    """Forward Slack webhook requests to the slackbot service."""
    body = await request.body()

    slack_signature = request.headers.get("x-slack-signature", "")
    slack_timestamp = request.headers.get("x-slack-request-timestamp", "")
    if not _verify_slack_signature(body, slack_timestamp, slack_signature):
        return JSONResponse({"detail": "Invalid Slack signature"}, status_code=401)

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


# ---------------------------------------------------------------------------
# Catch-all: proxy everything else to the slackbot Next.js UI
# ---------------------------------------------------------------------------
# Must be registered LAST so it doesn't swallow API/MCP routes.

@app.get("/")
async def root_redirect(request: Request):
    """Redirect / to /threads."""
    from api.routers.ui import _check_auth

    if not _check_auth(request):
        return RedirectResponse("/login", status_code=302)
    return RedirectResponse("/threads", status_code=302)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_ui_catchall(request: Request, path: str):
    """Reverse proxy to the slackbot Next.js app with password protection."""
    from api.routers.ui import _check_auth

    if not path.startswith("_next/") and not _check_auth(request):
        return RedirectResponse("/login", status_code=302)

    target = f"{_SLACKBOT_URL}/{path}"
    qs = str(request.query_params)
    if qs:
        target += f"?{qs}"

    body = await request.body()
    skip = {"host", "connection", "transfer-encoding", "content-length"}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in skip}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method=request.method,
            url=target,
            headers=headers,
            content=body if body else None,
        )

    skip_resp = {"transfer-encoding", "connection", "content-encoding", "content-length"}
    resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in skip_resp}

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
    )
