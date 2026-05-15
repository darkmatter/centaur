from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from api.db import check_schema_compatibility
from api.deps import verify_operator_api_key
from api.vm_metrics import render_metrics

router = APIRouter()


@router.get("/health")
@router.get("/healthz")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/health/ready")
@router.get("/readyz")
async def readyz() -> Response:
    from api.app import app, is_shutting_down

    if is_shutting_down():
        return JSONResponse(
            status_code=503,
            content={"status": "draining"},
        )

    report = await check_schema_compatibility(app.state.db_pool)
    payload = {
        "status": "ok",
        "schema_compatibility": report,
    }
    if report.get("compatible"):
        return JSONResponse(status_code=200, content=payload)
    payload["status"] = "not_ready"
    return JSONResponse(status_code=503, content=payload)


@router.get("/metrics")
async def metrics() -> Response:
    from api.app import app

    payload = await render_metrics(app.state.db_pool)
    return Response(content=payload, media_type="text/plain; charset=utf-8")


@router.get("/usage-stats")
async def usage_stats() -> Response:
    from api.app import app

    try:
        row = await app.state.db_pool.fetchrow(
            "SELECT data_json, generated_at FROM usage_stats WHERE id = 'current'"
        )
    except Exception:
        return JSONResponse(status_code=503, content={"detail": "Database unavailable"})
    if not row:
        return JSONResponse(status_code=404, content={"detail": "No stats generated yet"})
    import json as _json

    data = row["data_json"]
    if isinstance(data, str):
        data = _json.loads(data)
    if not isinstance(data, dict):
        return JSONResponse(status_code=500, content={"detail": "Malformed stats data"})
    data["generated_at"] = row["generated_at"].isoformat() if row["generated_at"] else None
    return JSONResponse(content=data, headers={"Cache-Control": "public, max-age=240"})


@router.get("/health/env", dependencies=[Depends(verify_operator_api_key)])
async def health_env() -> dict[str, list[str]]:
    """List the names of the API process's currently-set environment variables.

    Reflects runtime mutations (e.g. pg_dsn vars set by the API proxy
    bring-up), which the pod spec and ``kubectl exec`` cannot show. Values
    are not returned, only names.
    """
    return {"env": sorted(os.environ)}


@router.get("/health/tools", dependencies=[Depends(verify_operator_api_key)])
async def health_tools() -> dict[str, Any]:
    from api.app import get_tool_manager

    tool_manager = get_tool_manager()
    loaded = [
        {
            "name": tool.name,
            "methods": sorted(method.method_name for method in tool.methods),
        }
        for tool in tool_manager.tools.values()
    ]
    failed = list(tool_manager.load_failures)
    return {
        "loaded": loaded,
        "failed": failed,
        "summary": {
            "loaded_count": len(loaded),
            "failed_count": len(failed),
            "total_methods": sum(len(item["methods"]) for item in loaded),
        },
    }

