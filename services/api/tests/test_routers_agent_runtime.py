from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest


def _install_fake_tool_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_app_module = types.ModuleType("api.app")
    fake_app_module.get_tool_manager = lambda: SimpleNamespace(
        personas={"eng": object(), "invest": object()},
        get_persona=lambda name: SimpleNamespace(
            name=name,
            description="Investment persona",
            engine="amp",
            default_repo="paradigmxyz/centaur",
            prompt_file="PROMPT.md",
            has_custom_executor=False,
        )
        if name == "invest"
        else None,
    )
    monkeypatch.setitem(sys.modules, "api.app", fake_app_module)


@pytest.mark.asyncio
async def test_runtime_reports_active_persona_and_overlay(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    from api.routers import agent

    async def fake_get_active_assignment(_pool, thread_key: str) -> dict:
        assert thread_key == "slack:C:test"
        return {
            "assignment_generation": 7,
            "runtime_id": "rt-test",
            "harness": "amp",
            "engine": "amp",
            "persona_id": "invest",
        }

    _install_fake_tool_manager(monkeypatch)
    monkeypatch.setattr(agent, "get_active_assignment", fake_get_active_assignment)
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", str(tmp_path))
    monkeypatch.setenv("CENTAUR_OVERLAY_IMAGE", "ghcr.io/paradigmxyz/centaur-paradigm:sha-test")

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db_pool=object())),
        state=SimpleNamespace(),
    )

    result = await agent.runtime(request, key="slack:C:test")

    assert result["assignment_generation"] == 7
    assert result["persona_id"] == "invest"
    assert result["persona"]["name"] == "invest"
    assert result["overlay"] == {
        "loaded": True,
        "mount_api": str(tmp_path),
        "mount_sandbox": "/home/agent/overlay/org",
        "image": "ghcr.io/paradigmxyz/centaur-paradigm:sha-test",
    }
    assert result["available_personas"] == ["eng", "invest"]


@pytest.mark.asyncio
async def test_runtime_overlay_loaded_false_when_mount_dir_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routers import agent

    async def fake_get_active_assignment(_pool, _thread_key: str) -> dict | None:
        return None

    _install_fake_tool_manager(monkeypatch)
    monkeypatch.setattr(agent, "get_active_assignment", fake_get_active_assignment)
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", "/nonexistent/overlay/path")
    monkeypatch.delenv("CENTAUR_OVERLAY_IMAGE", raising=False)

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db_pool=object())),
        state=SimpleNamespace(),
    )

    result = await agent.runtime(request, key="slack:C:test")

    assert result["assignment_generation"] is None
    assert result["persona"] is None
    # `loaded` must mirror what assemble_prompt actually saw on disk; a stale
    # CENTAUR_OVERLAY_DIR pointing at a missing path should report `false` and
    # null out `mount_api` so the runtime answer can't lie to the agent.
    assert result["overlay"]["loaded"] is False
    assert result["overlay"]["mount_api"] is None
    assert result["overlay"]["mount_sandbox"] is None
