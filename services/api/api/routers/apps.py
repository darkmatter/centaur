"""Apps router — deploy, manage, and proxy to long-lived web app containers."""

from __future__ import annotations

import base64
import hashlib
import json

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from api.apps import app_manager
from api.deps import verify_api_key

log = structlog.get_logger()

# ── Management router (requires API key) ─────────────────────────────────────

router = APIRouter(
    prefix="/apps",
    tags=["apps"],
    dependencies=[Depends(verify_api_key)],
)


class DeployRequest(BaseModel):
    name: str
    repo_url: str
    port: int = 3000
    basic_auth_user: str | None = None
    basic_auth_pass: str | None = None
    env: dict[str, str] | None = None
    build_cmd: str | None = None
    start_cmd: str | None = None
    created_by: str | None = None


def _hash_password(password: str) -> str:
    """Hash a password with SHA-256 for basic auth storage."""
    return hashlib.sha256(password.encode()).hexdigest()


def _verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its SHA-256 hash."""
    return hashlib.sha256(password.encode()).hexdigest() == hashed


@router.post("")
async def deploy_app(request: Request, body: DeployRequest):
    """Deploy a new app from a GitHub repo."""
    pool = request.app.state.db_pool

    existing = await pool.fetchrow("SELECT id FROM apps WHERE name = $1", body.name)
    if existing:
        raise HTTPException(status_code=409, detail=f"App '{body.name}' already exists")

    pass_hash = _hash_password(body.basic_auth_pass) if body.basic_auth_pass else None

    try:
        result = await app_manager.deploy(
            pool,
            name=body.name,
            repo_url=body.repo_url,
            port=body.port,
            basic_auth_user=body.basic_auth_user,
            basic_auth_pass_hash=pass_hash,
            env_json=body.env,
            build_cmd=body.build_cmd,
            start_cmd=body.start_cmd,
            created_by=body.created_by,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return JSONResponse(status_code=201, content=result)


@router.get("")
async def list_apps(request: Request):
    """List all deployed apps."""
    pool = request.app.state.db_pool
    rows = await pool.fetch(
        "SELECT id, name, repo_url, status, port, created_by, created_at, updated_at "
        "FROM apps ORDER BY created_at DESC"
    )
    return {
        "apps": [
            {
                "id": r["id"],
                "name": r["name"],
                "repo_url": r["repo_url"],
                "status": r["status"],
                "port": r["port"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ]
    }


@router.get("/{name}")
async def get_app(request: Request, name: str):
    """Get app details."""
    pool = request.app.state.db_pool
    row = await pool.fetchrow(
        "SELECT id, name, repo_url, container_id, status, port, "
        "basic_auth_user, env_json, build_cmd, start_cmd, created_by, "
        "build_log, error_text, created_at, updated_at FROM apps WHERE name = $1",
        name,
    )
    if not row:
        raise HTTPException(status_code=404, detail=f"App '{name}' not found")

    env_json = row["env_json"]
    if isinstance(env_json, str):
        env_json = json.loads(env_json)

    return {
        "id": row["id"],
        "name": row["name"],
        "repo_url": row["repo_url"],
        "container_id": row["container_id"][:12] if row["container_id"] else None,
        "status": row["status"],
        "port": row["port"],
        "has_basic_auth": bool(row["basic_auth_user"]),
        "env": env_json,
        "build_cmd": row["build_cmd"],
        "start_cmd": row["start_cmd"],
        "created_by": row["created_by"],
        "build_log": row["build_log"],
        "error_text": row["error_text"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@router.delete("/{name}")
async def delete_app(request: Request, name: str):
    """Stop and remove an app."""
    pool = request.app.state.db_pool
    try:
        await app_manager.stop_app(pool, name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"ok": True, "name": name}


@router.post("/{name}/restart")
async def restart_app(request: Request, name: str):
    """Restart an app (full rebuild)."""
    pool = request.app.state.db_pool
    try:
        result = await app_manager.restart_app(pool, name)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return result


@router.get("/{name}/logs")
async def get_app_logs(request: Request, name: str, tail: int = 200):
    """Get app build and runtime logs."""
    pool = request.app.state.db_pool
    try:
        logs = await app_manager.get_logs(pool, name, tail=tail)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"name": name, "logs": logs}


# ── Reverse proxy (NO API key — uses basic auth only) ────────────────────────
#
# This is a separate router so browser/public traffic can reach apps via
# subdomain ({name}.svc-ai.dayno.xyz) without an API key.  Nginx rewrites
# the subdomain to /app-proxy/{name}/{path}, which hits this router.
# Basic auth is checked per-app if configured.

proxy_router = APIRouter(tags=["app-proxy"])


def _check_basic_auth(request: Request, auth_user: str, auth_pass_hash: str) -> bool:
    """Verify Basic auth credentials from the request."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header[6:]).decode()
        username, password = decoded.split(":", 1)
    except Exception:
        return False
    return username == auth_user and _verify_password(password, auth_pass_hash)


async def _do_proxy(request: Request, name: str, path: str):
    """Shared proxy logic used by both path-based and subdomain routes."""
    pool = request.app.state.db_pool
    row = await pool.fetchrow(
        "SELECT container_id, status, port, basic_auth_user, basic_auth_pass_hash "
        "FROM apps WHERE name = $1",
        name,
    )
    if not row:
        raise HTTPException(status_code=404, detail=f"App '{name}' not found")

    if row["status"] != "running":
        raise HTTPException(
            status_code=503,
            detail=f"App '{name}' is not running (status: {row['status']})",
        )

    # Check basic auth if configured
    if row["basic_auth_user"] and row["basic_auth_pass_hash"]:
        if not _check_basic_auth(
            request, row["basic_auth_user"], row["basic_auth_pass_hash"]
        ):
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"},
                headers={"WWW-Authenticate": 'Basic realm="Centaur App"'},
            )

    container_ip = await app_manager.get_container_ip(row["container_id"])
    if not container_ip:
        raise HTTPException(status_code=503, detail="Cannot resolve app container IP")

    target_url = f"http://{container_ip}:{row['port']}/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    # Forward headers (excluding hop-by-hop)
    forward_headers: dict[str, str] = {}
    skip = {"host", "authorization", "connection", "transfer-encoding"}
    for k, v in request.headers.items():
        if k.lower() not in skip:
            forward_headers[k] = v
    forward_headers["x-forwarded-for"] = request.client.host if request.client else ""
    forward_headers["x-forwarded-proto"] = request.headers.get(
        "x-forwarded-proto", "https"
    )

    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=forward_headers,
                content=body if body else None,
            )
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="App is not responding")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Filter hop-by-hop response headers
    resp_headers: dict[str, str] = {}
    skip_resp = {
        "transfer-encoding",
        "connection",
        "content-encoding",
        "content-length",
    }
    for k, v in resp.headers.items():
        if k.lower() not in skip_resp:
            resp_headers[k] = v

    return StreamingResponse(
        content=iter([resp.content]),
        status_code=resp.status_code,
        headers=resp_headers,
    )


@proxy_router.api_route(
    "/app-proxy/{name}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_to_app(request: Request, name: str, path: str):
    """Reverse proxy requests to app containers.

    Nginx rewrites subdomain requests ({name}.svc-ai.dayno.xyz/foo)
    to /app-proxy/{name}/foo so this handler can resolve the app.
    """
    return await _do_proxy(request, name, path)
