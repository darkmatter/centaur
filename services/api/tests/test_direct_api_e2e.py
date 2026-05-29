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


def _assert_chat_sdk_chunk(chunk: dict) -> None:
    chunk_type = chunk.get("type")
    if chunk_type == "markdown_text":
        assert isinstance(chunk.get("text"), str)
        assert set(chunk) == {"type", "text"}
        return
    if chunk_type == "plan_update":
        assert isinstance(chunk.get("title"), str)
        assert set(chunk) == {"type", "title"}
        return
    assert chunk_type == "task_update"
    assert isinstance(chunk.get("id"), str)
    assert isinstance(chunk.get("title"), str)
    assert chunk.get("status") in {"pending", "in_progress", "complete", "error"}
    assert set(chunk).issubset({"type", "id", "title", "status", "details", "output"})
    if "details" in chunk:
        assert isinstance(chunk["details"], str)
    if "output" in chunk:
        assert isinstance(chunk["output"], str)


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

    chat_stream = await client.get(
        f"/agent/executions/{execution_id}/chat-stream",
        headers=_auth(api_key),
        params={
            "after_event_id": 0,
            "poll_ms": 10,
        },
    )
    assert chat_stream.status_code == 200
    chat_events = _parse_sse_events(chat_stream.text)
    assert [event.get("event") for event in chat_events] == [
        "chat_stream_chunk",
    ]
    assert chat_events[0]["data"] == {
        "type": "markdown_text",
        "text": result_text,
    }
    for event in chat_events:
        _assert_chat_sdk_chunk(event["data"])

    latest_chat_event_id = max(
        int(event["id"]) for event in chat_events if "id" in event
    )
    chat_replay = await client.get(
        f"/agent/executions/{execution_id}/chat-stream",
        headers=_auth(api_key),
        params={
            "after_event_id": latest_chat_event_id,
            "poll_ms": 10,
        },
    )
    assert chat_replay.status_code == 200
    chat_replay_events = _parse_sse_events(chat_replay.text)
    assert chat_replay_events == []

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


@pytest.mark.asyncio
async def test_direct_agent_chat_stream_emits_only_chat_sdk_chunks_for_slack_flow(
    client,
    db_pool,
    api_key: str,
):
    from api.runtime_control import _process_execution

    thread_key = f"direct:chat-stream:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:12]}"
    result_text = "The API stream is ready."
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
            "parts": [{"type": "text", "text": "Run one command and summarize it."}],
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
                    "type": "turn.plan.updated",
                    "plan": [{"step": "Run one command", "status": "running"}],
                }
            )
        }
        yield {
            "data": json.dumps(
                {
                    "type": "reasoning",
                    "text": "Thinking through the command before answering.",
                }
            )
        }
        yield {
            "data": json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "tool-1",
                                "name": "Bash",
                                "input": {"command": "printf ready"},
                            }
                        ],
                    },
                }
            )
        }
        yield {
            "data": json.dumps(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "tool-1",
                                "content": "ready",
                            }
                        ],
                    },
                }
            )
        }
        yield {
            "data": json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": result_text}],
                    },
                }
            )
        }
        yield {"data": json.dumps({"type": "turn.done", "result": result_text})}

    row = await db_pool.fetchrow(
        "SELECT * FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    backend = SimpleNamespace(attach=AsyncMock(), close_streams=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(
                return_value={
                    "ok": True,
                    "injected": True,
                    "durable_turn_id": "turn-chat-stream",
                }
            ),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch("api.runtime_control._stream_stdout", fake_stream),
    ):
        await _process_execution(db_pool, dict(row))

    chat_stream = await client.get(
        f"/agent/executions/{execution_id}/chat-stream",
        headers=_auth(api_key),
        params={"after_event_id": 0, "poll_ms": 10},
    )

    assert chat_stream.status_code == 200
    chat_events = _parse_sse_events(chat_stream.text)
    assert [event["event"] for event in chat_events] == [
        "chat_stream_chunk",
        "chat_stream_chunk",
        "chat_stream_chunk",
        "chat_stream_chunk",
        "chat_stream_chunk",
        "chat_stream_chunk",
        "chat_stream_chunk",
    ]
    chunks = [event["data"] for event in chat_events]
    for chunk in chunks:
        _assert_chat_sdk_chunk(chunk)
    assert {chunk["type"] for chunk in chunks} == {
        "markdown_text",
        "task_update",
        "plan_update",
    }
    assert chunks == [
        {"type": "plan_update", "title": "Execution plan"},
        {
            "type": "task_update",
            "id": "plan:1",
            "title": "Run one command",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "reasoning",
            "title": "Thinking",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "tool-1",
            "title": "Command execution",
            "status": "in_progress",
            "details": "```sh\nprintf ready\n```",
        },
        {
            "type": "task_update",
            "id": "tool-1",
            "title": "Command execution",
            "status": "complete",
            "details": "```sh\nprintf ready\n```",
            "output": "ready",
        },
        {"type": "markdown_text", "text": result_text},
        {
            "type": "task_update",
            "id": "reasoning",
            "title": "Thinking",
            "status": "complete",
        },
    ]


@pytest.mark.asyncio
async def test_direct_agent_chat_stream_context_returns_chat_sdk_stream_options(
    client,
    db_pool,
    api_key: str,
):
    thread_key = f"direct:chat-stream-context:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:12]}"
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

    execute_response = await client.post(
        "/agent/execute",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": assignment_generation,
            "execute_id": f"exec-{uuid.uuid4().hex}",
            "harness": "amp",
            "delivery": {
                "platform": "slack",
                "channel": "C123",
                "thread_ts": "1780000000.123456",
                "recipient_user_id": "U123",
                "recipient_team_id": "T123",
                "stop_blocks": [
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": "Final Block Kit"},
                    }
                ],
            },
        },
    )
    assert execute_response.status_code == 202
    execution_id = execute_response.json()["execution_id"]

    response = await client.get(
        f"/agent/executions/{execution_id}/chat-stream/context",
        headers=_auth(api_key),
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "platform": "slack",
        "thread_id": "slack:C123:1780000000.123456",
        "runtime": body["runtime"],
        "stream_options": {
            "recipientUserId": "U123",
            "recipientTeamId": "T123",
            "taskDisplayMode": "plan",
            "stopBlocks": [
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": "Final Block Kit"},
                }
            ],
        },
    }
    assert body["runtime"] == {
        "harness": "amp",
        "engine": "amp",
        "persona_id": None,
        "persona": None,
        "model": None,
        "prompt_ref": "harness:amp",
        "effective_agents_md_sha256": body["runtime"]["effective_agents_md_sha256"],
        "overlay": body["runtime"]["overlay"],
    }
    assert isinstance(body["runtime"]["effective_agents_md_sha256"], str)
    assert body["runtime"]["overlay"].keys() == {
        "loaded",
        "mount_api",
        "mount_sandbox",
        "image",
    }
