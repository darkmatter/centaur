from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from api.deps import verify_operator_api_key

log = structlog.get_logger()

router = APIRouter(prefix="/admin", dependencies=[Depends(verify_operator_api_key)])


@router.post("/reload-tools")
async def reload_tools(request: Request) -> dict:
    """Hot-reload all tools without restarting the API server."""
    tool_manager = request.app.state.tool_manager
    result = await run_in_threadpool(tool_manager.reload)
    log.info("tools_reloaded", **result)
    return result


# ---------------------------------------------------------------------------
# API key management
# ---------------------------------------------------------------------------


class CreateKeyRequest(BaseModel):
    name: str
    scopes: list[str] = ["tools:*"]
    created_by: str = ""


@router.post("/api-keys")
async def create_api_key(request: Request, body: CreateKeyRequest) -> dict:
    """Create a new API key. The plaintext key is returned ONCE."""
    from api.api_keys import create_key

    valid_scope_prefixes = (
        "*",
        "admin",
        "agent",
        "threads",
        "tools:",
        "workflows",
        "workflows:",
    )
    for scope in body.scopes:
        if not any(scope == p or scope.startswith(p) for p in valid_scope_prefixes):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid scope: {scope}. Must be one of: *, admin, agent, "
                    "threads, tools:<name>, workflows, workflows:<name>"
                ),
            )

    pool = request.app.state.db_pool
    plaintext, info = await create_key(pool, body.name, body.scopes, body.created_by)
    return {
        "key": plaintext,
        "id": info.id,
        "name": info.name,
        "key_prefix": info.key_prefix,
        "scopes": info.scopes,
        "message": "Save this key — it will not be shown again.",
    }


@router.get("/api-keys")
async def list_api_keys(request: Request) -> dict:
    """List all API keys (active and revoked). Never exposes key hashes."""
    from api.api_keys import list_keys

    pool = request.app.state.db_pool
    keys = await list_keys(pool)
    return {"keys": keys, "count": len(keys)}


@router.delete("/api-keys/{key_id}")
async def revoke_api_key(request: Request, key_id: str) -> dict:
    """Revoke an API key by ID."""
    from api.api_keys import revoke_key

    pool = request.app.state.db_pool
    revoked = await revoke_key(pool, key_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="Key not found or already revoked")
    return {"status": "revoked", "id": key_id}
