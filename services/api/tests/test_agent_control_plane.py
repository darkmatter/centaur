from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from api.sandbox.base import SandboxSession


def _auth(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


async def _insert_assignment(db_pool, thread_key: str, generation: int = 1) -> None:
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, $2, $3, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        generation,
        f"rt-{thread_key}-{generation}",
    )


@pytest.mark.asyncio
async def test_db_insert_session_initial_state_tracks_inflight_turn(db_pool):
    from api.agent import _db_insert_session

    idle_thread_key = f"slack:C-test:{uuid.uuid4().hex}:idle"
    idle_session = SandboxSession(
        sandbox_id=f"rt-{uuid.uuid4().hex[:8]}",
        thread_key=idle_thread_key,
        harness="amp",
        engine="amp",
    )

    inserted = await _db_insert_session(idle_session, harness="amp", engine="amp")

    assert inserted is True
    idle_row = await db_pool.fetchrow(
        "SELECT state, inflight_turn_id FROM sandbox_sessions WHERE thread_key = $1",
        idle_thread_key,
    )
    assert idle_row is not None
    assert idle_row["state"] == "idle"
    assert idle_row["inflight_turn_id"] is None

    running_thread_key = f"slack:C-test:{uuid.uuid4().hex}:running"
    running_session = SandboxSession(
        sandbox_id=f"rt-{uuid.uuid4().hex[:8]}",
        thread_key=running_thread_key,
        harness="amp",
        engine="amp",
    )

    inserted = await _db_insert_session(
        running_session,
        harness="amp",
        engine="amp",
        inflight_turn_id="turn-live",
        inflight_turn_input={
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "hello"}],
            }
        },
        inflight_attempts=1,
    )

    assert inserted is True
    running_row = await db_pool.fetchrow(
        "SELECT state, inflight_turn_id, inflight_attempts FROM sandbox_sessions WHERE thread_key = $1",
        running_thread_key,
    )
    assert running_row is not None
    assert running_row["state"] == "running"
    assert running_row["inflight_turn_id"] == "turn-live"
    assert running_row["inflight_attempts"] == 1


@pytest.mark.asyncio
async def test_reconcile_tick_reaps_only_stale_running_sessions_without_activity(db_pool):
    from api.agent import reconcile_tick

    stale_thread_key = f"slack:C-test:{uuid.uuid4().hex}:stale"
    active_thread_key = f"slack:C-test:{uuid.uuid4().hex}:active"
    stale_runtime_id = f"rt-{uuid.uuid4().hex[:8]}"
    active_runtime_id = f"rt-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO sandbox_sessions ("
        "thread_key, sandbox_id, harness, engine, state, started_at, updated_at"
        ") VALUES ($1, $2, 'amp', 'amp', 'running', NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')",
        stale_thread_key,
        stale_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO sandbox_sessions ("
        "thread_key, sandbox_id, harness, engine, state, started_at, updated_at"
        ") VALUES ($1, $2, 'amp', 'amp', 'running', NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')",
        active_thread_key,
        active_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, delivery, metadata"
        ") VALUES ($1, $2, 1, 'exec-live', 'hash-live', 'queued', '{}'::jsonb, '{}'::jsonb)",
        f"exe-{uuid.uuid4().hex[:12]}",
        active_thread_key,
    )

    backend = SimpleNamespace(
        status_by_id=AsyncMock(return_value="running"),
        stop=AsyncMock(),
        list_containers=AsyncMock(return_value=[]),
    )
    with (
        patch("api.agent.get_backend", return_value=backend),
        patch("api.agent._drop_runtime") as drop_runtime,
    ):
        await reconcile_tick()

    stale_row = await db_pool.fetchrow(
        "SELECT state FROM sandbox_sessions WHERE thread_key = $1",
        stale_thread_key,
    )
    active_row = await db_pool.fetchrow(
        "SELECT state FROM sandbox_sessions WHERE thread_key = $1",
        active_thread_key,
    )
    assert stale_row is not None
    assert stale_row["state"] == "suspended"
    assert active_row is not None
    assert active_row["state"] == "running"

    stopped_threads = {
        call.args[0].thread_key for call in backend.stop.await_args_list
    }
    assert stopped_threads == {stale_thread_key}
    drop_runtime.assert_called_once_with(stale_runtime_id)


@pytest.mark.asyncio
async def test_message_requires_active_assignment(client, api_key: str):
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    res = await client.post(
        "/agent/message",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": 1,
            "message_id": "msg-1",
            "event": {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "hello"}],
                },
            },
        },
    )

    assert res.status_code == 409
    assert res.json()["code"] == "NO_ACTIVE_ASSIGNMENT"


@pytest.mark.asyncio
async def test_message_stores_attachment_refs(client, db_pool, api_key: str):
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await _insert_assignment(db_pool, thread_key, generation=3)

    payload = {
        "thread_key": thread_key,
        "assignment_generation": 3,
        "message_id": "msg-attachment",
        "event": {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what do you see?"},
                    {
                        "type": "image",
                        "source_path": "file:///tmp/example.jpg",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.b64encode(b"hello-image").decode("utf-8"),
                        },
                    },
                ],
            },
        },
    }

    res = await client.post("/agent/message", headers=_auth(api_key), json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data["attachment_ids"]) == 1

    row = await db_pool.fetchrow(
        "SELECT event_json FROM agent_message_requests WHERE thread_key = $1 AND message_id = $2",
        thread_key,
        "msg-attachment",
    )
    assert row is not None
    event_json = row["event_json"]
    if isinstance(event_json, str):
        event_json = json.loads(event_json)

    content = event_json["message"]["content"]
    assert content[1]["type"] == "attachment_ref"
    assert content[1]["attachment_id"] == data["attachment_ids"][0]


@pytest.mark.asyncio
async def test_execute_rejects_stale_generation(client, db_pool, api_key: str):
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await _insert_assignment(db_pool, thread_key, generation=5)

    res = await client.post(
        "/agent/execute",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": 4,
            "execute_id": "exec-stale",
            "delivery": {"platform": "slack"},
        },
    )

    assert res.status_code == 409
    assert res.json()["code"] == "ASSIGNMENT_GENERATION_STALE"


@pytest.mark.asyncio
async def test_execute_enqueues_and_creates_outbox(client, db_pool, api_key: str):
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await _insert_assignment(db_pool, thread_key, generation=1)

    res = await client.post(
        "/agent/execute",
        headers=_auth(api_key),
        json={
            "thread_key": thread_key,
            "assignment_generation": 1,
            "execute_id": "exec-1",
            "delivery": {"platform": "slack", "channel": "C-test"},
        },
    )

    assert res.status_code == 202
    body = res.json()
    execution_id = body["execution_id"]
    assert body["status"] == "queued"

    execution_row = await db_pool.fetchrow(
        "SELECT status FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution_row is not None
    assert execution_row["status"] == "queued"

    outbox_row = await db_pool.fetchrow(
        "SELECT state FROM agent_final_delivery_outbox WHERE execution_id = $1",
        execution_id,
    )
    assert outbox_row is not None
    assert outbox_row["state"] == "awaiting_terminal"


@pytest.mark.asyncio
async def test_final_delivery_claim_and_mark_delivered(client, db_pool, api_key: str):
    execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, final_payload, next_attempt_at"
        ") VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, NOW())",
        execution_id,
        thread_key,
        json.dumps({"platform": "slack", "channel": "C-test"}),
        json.dumps({"type": "final", "result_text": "done"}),
    )

    claim = await client.post(
        "/agent/final-deliveries/claim",
        headers=_auth(api_key),
        json={"consumer_id": "slackbot:test", "limit": 1, "lease_seconds": 30},
    )
    assert claim.status_code == 200
    deliveries = claim.json()["deliveries"]
    assert len(deliveries) == 1
    assert deliveries[0]["execution_id"] == execution_id
    assert deliveries[0]["attempt_count"] == 1

    delivered = await client.post(
        f"/agent/final-deliveries/{execution_id}/delivered",
        headers=_auth(api_key),
        json={"consumer_id": "slackbot:test"},
    )
    assert delivered.status_code == 200

    delivered_again = await client.post(
        f"/agent/final-deliveries/{execution_id}/delivered",
        headers=_auth(api_key),
        json={"consumer_id": "slackbot:test"},
    )
    assert delivered_again.status_code == 200
    assert delivered_again.json()["idempotent"] is True

    row = await db_pool.fetchrow(
        "SELECT state, lease_owner FROM agent_final_delivery_outbox WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    assert row["state"] == "delivered"
    assert row["lease_owner"] is None

    delivered_events = await db_pool.fetchval(
        "SELECT COUNT(*) FROM agent_execution_events "
        "WHERE execution_id = $1 AND event_kind = 'final_delivery_delivered'",
        execution_id,
    )
    assert int(delivered_events or 0) == 1


@pytest.mark.asyncio
async def test_mark_execution_terminal_delays_outbox_claimability(db_pool):
    from api.runtime_control import _mark_execution_terminal

    execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, lease_owner, lease_expires_at"
        ") VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal', 'stale-worker', NOW() + INTERVAL '5 minutes')",
        execution_id,
        thread_key,
    )

    started_at = dt.datetime.now(dt.timezone.utc)
    with patch("api.runtime_control.FINAL_DELIVERY_READY_GRACE_S", 2.0):
        await _mark_execution_terminal(
            db_pool,
            execution_id=execution_id,
            thread_key=thread_key,
            status="completed",
            terminal_reason="completed",
            result_text="done",
            error_text=None,
        )

    row = await db_pool.fetchrow(
        "SELECT state, next_attempt_at, lease_owner, lease_expires_at "
        "FROM agent_final_delivery_outbox WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    assert row["state"] == "pending"
    assert row["next_attempt_at"] >= started_at + dt.timedelta(seconds=1.5)
    assert row["lease_owner"] is None
    assert row["lease_expires_at"] is None


@pytest.mark.asyncio
async def test_final_delivery_claim_filters_platform(client, db_pool, api_key: str):
    slack_execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    web_execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"

    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, final_payload, next_attempt_at"
        ") VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, NOW())",
        slack_execution_id,
        thread_key,
        json.dumps({"platform": "slack", "channel": "C-test"}),
        json.dumps({"type": "final", "result_text": "done"}),
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, final_payload, next_attempt_at"
        ") VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, NOW())",
        web_execution_id,
        thread_key,
        json.dumps({"platform": "web"}),
        json.dumps({"type": "final", "result_text": "done"}),
    )

    claim = await client.post(
        "/agent/final-deliveries/claim",
        headers=_auth(api_key),
        json={
            "consumer_id": "slackbot:test",
            "limit": 10,
            "lease_seconds": 30,
            "platform": "slack",
        },
    )
    assert claim.status_code == 200
    deliveries = claim.json()["deliveries"]
    assert [delivery["execution_id"] for delivery in deliveries] == [slack_execution_id]


@pytest.mark.asyncio
async def test_final_delivery_non_retryable_failure_dead_letters_immediately(
    client,
    db_pool,
    api_key: str,
):
    execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, final_payload, lease_owner, lease_expires_at, "
        "next_attempt_at, attempt_count"
        ") VALUES ($1, $2, $3::jsonb, 'sending', $4::jsonb, 'slackbot:test', "
        "NOW() + INTERVAL '1 minute', NOW(), 1)",
        execution_id,
        thread_key,
        json.dumps({"platform": "slack", "channel": "C-missing"}),
        json.dumps({"type": "final", "result_text": "done"}),
    )

    failed = await client.post(
        f"/agent/final-deliveries/{execution_id}/failed",
        headers=_auth(api_key),
        json={
            "consumer_id": "slackbot:test",
            "error": "channel_not_found",
            "error_class": "invalid_destination",
            "non_retryable": True,
        },
    )
    assert failed.status_code == 200

    row = await db_pool.fetchrow(
        "SELECT state, last_error, next_attempt_at, lease_owner, lease_expires_at "
        "FROM agent_final_delivery_outbox WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    assert row["state"] == "dead_letter"
    assert row["last_error"] == "invalid_destination: channel_not_found"
    assert row["next_attempt_at"] is None
    assert row["lease_owner"] is None
    assert row["lease_expires_at"] is None


@pytest.mark.asyncio
async def test_final_delivery_non_retryable_failure_requires_lease(client, db_pool, api_key: str):
    execution_id = f"exe-{uuid.uuid4().hex[:10]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox ("
        "execution_id, thread_key, delivery, state, final_payload, next_attempt_at"
        ") VALUES ($1, $2, $3::jsonb, 'pending', $4::jsonb, NOW())",
        execution_id,
        thread_key,
        json.dumps({"platform": "slack", "channel": "C-missing"}),
        json.dumps({"type": "final", "result_text": "done"}),
    )

    failed = await client.post(
        f"/agent/final-deliveries/{execution_id}/failed",
        headers=_auth(api_key),
        json={
            "error": "channel_not_found",
            "error_class": "invalid_destination",
            "non_retryable": True,
        },
    )

    assert failed.status_code == 409
    row = await db_pool.fetchrow(
        "SELECT state, last_error FROM agent_final_delivery_outbox WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    assert row["state"] == "pending"
    assert row["last_error"] is None


@pytest.mark.asyncio
async def test_thread_events_emits_terminal_snapshot_when_cursor_is_caught_up(
    client,
    db_pool,
    api_key: str,
):
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"

    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, terminal_reason, result_text, completed_at"
        ") VALUES ($1, $2, 1, 'exec-terminal', 'hash-terminal', 'completed', '{}'::jsonb, '{}'::jsonb, "
        "'completed', 'done', NOW())",
        execution_id,
        thread_key,
    )
    latest_event_id = await db_pool.fetchval(
        "INSERT INTO agent_execution_events (thread_key, execution_id, event_kind, event_json) "
        "VALUES ($1, $2, 'execution_state', $3::jsonb) RETURNING event_id",
        thread_key,
        execution_id,
        json.dumps(
            {
                "type": "execution.state",
                "execution_id": execution_id,
                "thread_key": thread_key,
                "status": "completed",
                "terminal_reason": "completed",
                "result_text": "done",
            }
        ),
    )

    res = await client.get(
        f"/agent/threads/{thread_key}/events",
        headers=_auth(api_key),
        params={"execution_id": execution_id, "after_event_id": int(latest_event_id), "poll_ms": 10},
    )

    assert res.status_code == 200
    assert "event: execution_state" in res.text
    assert '"status":"completed"' in res.text
    assert '"result_text":"done"' in res.text


@pytest.mark.asyncio
async def test_spawn_without_explicit_prompt_reuses_active_assignment_and_refreshes_runtime(
    client,
    db_pool,
    api_key: str,
):
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"
    persona_sha = hashlib.sha256("persona:legal".encode("utf-8")).hexdigest()
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 3, $2, 'legal', 'amp', 'legal', 'persona:legal', $3, 'active')",
        thread_key,
        prior_runtime_id,
        persona_sha,
    )

    resumed = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="legal",
        engine="amp",
    )

    with patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=resumed)):
        res = await client.post(
            "/agent/spawn",
            headers=_auth(api_key),
            json={
                "thread_key": thread_key,
                "spawn_id": "spawn-adopt-active",
            },
        )

    assert res.status_code == 200
    body = res.json()
    assert body["assignment_generation"] == 3
    assert body["persona_id"] == "legal"
    assert body["runtime_id"] == resumed_runtime_id

    assignment = await db_pool.fetchrow(
        "SELECT runtime_id FROM agent_runtime_assignments "
        "WHERE thread_key = $1 AND assignment_generation = 3",
        thread_key,
    )
    assert assignment is not None
    assert assignment["runtime_id"] == resumed_runtime_id


@pytest.mark.asyncio
async def test_worker_marks_turn_done_error_as_failed_and_updates_runtime(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-idem', 'hash', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }

    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _fake_stream(*_args, **_kwargs):
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "result": "Timed out while reconnecting. Please retry after reconnecting.",
                    "is_error": True,
                    "error": "Timed out while reconnecting. Please retry after reconnecting.",
                }
            )
        }

    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _fake_stream),
    ):
        await _process_execution(db_pool, row)

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, error_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "failed_permanent"
    assert execution["terminal_reason"] == "amp_reconnect_timeout"
    assert "Timed out while reconnecting" in (execution["error_text"] or "")

    assignment = await db_pool.fetchrow(
        "SELECT runtime_id FROM agent_runtime_assignments WHERE thread_key = $1 AND assignment_generation = 1",
        thread_key,
    )
    assert assignment is not None
    assert assignment["runtime_id"] == resumed_runtime_id


@pytest.mark.asyncio
async def test_worker_records_projected_observations_and_execution_summary(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    runtime_id = f"rt-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', 'eng', 'persona:eng', 'sha-123', 'active')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-observe', 'hash-observe', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
        "created_at": dt.datetime.now(dt.timezone.utc),
        "claimed_at": dt.datetime.now(dt.timezone.utc),
    }

    session = SandboxSession(
        sandbox_id=runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _fake_stream(*_args, **_kwargs):
        yield {
            "data": json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_test",
                                "name": "web_search",
                                "input": {"objective": "Find recent research"},
                            }
                        ],
                        "usage": {"input_tokens": 10, "output_tokens": 20},
                        "model": "claude-sonnet",
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
                                "tool_use_id": "toolu_test",
                                "content": "[{\"url\":\"https://example.com\"}]",
                                "is_error": False,
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
                        "content": [{"type": "text", "text": "Here is the synthesis."}],
                        "usage": {"input_tokens": 5, "output_tokens": 15, "cost_usd": 0.123},
                        "model": "claude-sonnet",
                    },
                }
            )
        }
        yield {"data": json.dumps({"type": "turn.done", "result": "Here is the synthesis."})}

    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch("api.runtime_control._get_runtime", return_value=SimpleNamespace(turn_counter=1)),
        patch("api.runtime_control._stream_stdout", _fake_stream),
    ):
        await _process_execution(db_pool, row)

    event_kinds = [
        record["event_kind"]
        for record in await db_pool.fetch(
            "SELECT event_kind FROM agent_execution_events WHERE execution_id = $1 ORDER BY event_id",
            execution_id,
        )
    ]
    assert "execution_started" in event_kinds
    assert "assistant_tool_use_observed" in event_kinds
    assert "tool_result_observed" in event_kinds
    assert "assistant_text_observed" in event_kinds
    assert event_kinds.count("usage_observed") == 2
    assert "execution_summary" in event_kinds

    summary_row = await db_pool.fetchrow(
        "SELECT event_json FROM agent_execution_events WHERE execution_id = $1 AND event_kind = 'execution_summary'",
        execution_id,
    )
    assert summary_row is not None
    summary = summary_row["event_json"]
    if isinstance(summary, str):
        summary = json.loads(summary)
    assert summary["status"] == "completed"
    assert summary["prompt_ref"] == "persona:eng"
    assert summary["models"] == ["claude-sonnet"]
    assert summary["assistant_tool_use_events"] == 1
    assert summary["tool_result_events"] == 1
    assert summary["total_tokens"] == 50
    assert summary["cost_usd"] == 0.123
    assert summary["tool_calls_by_name"] == {"web_search": 1}


@pytest.mark.asyncio
async def test_claim_next_execution_runs_different_threads_concurrently_but_serializes_each_thread(
    db_pool,
):
    from api.runtime_control import _claim_next_execution

    thread_a = f"slack:C-test:{uuid.uuid4().hex}:a"
    thread_b = f"slack:C-test:{uuid.uuid4().hex}:b"
    execution_a1 = f"exe-{uuid.uuid4().hex[:12]}"
    execution_a2 = f"exe-{uuid.uuid4().hex[:12]}"
    execution_b1 = f"exe-{uuid.uuid4().hex[:12]}"

    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, created_at"
        ") VALUES ($1, $2, 1, 'exec-a1', 'hash-a1', 'queued', '{}'::jsonb, '{}'::jsonb, "
        "NOW() - INTERVAL '3 seconds')",
        execution_a1,
        thread_a,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, created_at"
        ") VALUES ($1, $2, 1, 'exec-a2', 'hash-a2', 'queued', '{}'::jsonb, '{}'::jsonb, "
        "NOW() - INTERVAL '2 seconds')",
        execution_a2,
        thread_a,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, created_at"
        ") VALUES ($1, $2, 1, 'exec-b1', 'hash-b1', 'queued', '{}'::jsonb, '{}'::jsonb, "
        "NOW() - INTERVAL '1 second')",
        execution_b1,
        thread_b,
    )

    first_claim = await _claim_next_execution(db_pool)
    second_claim = await _claim_next_execution(db_pool)

    assert first_claim is not None
    assert second_claim is not None
    assert first_claim["execution_id"] == execution_a1
    assert second_claim["execution_id"] == execution_b1

    rows = await db_pool.fetch(
        "SELECT execution_id, status FROM agent_execution_requests "
        "WHERE execution_id = ANY($1::text[])",
        [execution_a1, execution_a2, execution_b1],
    )
    statuses = {row["execution_id"]: row["status"] for row in rows}
    assert statuses == {
        execution_a1: "running",
        execution_a2: "queued",
        execution_b1: "running",
    }


@pytest.mark.asyncio
async def test_claim_next_execution_reclaims_expired_cancel_requested(db_pool):
    from api.runtime_control import _claim_next_execution, _recover_stale_running

    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"

    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, worker_lease_expires_at, created_at"
        ") VALUES ($1, $2, 1, 'exec-cancelled', 'hash-cancelled', 'cancel_requested', '{}'::jsonb, '{}'::jsonb, "
        "NOW() - INTERVAL '1 second', NOW() - INTERVAL '1 day')",
        execution_id,
        thread_key,
    )

    await _recover_stale_running(db_pool)
    claimed = await _claim_next_execution(db_pool)

    assert claimed is not None
    assert claimed["execution_id"] == execution_id
    assert claimed["status"] == "cancel_requested"


@pytest.mark.asyncio
async def test_cancel_execution_interrupts_runtime_and_clears_inflight(db_pool):
    from api.runtime_control import cancel_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    runtime_id = f"rt-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, delivery, metadata"
        ") VALUES ($1, $2, 1, 'exec-cancel', 'hash-cancel', 'running', '{}'::jsonb, '{}'::jsonb)",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO sandbox_sessions ("
        "thread_key, sandbox_id, harness, engine, state, started_at, inflight_turn_id, "
        "inflight_turn_input, inflight_started_at, inflight_attempts"
        ") VALUES ($1, $2, 'amp', 'amp', 'running', NOW(), 'turn-live', '{}'::jsonb, NOW(), 1)",
        thread_key,
        runtime_id,
    )

    backend = SimpleNamespace(interrupt_by_id=AsyncMock())
    with patch("api.runtime_control.get_backend", return_value=backend):
        result = await cancel_execution(db_pool, execution_id)

    assert result == {
        "ok": True,
        "execution_id": execution_id,
        "thread_key": thread_key,
        "status": "cancel_requested",
    }
    backend.interrupt_by_id.assert_awaited_once_with(runtime_id)

    execution = await db_pool.fetchrow(
        "SELECT status FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "cancel_requested"

    session = await db_pool.fetchrow(
        "SELECT state, inflight_turn_id, inflight_turn_input, inflight_attempts "
        "FROM sandbox_sessions WHERE thread_key = $1",
        thread_key,
    )
    assert session is not None
    assert session["state"] == "idle"
    assert session["inflight_turn_id"] is None
    assert session["inflight_turn_input"] is None
    assert session["inflight_attempts"] == 0


@pytest.mark.asyncio
async def test_recover_stale_running_requeues_expired_execution(db_pool):
    from api.runtime_control import _recover_stale_running

    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    thread_key = f"slack:C-test:{uuid.uuid4().hex}"

    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, last_progress_at, silence_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-stale', 'hash-stale', 'running', '{}'::jsonb, '{}'::jsonb, "
        "NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '1 minute')",
        execution_id,
        thread_key,
    )

    await _recover_stale_running(db_pool)

    row = await db_pool.fetchrow(
        "SELECT status FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert row is not None
    assert row["status"] == "queued"


@pytest.mark.asyncio
async def test_release_stale_runtime_assignments_releases_gone_idle_assignment(db_pool):
    from api.agent import _release_stale_runtime_assignments

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:8]}"
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state, updated_at"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active', "
        "NOW() - INTERVAL '2 days')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO sandbox_sessions (thread_key, sandbox_id, harness, engine, state, started_at, updated_at) "
        "VALUES ($1, $2, 'amp', 'amp', 'gone', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')",
        thread_key,
        runtime_id,
    )

    backend = SimpleNamespace(status_by_id=AsyncMock())
    released = await _release_stale_runtime_assignments(db_pool, backend)

    assert released == 1
    backend.status_by_id.assert_not_awaited()
    row = await db_pool.fetchrow(
        "SELECT state, released_at FROM agent_runtime_assignments WHERE thread_key = $1",
        thread_key,
    )
    assert row is not None
    assert row["state"] == "released"
    assert row["released_at"] is not None


@pytest.mark.asyncio
async def test_release_stale_runtime_assignments_preserves_live_execution(db_pool):
    from api.agent import _release_stale_runtime_assignments

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:8]}"
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state, updated_at"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active', "
        "NOW() - INTERVAL '2 days')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, delivery, metadata"
        ") VALUES ($1, $2, 1, 'exec-live', 'hash-live', 'running', '{}'::jsonb, '{}'::jsonb)",
        f"exe-{uuid.uuid4().hex[:12]}",
        thread_key,
    )

    backend = SimpleNamespace(status_by_id=AsyncMock(return_value="gone"))
    released = await _release_stale_runtime_assignments(db_pool, backend)

    assert released == 0
    backend.status_by_id.assert_not_awaited()
    state = await db_pool.fetchval(
        "SELECT state FROM agent_runtime_assignments WHERE thread_key = $1",
        thread_key,
    )
    assert state == "active"


@pytest.mark.asyncio
async def test_release_stale_runtime_assignments_preserves_undelivered_messages(db_pool):
    from api.agent import _release_stale_runtime_assignments

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    runtime_id = f"rt-{uuid.uuid4().hex[:8]}"
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state, updated_at"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active', "
        "NOW() - INTERVAL '2 days')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_message_requests ("
        "thread_key, message_id, assignment_generation, request_hash, event_json, metadata"
        ") VALUES ($1, 'msg-undelivered', 1, 'hash-msg', '{}'::jsonb, '{}'::jsonb)",
        thread_key,
    )

    backend = SimpleNamespace(status_by_id=AsyncMock(return_value="gone"))
    released = await _release_stale_runtime_assignments(db_pool, backend)

    assert released == 0
    backend.status_by_id.assert_not_awaited()
    state = await db_pool.fetchval(
        "SELECT state FROM agent_runtime_assignments WHERE thread_key = $1",
        thread_key,
    )
    assert state == "active"


@pytest.mark.asyncio
async def test_worker_marks_silence_deadline_exceeded_and_stops_session(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-idem', 'hash', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _silent_stream(*_args, **_kwargs):
        await asyncio.sleep(60)
        if False:
            yield {}

    stop_session_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _silent_stream),
        patch("api.runtime_control.stop_session", stop_session_mock),
        patch("api.runtime_control.EXECUTION_SILENCE_TIMEOUT_S", 0.05),
        patch("api.runtime_control.EXECUTION_WATCHDOG_POLL_S", 0.01),
    ):
        await _process_execution(db_pool, row)

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, error_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "failed_permanent"
    assert execution["terminal_reason"] == "silence_deadline_exceeded"
    assert "no progress" in (execution["error_text"] or "")
    stop_session_mock.assert_awaited_once_with(thread_key)


@pytest.mark.asyncio
async def test_worker_keeps_tool_timeout_while_command_execution_reports_progress(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-tool-wait', 'hash-tool-wait', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _tool_then_done_stream(*_args, **_kwargs):
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
                                "name": "shell_command",
                                "input": {"command": "python3 -c 'import time; time.sleep(1)'"},
                            }
                        ],
                    },
                }
            )
        }
        await asyncio.sleep(0.03)
        yield {
            "data": json.dumps(
                {
                    "type": "command_execution",
                    "command": "sleep 1",
                    "aggregated_output": "still running",
                    "status": "running",
                }
            )
        }
        await asyncio.sleep(0.08)
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "turn_id": 1,
                    "result": "merged",
                    "agent_thread_id": "",
                }
            )
        }

    stop_session_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _tool_then_done_stream),
        patch("api.runtime_control.stop_session", stop_session_mock),
        patch("api.runtime_control.EXECUTION_SILENCE_TIMEOUT_S", 0.05),
        patch("api.runtime_control.EXECUTION_TOOL_SILENCE_TIMEOUT_S", 0.2),
        patch("api.runtime_control.EXECUTION_WATCHDOG_POLL_S", 0.01),
    ):
        await _process_execution(db_pool, row)

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, result_text, error_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "completed"
    assert execution["terminal_reason"] == "completed"
    assert execution["result_text"] == "merged"
    assert execution["error_text"] in (None, "")
    stop_session_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_stops_session_when_cancel_requested_mid_stream(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-cancelled', 'hash-cancelled', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "status": "running",
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _cancelled_stream(*_args, **_kwargs):
        await db_pool.execute(
            "UPDATE agent_execution_requests SET status = 'cancel_requested', updated_at = NOW() "
            "WHERE execution_id = $1",
            execution_id,
        )
        yield {
            "data": json.dumps(
                {
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "partial"}]},
                }
            )
        }

    stop_session_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _cancelled_stream),
        patch("api.runtime_control.stop_session", stop_session_mock),
    ):
        await _process_execution(db_pool, row)

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, error_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "cancelled"
    assert execution["terminal_reason"] == "cancel_requested"
    assert execution["error_text"] == "cancel_requested"
    stop_session_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_reuses_durable_turn_id_without_reinjecting(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, durable_turn_id, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-existing', 'hash-existing', 'running', 'turn-existing', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "status": "running",
        "durable_turn_id": "turn-existing",
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _fake_stream(*_args, **_kwargs):
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "result": "done",
                    "is_error": False,
                }
            )
        }

    inject_stdin_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch("api.runtime_control.inject_stdin", inject_stdin_mock),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _fake_stream),
    ):
        await _process_execution(db_pool, row)

    backend.attach.assert_awaited_once_with(session)
    inject_stdin_mock.assert_not_awaited()

    execution = await db_pool.fetchrow(
        "SELECT status, durable_turn_id, result_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "completed"
    assert execution["durable_turn_id"] == "turn-existing"
    assert execution["result_text"] == "done"


@pytest.mark.asyncio
async def test_worker_retries_running_execution_when_stream_ends_without_turn_done(db_pool):
    from api.runtime_control import _claim_next_execution, _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    runtime_id = f"rt-retry-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, durable_turn_id, "
        "delivery, metadata, silence_deadline_at, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-retry', 'hash-retry', 'running', 'turn-existing', '{}'::jsonb, '{}'::jsonb, "
        "NOW() + INTERVAL '10 minutes', NOW() + INTERVAL '30 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "status": "running",
        "durable_turn_id": "turn-existing",
        "delivery": {},
        "silence_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30),
        "created_at": dt.datetime.now(dt.timezone.utc),
        "claimed_at": dt.datetime.now(dt.timezone.utc),
    }
    session = SandboxSession(
        sandbox_id=runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    stream_calls = 0

    async def _interrupted_then_done_stream(*_args, **_kwargs):
        nonlocal stream_calls
        stream_calls += 1
        if stream_calls == 1:
            if False:
                yield {}
            return
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "turn_id": 1,
                    "result": "recovered",
                    "agent_thread_id": "",
                }
            )
        }

    stop_session_mock = AsyncMock()
    inject_stdin_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock(), status=AsyncMock(return_value="running"))

    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch("api.runtime_control.inject_stdin", inject_stdin_mock),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _interrupted_then_done_stream),
        patch("api.runtime_control.stop_session", stop_session_mock),
        patch("api.runtime_control.EXECUTION_STREAM_EOF_RETRY_DELAY_S", 0.0),
    ):
        await _process_execution(db_pool, row)

        interrupted = await db_pool.fetchrow(
            "SELECT status, stream_break_count, terminal_reason, error_text "
            "FROM agent_execution_requests WHERE execution_id = $1",
            execution_id,
        )
        assert interrupted is not None
        assert interrupted["status"] == "retry_wait"
        assert interrupted["stream_break_count"] == 1
        assert interrupted["terminal_reason"] is None
        assert interrupted["error_text"] is None

        outbox = await db_pool.fetchrow(
            "SELECT state, final_payload FROM agent_final_delivery_outbox WHERE execution_id = $1",
            execution_id,
        )
        assert outbox is not None
        assert outbox["state"] == "awaiting_terminal"
        assert outbox["final_payload"] is None

        claimed = await _claim_next_execution(db_pool)
        assert claimed is not None
        assert claimed["execution_id"] == execution_id
        assert claimed["status"] == "running"

        await _process_execution(db_pool, claimed)

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, result_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "completed"
    assert execution["terminal_reason"] == "completed"
    assert execution["result_text"] == "recovered"
    inject_stdin_mock.assert_not_awaited()
    stop_session_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_refreshes_silence_deadline_when_resuming_existing_turn(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"

    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, "
        "persona_id, prompt_ref, effective_agents_md_sha256, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', 'active')",
        thread_key,
        prior_runtime_id,
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, durable_turn_id, "
        "delivery, metadata, silence_deadline_at, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-resume', 'hash-resume', 'running', 'turn-existing', '{}'::jsonb, '{}'::jsonb, NOW() - INTERVAL '1 minute', NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "status": "running",
        "durable_turn_id": "turn-existing",
        "silence_deadline_at": dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1),
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
        "delivery": {},
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _delayed_done_stream(*_args, **_kwargs):
        await asyncio.sleep(0.01)
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "result": "done",
                    "is_error": False,
                }
            )
        }

    inject_stdin_mock = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch("api.runtime_control.inject_stdin", inject_stdin_mock),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _delayed_done_stream),
        patch("api.runtime_control.EXECUTION_SILENCE_TIMEOUT_S", 1.0),
        patch("api.runtime_control.EXECUTION_WATCHDOG_POLL_S", 0.005),
    ):
        await _process_execution(db_pool, row)

    backend.attach.assert_awaited_once_with(session)
    inject_stdin_mock.assert_not_awaited()

    execution = await db_pool.fetchrow(
        "SELECT status, terminal_reason, result_text FROM agent_execution_requests WHERE execution_id = $1",
        execution_id,
    )
    assert execution is not None
    assert execution["status"] == "completed"
    assert execution["terminal_reason"] == "completed"
    assert execution["result_text"] == "done"


@pytest.mark.asyncio
async def test_worker_reapplies_agents_override_on_runtime_replacement(db_pool):
    from api.runtime_control import _process_execution

    thread_key = f"slack:C-test:{uuid.uuid4().hex}"
    execution_id = f"exe-{uuid.uuid4().hex[:12]}"
    prior_runtime_id = f"rt-old-{uuid.uuid4().hex[:8]}"
    resumed_runtime_id = f"rt-new-{uuid.uuid4().hex[:8]}"
    await db_pool.execute(
        "INSERT INTO agent_runtime_assignments ("
        "thread_key, assignment_generation, runtime_id, harness, engine, persona_id, "
        "prompt_ref, effective_agents_md_sha256, agents_md_override, state"
        ") VALUES ($1, 1, $2, 'amp', 'amp', NULL, 'harness:amp', 'sha', $3, 'active')",
        thread_key,
        prior_runtime_id,
        "You are a very specific persona.",
    )
    await db_pool.execute(
        "INSERT INTO agent_execution_requests ("
        "execution_id, thread_key, assignment_generation, execute_id, request_hash, status, "
        "delivery, metadata, hard_deadline_at"
        ") VALUES ($1, $2, 1, 'exec-idem', 'hash', 'running', '{}'::jsonb, '{}'::jsonb, NOW() + INTERVAL '10 minutes')",
        execution_id,
        thread_key,
    )
    await db_pool.execute(
        "INSERT INTO agent_final_delivery_outbox (execution_id, thread_key, delivery, state) "
        "VALUES ($1, $2, '{}'::jsonb, 'awaiting_terminal')",
        execution_id,
        thread_key,
    )

    row = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": 1,
        "delivery": {},
        "hard_deadline_at": dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10),
    }
    session = SandboxSession(
        sandbox_id=resumed_runtime_id,
        thread_key=thread_key,
        harness="amp",
        engine="amp",
    )

    async def _fake_stream(*_args, **_kwargs):
        yield {
            "data": json.dumps(
                {
                    "type": "turn.done",
                    "result": "done",
                    "is_error": False,
                }
            )
        }

    write_override = AsyncMock()
    backend = SimpleNamespace(attach=AsyncMock())
    with (
        patch("api.runtime_control.get_or_spawn", new=AsyncMock(return_value=session)),
        patch(
            "api.runtime_control.inject_stdin",
            new=AsyncMock(return_value={"ok": True, "injected": True, "durable_turn_id": "turn-1"}),
        ),
        patch("api.runtime_control.get_backend", return_value=backend),
        patch(
            "api.runtime_control._get_runtime",
            return_value=SimpleNamespace(turn_counter=1),
        ),
        patch("api.runtime_control._stream_stdout", _fake_stream),
        patch("api.runtime_control._write_agents_override", write_override),
    ):
        await _process_execution(db_pool, row)

    write_override.assert_awaited_once_with(
        resumed_runtime_id,
        "You are a very specific persona.",
    )


@pytest.mark.asyncio
async def test_bootstrap_service_api_keys_inserts_missing_rows(db_pool, monkeypatch):
    import api.api_keys as api_keys

    slack_key = f"aiv2_{uuid.uuid4().hex}{uuid.uuid4().hex}"
    monkeypatch.setenv("SLACKBOT_API_KEY", slack_key)
    monkeypatch.delenv("LOCAL_DEV_API_KEY", raising=False)

    bootstrapped = await api_keys.bootstrap_service_api_keys(db_pool, secret_manager_url="")

    assert [info.name for info in bootstrapped] == ["service:slackbot"]
    row = await db_pool.fetchrow(
        "SELECT name, key_prefix, scopes, revoked_at, created_by FROM api_keys WHERE key_hash = $1",
        hashlib.sha256(slack_key.encode()).hexdigest(),
    )
    assert row is not None
    assert row["name"] == "service:slackbot"
    assert row["key_prefix"] == slack_key[:8]
    assert list(row["scopes"]) == ["agent"]
    assert row["revoked_at"] is None
    assert row["created_by"] == "service-bootstrap"

    resolved = await api_keys.lookup_key(db_pool, slack_key)
    assert resolved is not None
    assert resolved.name == "service:slackbot"
    assert resolved.scopes == ["agent"]


@pytest.mark.asyncio
async def test_bootstrap_service_api_keys_fetches_and_reactivates_revoked_rows(
    db_pool,
    monkeypatch,
):
    import api.api_keys as api_keys

    slack_key = f"aiv2_{uuid.uuid4().hex}{uuid.uuid4().hex}"
    await db_pool.execute(
        "INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by, revoked_at) "
        "VALUES ($1, $2, $3, $4, $5, NOW())",
        "old-slackbot-key",
        slack_key[:8],
        hashlib.sha256(slack_key.encode()).hexdigest(),
        ["agent"],
        "manual",
    )
    monkeypatch.delenv("SLACKBOT_API_KEY", raising=False)
    monkeypatch.delenv("LOCAL_DEV_API_KEY", raising=False)

    async def fake_fetch_secret_value(secret_manager_url: str, key: str) -> str | None:
        assert secret_manager_url == "http://secret-manager"
        return slack_key if key == "SLACKBOT_API_KEY" else None

    monkeypatch.setattr(api_keys, "_fetch_secret_value", fake_fetch_secret_value)

    bootstrapped = await api_keys.bootstrap_service_api_keys(
        db_pool,
        secret_manager_url="http://secret-manager",
    )

    assert [info.name for info in bootstrapped] == ["service:slackbot"]
    row = await db_pool.fetchrow(
        "SELECT name, scopes, revoked_at, created_by FROM api_keys WHERE key_hash = $1",
        hashlib.sha256(slack_key.encode()).hexdigest(),
    )
    assert row is not None
    assert row["name"] == "service:slackbot"
    assert list(row["scopes"]) == ["agent"]
    assert row["revoked_at"] is None
    assert row["created_by"] == "service-bootstrap"


@pytest.mark.asyncio
async def test_bootstrap_service_api_keys_includes_local_dev_key(db_pool, monkeypatch):
    import api.api_keys as api_keys

    local_dev_key = f"aiv2_{uuid.uuid4().hex}{uuid.uuid4().hex}"
    monkeypatch.delenv("SLACKBOT_API_KEY", raising=False)
    monkeypatch.setenv("LOCAL_DEV_API_KEY", local_dev_key)

    bootstrapped = await api_keys.bootstrap_service_api_keys(db_pool, secret_manager_url="")

    assert [info.name for info in bootstrapped] == ["service:local-dev"]
    row = await db_pool.fetchrow(
        "SELECT name, scopes, revoked_at, created_by FROM api_keys WHERE key_hash = $1",
        hashlib.sha256(local_dev_key.encode()).hexdigest(),
    )
    assert row is not None
    assert row["name"] == "service:local-dev"
    assert list(row["scopes"]) == ["admin", "agent", "threads", "tools:*"]
    assert row["revoked_at"] is None
    assert row["created_by"] == "service-bootstrap"
