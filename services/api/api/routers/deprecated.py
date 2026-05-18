from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["deprecated"])


def _gone(endpoint: str, replacement: str) -> JSONResponse:
    return JSONResponse(
        status_code=410,
        content={
            "error": "deprecated_endpoint",
            "endpoint": endpoint,
            "replacement": replacement,
        },
    )


def _legacy_agent_wire_gone(endpoint: str) -> JSONResponse:
    return JSONResponse(
        status_code=410,
        content={
            "code": "LEGACY_ENDPOINT_REMOVED",
            "message": (
                f"{endpoint} was removed. Use POST /agent/spawn, POST /agent/message, "
                "POST /agent/execute, then GET /agent/threads/{thread_key}/events."
            ),
        },
    )


@router.post("/api/search")
async def deprecated_search():
    return _gone(
        "/api/search",
        "Use direct tool calls via /tools/<tool>/<method>, for example websearch.search or slack.search_messages.",
    )


@router.post("/api/search/sql")
async def deprecated_search_sql():
    return _gone(
        "/api/search/sql",
        "Use a tool-specific query method exposed by your deployment after checking /tools or /tools/<tool>.",
    )


@router.get("/mcp")
@router.post("/mcp")
@router.get("/mcp/")
@router.post("/mcp/")
async def deprecated_mcp():
    return _gone(
        "/mcp",
        "Sandbox agents should call REST tool endpoints via /tools/<tool>/<method>; MCP is not exposed on this service path.",
    )


@router.post("/agent/connect")
async def deprecated_agent_connect():
    return _legacy_agent_wire_gone("/agent/connect")


@router.post("/agent/reconnect")
async def deprecated_agent_reconnect():
    return _legacy_agent_wire_gone("/agent/reconnect")
