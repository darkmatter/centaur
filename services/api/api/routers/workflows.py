"""Workflow routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from api.api_keys import check_scope
from api.deps import get_key_info, verify_api_key
from api.runtime_control import ControlPlaneError
from api.workflow_engine import (
    cancel_workflow_run,
    create_workflow_run,
    get_workflow_checkpoints,
    get_workflow_run,
    list_workflow_runs,
)

router = APIRouter(
    prefix="/workflows",
    tags=["workflows"],
    dependencies=[Depends(verify_api_key)],
)


def _key_authorized_for_workflow(request: Request, workflow_name: str) -> bool:
    """A caller may operate on a workflow if they have any of:

    - the legacy ``agent:execute`` scope (preserves existing behavior)
    - the wildcard ``workflows`` / ``workflows:*`` scope
    - an exact ``workflows:<workflow_name>`` scope
    - ``admin`` / ``*``
    """
    info = get_key_info(request)
    if check_scope(info, "agent:execute"):
        return True
    if check_scope(info, "admin"):
        return True
    if check_scope(info, "workflows", workflow_name):
        return True
    return False


def _require_workflow_access(request: Request, workflow_name: str) -> None:
    if not _key_authorized_for_workflow(request, workflow_name):
        raise HTTPException(
            status_code=403,
            detail=(
                "API key scope does not permit workflow "
                f"'{workflow_name}'. Required: agent:execute, workflows, "
                f"workflows:*, or workflows:{workflow_name}."
            ),
        )


async def _require_run_access(request: Request, run_id: str) -> dict[str, Any]:
    run = await get_workflow_run(request.app.state.db_pool, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="workflow run not found")
    workflow_name = str(run.get("workflow_name") or "")
    _require_workflow_access(request, workflow_name)
    return run


class WorkflowRunCreateRequest(BaseModel):
    workflow_name: str
    trigger_key: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    eager_start: bool = False


@router.post("/runs")
async def create_run(request: Request, body: WorkflowRunCreateRequest):
    _require_workflow_access(request, body.workflow_name)
    try:
        return await create_workflow_run(
            request.app.state.db_pool,
            workflow_name=body.workflow_name,
            run_input=body.input,
            trigger_key=body.trigger_key,
            eager_start=body.eager_start,
        )
    except ControlPlaneError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc


@router.get("/runs")
async def list_runs(
    request: Request,
    workflow_name: str | None = None,
    thread_key: str | None = None,
    status: str | None = None,
    parent_run_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
):
    info = get_key_info(request)
    has_broad_access = (
        check_scope(info, "agent:execute")
        or check_scope(info, "admin")
        or check_scope(info, "workflows", "")
    )
    if not has_broad_access:
        # Narrow keys MUST filter to a workflow they're authorized for.
        if not workflow_name:
            raise HTTPException(
                status_code=403,
                detail=(
                    "API key requires a workflow_name filter. Pass "
                    "?workflow_name=<name> matching your scope."
                ),
            )
        _require_workflow_access(request, workflow_name)
    return await list_workflow_runs(
        request.app.state.db_pool,
        workflow_name=workflow_name,
        thread_key=thread_key,
        status=status,
        parent_run_id=parent_run_id,
        limit=limit,
    )


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request):
    return await _require_run_access(request, run_id)


@router.get("/runs/{run_id}/children")
async def get_run_children(
    run_id: str,
    request: Request,
    limit: int = Query(default=200, ge=1, le=200),
):
    await _require_run_access(request, run_id)
    return await list_workflow_runs(
        request.app.state.db_pool,
        parent_run_id=run_id,
        limit=limit,
    )


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request):
    await _require_run_access(request, run_id)
    result = await cancel_workflow_run(request.app.state.db_pool, run_id)
    if result is None:
        raise HTTPException(status_code=404, detail="workflow run not found")
    return result


@router.get("/runs/{run_id}/checkpoints")
async def get_checkpoints(run_id: str, request: Request):
    await _require_run_access(request, run_id)
    checkpoints = await get_workflow_checkpoints(request.app.state.db_pool, run_id)
    if checkpoints is None:
        raise HTTPException(status_code=404, detail="workflow run not found")
    return checkpoints


class SendEventRequest(BaseModel):
    event_type: str
    correlation_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


@router.post("/events")
async def send_event(request: Request, body: SendEventRequest):
    info = get_key_info(request)
    # Events are still global: only broad-scope keys may dispatch them.
    if not (check_scope(info, "agent:execute") or check_scope(info, "admin")):
        raise HTTPException(
            status_code=403,
            detail="API key scope does not permit dispatching workflow events",
        )
    from api.workflow_engine import send_workflow_event

    return await send_workflow_event(
        request.app.state.db_pool,
        event_type=body.event_type,
        correlation_id=body.correlation_id,
        payload=body.payload,
    )
