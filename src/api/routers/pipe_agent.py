"""Thin pipe agent router — execute/stop/status only.

Stateless dumb pipe: spawn containers, stream raw stdout, no Postgres.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.deps import verify_api_key
from api.pipe_agent import get_or_spawn, get_status, stop_session, stream_exec

router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[Depends(verify_api_key)],
)


class ExecuteRequest(BaseModel):
    thread_key: str
    message: str
    harness: str = "amp"


@router.post("/execute")
async def execute(req: ExecuteRequest):
    session = await get_or_spawn(req.thread_key, req.harness)

    async def event_stream():
        async for line in stream_exec(session, req.message):
            yield f"data: {line}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class StopRequest(BaseModel):
    thread_key: str


@router.post("/stop")
async def stop(req: StopRequest):
    ok = await stop_session(req.thread_key)
    return {"ok": ok}


@router.get("/status")
async def status(key: str):
    return await get_status(key)
