"""Readiness endpoint tests."""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_readyz_reports_schema_compatibility() -> None:
    from api.routers.health import readyz

    fake_app = SimpleNamespace(state=SimpleNamespace(db_pool=object()))

    with (
        patch.dict(sys.modules, {"api.app": SimpleNamespace(app=fake_app)}),
        patch(
            "api.routers.health.check_schema_compatibility",
            new=AsyncMock(
                return_value={
                    "compatible": True,
                    "required_states_missing": [],
                    "required_columns_missing": [],
                    "required_migrations_missing": [],
                    "constraint_present": True,
                    "errors": [],
                }
            ),
        ),
    ):
        resp = await readyz()

    assert resp.status_code == 200
    payload = json.loads(resp.body.decode("utf-8"))
    assert payload["status"] == "ok"
    assert payload["schema_compatibility"]["compatible"] is True
    assert "runtime_credentials" not in payload


@pytest.mark.asyncio
async def test_readyz_returns_503_when_schema_incompatible() -> None:
    from api.routers.health import readyz

    fake_app = SimpleNamespace(state=SimpleNamespace(db_pool=object()))

    incompatible = {
        "compatible": False,
        "required_states_missing": ["suspended"],
        "required_columns_missing": [],
        "required_migrations_missing": [],
        "constraint_present": True,
        "errors": [],
    }

    with (
        patch.dict(sys.modules, {"api.app": SimpleNamespace(app=fake_app)}),
        patch(
            "api.routers.health.check_schema_compatibility",
            new=AsyncMock(return_value=incompatible),
        ),
    ):
        resp = await readyz()

    assert resp.status_code == 503
    payload = json.loads(resp.body.decode("utf-8"))
    assert payload["status"] == "not_ready"
    assert payload["schema_compatibility"]["compatible"] is False
