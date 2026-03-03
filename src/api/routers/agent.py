"""Agent sandbox REST API — spawn, execute, stop, status."""

from __future__ import annotations

import asyncio
import json
import queue
import threading
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.agent import get_agent
from api.deps import verify_api_key

router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[Depends(verify_api_key)],
)


class SpawnRequest(BaseModel):
    slack_thread_key: str
    harness: str | None = None
    repo: str | None = None
    engine: str | None = None
    request_id: str | None = None


class FileAttachment(BaseModel):
    url: str
    name: str


class ExecuteRequest(BaseModel):
    slack_thread_key: str
    message: str
    harness: str | None = None
    source: str | None = None
    repo: str | None = None
    request_id: str | None = None
    user_id: str | None = None
    model: str | None = None
    engine: str | None = None
    files: list[FileAttachment] = []


class StopRequest(BaseModel):
    slack_thread_key: str


class InterruptRequest(BaseModel):
    slack_thread_key: str


@router.post("/spawn")
async def spawn(req: SpawnRequest) -> dict[str, Any]:
    """Spawn a sandbox container for a Slack thread."""
    agent = get_agent()
    return agent.spawn(req.slack_thread_key, req.harness, req.repo, req.request_id, req.engine)


@router.post("/execute")
async def execute(req: ExecuteRequest) -> dict[str, Any]:
    """Execute a message in a sandbox. Auto-spawns if needed."""
    agent = get_agent()
    files = [{"url": f.url, "name": f.name} for f in req.files] if req.files else None
    return await asyncio.to_thread(
        agent.execute,
        req.slack_thread_key,
        req.message,
        req.harness,
        req.source,
        req.repo,
        req.request_id,
        files,
        None,
        req.user_id,
        req.model,
        req.engine,
    )


@router.post("/execute_stream")
async def execute_stream(req: ExecuteRequest) -> StreamingResponse:
    """Execute a message, streaming progress events via SSE."""
    agent = get_agent()
    q: queue.Queue[dict | None] = queue.Queue()

    def run() -> None:
        try:
            files = [{"url": f.url, "name": f.name} for f in req.files] if req.files else None
            agent.execute(
                req.slack_thread_key,
                req.message,
                req.harness,
                req.source,
                req.repo,
                req.request_id,
                files,
                emit=q.put,
                user_id=req.user_id,
                model=req.model,
                engine=req.engine,
            )
        except Exception as e:
            q.put({"type": "error", "message": str(e)})
        finally:
            q.put(None)

    threading.Thread(target=run, daemon=True).start()

    async def event_generator():
        while True:
            try:
                item = await asyncio.wait_for(
                    asyncio.to_thread(q.get, timeout=30), timeout=35
                )
            except (TimeoutError, Exception):
                yield ": keep-alive\n\n"
                continue

            if item is None:
                break

            yield f"data: {json.dumps(item, default=str)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/stop")
async def stop(req: StopRequest) -> dict[str, Any]:
    """Stop and remove a sandbox container."""
    agent = get_agent()
    return agent.stop(req.slack_thread_key)


@router.post("/interrupt")
async def interrupt(req: InterruptRequest) -> dict[str, Any]:
    """Interrupt a running command."""
    agent = get_agent()
    return agent.interrupt(req.slack_thread_key)


@router.get("/status")
async def status(key: str | None = None) -> dict[str, Any]:
    """Get session status. If no key given, list all."""
    agent = get_agent()
    return agent.status(key)


@router.get("/pool")
async def pool() -> dict[str, Any]:
    """Show pool status."""
    agent = get_agent()
    return agent.pool()
