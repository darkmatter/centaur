from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from api.sandbox.base import SandboxSession


def _auth(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def _parse_sse_events(body: str) -> list[dict]:
    events: list[dict] = []
    current: dict[str, str] = {}
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                parsed = dict(current)
                if "data" in parsed:
                    parsed["data"] = json.loads(parsed["data"])
                events.append(parsed)
                current = {}
            continue
        if line.startswith("id: "):
            current["id"] = line[4:]
        elif line.startswith("event: "):
            current["event"] = line[7:]
        elif line.startswith("data: "):
            current["data"] = line[6:]
    if current:
        parsed = dict(current)
        if "data" in parsed:
            parsed["data"] = json.loads(parsed["data"])
        events.append(parsed)
    return events


@pytest.mark.asyncio
async def test_direct_agent_api_e2e_replays_terminal_output_without_duplicates(
    client,
    db_pool,
    api_key: str,
):
    from api.runtime_control import _process_execution

    thread_key = f"direct:e2e:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:12]}"
    result_text = "DIRECT-E2E-DONE"
    session = SandboxSession(
        sandbox_id=runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    with patch(
        "api.runtime_control.get_or_spawn",
        new=AsyncMock(return_value=session),
    ):
        spawn_response = await client.post(
            "/agent/spawn",
            headers=_auth(api_key),
            json={
                "thread_key": thread_key,
                "harness": "amp",
                "spawn_id": f"spawn-{uuid.uuid4().hex}",
            },
        )
    assert spawn_response.status_code == 200
    assignment_generation = spawn_response.json()["assignment_generation"]

    message_response = await client.post(
        "/agent/message",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": assignment_generation,
            "message_id": f"msg-{uuid.uuid4().hex}",
            "role": "user",
            "parts": [{"type": "text", "text": "Reply with the direct E2E marker."}],
        },
    )
    assert message_response.status_code == 200

    execute_response = await client.post(
        "/agent/execute",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": assignment_generation,
            "execute_id": f"exec-{uuid.uuid4().hex}",
            "harness": "amp",
            "delivery": {"platform": "dev"},
        },
    )
    assert execute_response.status_code == 202
    execution_id = execute_response.json()["execution_id"]

    async def fake_stream(*_args, **_kwargs):
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "result": result_text,
                }
            )
        }

    row = await db_pool.fetchrow(
        "SELECT * FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    backend = SimpleNamespace(attach=AsyncMock(), close_streams=AsyncMock())
    with (
        patch(
            "api.runtime_control.get_or_spawn",
            new=AsyncMock(return_value=session),
        ),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(
                return_value={
                    "ok": True,
                    "injected": True,
                    "durable_turn_id": "turn-direct-e2e",
                }
            ),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch("api.runtime_control._stream_stdout", fake_stream),
    ):
        await _process_execution(db_pool, dict(row))

    status_response = await client.get(
        f"/agent/executions/{execution_id}",
        headers=_auth(api_key),
    )
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "completed"
    assert status_response.json()["result_text"] == result_text

    first_stream = await client.get(
        f"/agent/threads/{thread_key}/events",
        headers=_auth(api_key),
        params={
            "execution_id": execution_id,
            "after_event_id": 0,
            "poll_ms": 10,
        },
    )
    assert first_stream.status_code == 200
    first_events = _parse_sse_events(first_stream.text)
    completed_events = [
        event
        for event in first_events
        if event.get("event") == "execution_state"
        and event.get("data", {}).get("status") == "completed"
    ]
    assert len(completed_events) == 1
    assert completed_events[0]["data"]["result_text"] == result_text

    after_event_id = max(int(event["id"]) for event in first_events if "id" in event)
    replay_stream = await client.get(
        f"/agent/threads/{thread_key}/events",
        headers=_auth(api_key),
        params={
            "execution_id": execution_id,
            "after_event_id": after_event_id,
            "poll_ms": 10,
        },
    )
    assert replay_stream.status_code == 200
    replay_events = _parse_sse_events(replay_stream.text)
    replay_completed = [
        event
        for event in replay_events
        if event.get("event") == "execution_state"
        and event.get("data", {}).get("status") == "completed"
    ]
    assert len(replay_completed) == 1
    assert int(replay_completed[0]["id"]) == after_event_id
    assert replay_completed[0]["data"]["result_text"] == result_text
