"""Agent router — execute/stop/status/reconnect."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.agent import get_or_spawn, get_status, stop_session, stream_exec, stream_reconnect
from api.deps import require_scope, verify_api_key
from api.warm_pool import pool_status
from api.warm_pool import replenish as replenish_pool

router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[Depends(verify_api_key)],
)


class ExecuteRequest(BaseModel):
    thread_key: str
    message: str
    harness: str = "amp"


@router.post("/execute", dependencies=[Depends(require_scope("agent:execute"))])
async def execute(req: ExecuteRequest):
    session = await get_or_spawn(req.thread_key, req.harness)

    async def event_stream():
        async for line in stream_exec(session, req.message):
            yield f"data: {line}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class ReconnectRequest(BaseModel):
    thread_key: str
    harness: str = "amp"


@router.post("/reconnect", dependencies=[Depends(require_scope("agent:execute"))])
async def reconnect(req: ReconnectRequest):
    """Re-attach to a running container's stdout without sending a new turn.

    Used by the slackbot to recover an in-progress stream after an API restart.
    Returns 404 if no running session exists for this thread.
    """
    session = await get_or_spawn(req.thread_key, req.harness)

    async def event_stream():
        async for line in stream_reconnect(session):
            yield f"data: {line}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class StopRequest(BaseModel):
    thread_key: str


@router.post("/stop", dependencies=[Depends(require_scope("agent:stop"))])
async def stop(req: StopRequest):
    ok = await stop_session(req.thread_key)
    return {"ok": ok}


@router.get("/status", dependencies=[Depends(require_scope("agent:status"))])
async def status(key: str):
    return await get_status(key)


@router.get("/pool", dependencies=[Depends(require_scope("admin"))])
async def pool():
    """Return warm pool diagnostics."""
    return pool_status()


@router.post("/pool/replenish", dependencies=[Depends(require_scope("admin"))])
async def pool_replenish():
    """Manually trigger pool replenishment."""
    spawned = await replenish_pool()
    return {"spawned": spawned, **pool_status()}
