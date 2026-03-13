from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
import structlog
import structlog.contextvars
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.config import settings
from api.db import close_pool, create_pool
from api.logging_config import configure_structlog
from api.metrics import HTTP_REQUESTS_IN_PROGRESS, observe_http_request
from api.routers import admin, attachments as attachments_mod, deprecated, health, internal
from api.routers import agent as agent_router_mod
from api.tool_manager import ToolManager, load_plugins_config
from api.warm_pool import start_replenish_loop, stop_replenish_loop

configure_structlog()

log = structlog.get_logger().bind(service="api")

# Suppress noisy uvicorn access logs (nginx already logs requests)
for _uvi_name in ("uvicorn.access",):
    logging.getLogger(_uvi_name).propagate = False


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
            await _push_injection_map()
        except Exception as e:
            log.error("tool_auto_reload_failed", error=str(e))


async def _push_injection_map() -> None:
    """Push the tool injection map to the firewall on startup.

    The API depends on the firewall (service_healthy), so the firewall is
    guaranteed to be up.  This eliminates the race condition where the
    firewall polls the API for the map before the API is ready.
    """
    firewall_url = os.environ.get("FIREWALL_HEALTH_URL", "http://firewall:8081")
    injection_map = tool_manager.build_injection_map()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{firewall_url}/injection-map",
                json=injection_map,
                timeout=5,
            )
            resp.raise_for_status()
        log.info(
            "injection_map_pushed",
            hosts=len(injection_map),
            keys=sum(len(v) for v in injection_map.values()),
        )
    except Exception:
        log.warning("injection_map_push_failed", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.db_pool = await create_pool(settings.database_url)
    await _push_injection_map()
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


@app.middleware("http")
async def instrument_requests(request, call_next):
    if request.url.path == "/metrics":
        return await call_next(request)

    structlog.contextvars.clear_contextvars()

    trace_id = request.headers.get("x-trace-id")
    thread_key = None

    if trace_id:
        structlog.contextvars.bind_contextvars(trace_id=trace_id)
        thread_key = trace_id
        structlog.contextvars.bind_contextvars(thread_key=thread_key)

    if request.method == "POST" and request.url.path in ("/agent/execute", "/agent/reconnect"):
        try:
            body_bytes = await request.body()
            body_json = json.loads(body_bytes)
            body_tk = body_json.get("thread_key")
            if body_tk:
                thread_key = body_tk
                structlog.contextvars.bind_contextvars(thread_key=thread_key)
        except Exception:
            pass

    start = time.perf_counter()
    status_code = 500
    HTTP_REQUESTS_IN_PROGRESS.inc()
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        HTTP_REQUESTS_IN_PROGRESS.dec()
        route = request.scope.get("route")
        path = getattr(route, "path", None) or request.url.path
        duration_ms = (time.perf_counter() - start) * 1000
        observe_http_request(
            method=request.method,
            path=path,
            status=status_code,
            duration_s=duration_ms / 1000,
        )
        if not path.startswith(("/health", "/metrics")):
            log.info(
                "http_request",
                method=request.method,
                path=path,
                status=status_code,
                duration_ms=round(duration_ms, 2),
                trace_id=trace_id,
                thread_key=thread_key,
                client_ip=request.client.host if request.client else None,
            )
        structlog.contextvars.clear_contextvars()

app.include_router(health.router)
app.include_router(agent_router_mod.router)
app.include_router(attachments_mod.router)
app.include_router(admin.router)
app.include_router(internal.router)
app.include_router(deprecated.router)


# Load tools
# Resolution order: TOOL_DIRS env var (colon-separated) → tools.toml → PLUGINS_DIR fallback
_app_root = Path(__file__).resolve().parent.parent.parent

_tool_dirs_env = os.environ.get("TOOL_DIRS", "")
if _tool_dirs_env:
    _tools_dirs = [Path(d.strip()) for d in _tool_dirs_env.split(":") if d.strip()]
else:
    _plugins_config = _app_root / "tools.toml"
    _plugin_dirs = load_plugins_config(_plugins_config)
    _tools_dirs = (
        _plugin_dirs if _plugin_dirs else [Path(os.environ.get("PLUGINS_DIR", _app_root / "tools"))]
    )

tool_manager = ToolManager(_tools_dirs)
tool_manager.discover()
app.state.tool_manager = tool_manager
app.include_router(tool_manager.create_rest_router())


def get_tool_manager() -> ToolManager:
    return tool_manager
