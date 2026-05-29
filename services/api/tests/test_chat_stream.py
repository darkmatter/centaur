import json
from pathlib import Path

from api.chat_stream import (
    CHAT_STREAM_CHUNK_TYPES,
    CHAT_STREAM_EVENT_KIND,
    ChatStreamProjector,
    runtime_header_chunk,
)


def _assert_chat_sdk_chunk(chunk: dict) -> None:
    chunk_type = chunk.get("type")
    assert chunk_type in CHAT_STREAM_CHUNK_TYPES
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


def _project(*events: dict) -> list[dict]:
    projector = ChatStreamProjector()
    chunks: list[dict] = []
    for event in events:
        chunks.extend(projector.project(event))
    return chunks


def test_projector_emits_chat_sdk_chunks_for_amp_like_tool_and_text_flow():
    chunks = _project(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Bash",
                        "input": {
                            "command": "uv run pytest services/api/tests/test_chat_stream.py"
                        },
                    }
                ]
            },
        },
        {
            "type": "tool",
            "content": [
                {
                    "tool_use_id": "toolu_1",
                    "content": "1 passed",
                    "is_error": False,
                }
            ],
        },
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Done."}]},
        },
        {"type": "turn.done", "result": "Done."},
    )

    assert CHAT_STREAM_EVENT_KIND == "chat_stream_chunk"
    assert chunks == [
        {
            "type": "task_update",
            "id": "toolu_1",
            "title": "Command execution",
            "status": "in_progress",
            "details": "```sh\nuv run pytest services/api/tests/test_chat_stream.py\n```",
        },
        {
            "type": "task_update",
            "id": "toolu_1",
            "title": "Command execution",
            "status": "complete",
            "details": "```sh\nuv run pytest services/api/tests/test_chat_stream.py\n```",
            "output": "1 passed",
        },
        {"type": "markdown_text", "text": "Done."},
    ]


def test_projector_emits_terminal_result_as_markdown_when_no_text_streamed():
    chunks = _project(
        {"type": "turn.done", "result": "Final answer from terminal event."}
    )

    assert chunks == [
        {"type": "markdown_text", "text": "Final answer from terminal event."}
    ]


def test_projector_emits_only_new_suffix_for_canonical_assistant_snapshots():
    chunks = _project(
        {
            "type": "assistant",
            "message": {
                "id": "msg-1",
                "content": [{"type": "text", "text": "Partial"}],
            },
        },
        {
            "type": "assistant",
            "message": {
                "id": "msg-1",
                "content": [{"type": "text", "text": "Partial answer"}],
            },
        },
        {
            "type": "assistant",
            "message": {
                "id": "msg-1",
                "content": [{"type": "text", "text": "Partial answer"}],
            },
        },
    )

    assert chunks == [
        {"type": "markdown_text", "text": "Partial"},
        {"type": "markdown_text", "text": " answer"},
    ]


def test_projector_keeps_codex_commentary_and_answer_in_chat_sdk_chunk_shapes():
    chunks = _project(
        {
            "type": "item.started",
            "itemId": "thinking-1",
            "item": {"id": "thinking-1", "type": "agentMessage", "phase": "commentary"},
        },
        {
            "type": "item.agentMessage.delta",
            "itemId": "thinking-1",
            "delta": "Inspecting the failing test.",
        },
        {
            "type": "item.completed",
            "itemId": "thinking-1",
            "item": {
                "id": "thinking-1",
                "type": "agentMessage",
                "phase": "commentary",
                "text": "Inspecting the failing test.",
            },
        },
        {
            "type": "item.started",
            "itemId": "answer-1",
            "item": {"id": "answer-1", "type": "agentMessage", "phase": "final_answer"},
        },
        {
            "type": "item.agentMessage.delta",
            "itemId": "answer-1",
            "delta": "Use the API chunks.",
        },
        {
            "type": "item.completed",
            "itemId": "answer-1",
            "item": {
                "id": "answer-1",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": "Use the API chunks.",
            },
        },
        {"type": "turn.done", "result": "Use the API chunks."},
    )

    assert chunks == [
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: Inspecting the failing test",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: Inspecting the failing test",
            "status": "complete",
            "output": "Inspecting the failing test.",
        },
        {"type": "markdown_text", "text": "Use the API chunks."},
    ]


def test_projector_does_not_stream_accumulated_thinking_output_to_slack_cards():
    chunks = _project(
        {
            "type": "item.started",
            "itemId": "thinking-1",
            "item": {"id": "thinking-1", "type": "agentMessage", "phase": "commentary"},
        },
        {"type": "item.agentMessage.delta", "itemId": "thinking-1", "delta": "The"},
        {"type": "item.agentMessage.delta", "itemId": "thinking-1", "delta": " tool"},
        {"type": "item.agentMessage.delta", "itemId": "thinking-1", "delta": " worked."},
        {
            "type": "item.completed",
            "itemId": "thinking-1",
            "item": {
                "id": "thinking-1",
                "type": "agentMessage",
                "phase": "commentary",
                "text": "The tool worked.",
            },
        },
    )

    thinking_chunks = [
        chunk for chunk in chunks if chunk["type"] == "task_update" and chunk["id"] == "thinking"
    ]
    assert thinking_chunks == [
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: The",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: The tool",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: The tool worked",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: The tool worked",
            "status": "complete",
            "output": "The tool worked.",
        },
    ]


def test_projector_covers_every_vercel_chat_sdk_stream_chunk_type():
    chunks = _project(
        {
            "type": "turn.plan.updated",
            "plan": [
                {"step": "Inspect current state", "status": "queued"},
                {"step": "Run validation", "status": "running"},
                {"step": "Report result", "status": "completed"},
            ],
        },
        {"type": "reasoning", "text": "Thinking through the validation path."},
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Visible answer."}]},
        },
    )

    assert CHAT_STREAM_CHUNK_TYPES == {
        "markdown_text",
        "task_update",
        "plan_update",
    }
    for chunk in chunks:
        _assert_chat_sdk_chunk(chunk)
    assert {chunk["type"] for chunk in chunks} == CHAT_STREAM_CHUNK_TYPES
    assert chunks == [
        {"type": "plan_update", "title": "Execution plan"},
        {
            "type": "task_update",
            "id": "plan:1",
            "title": "Inspect current state",
            "status": "pending",
        },
        {
            "type": "task_update",
            "id": "plan:2",
            "title": "Run validation",
            "status": "in_progress",
        },
        {
            "type": "task_update",
            "id": "plan:3",
            "title": "Report result",
            "status": "complete",
        },
        {
            "type": "task_update",
            "id": "thinking",
            "title": "Thinking: Thinking through the validation path",
            "status": "in_progress",
        },
        {"type": "markdown_text", "text": "Visible answer."},
    ]


def test_projector_preserves_markdown_links_for_chat_sdk_slack_streaming():
    chunks = _project(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": "Review [the run](https://example.com/run/123) before merging.",
                    }
                ]
            },
        }
    )

    assert chunks == [
        {
            "type": "markdown_text",
            "text": "Review [the run](https://example.com/run/123) before merging.",
        }
    ]


def test_projector_separates_text_after_structured_progress():
    chunks = _project(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Checking."}]},
        },
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "Bash",
                        "input": {"command": "true"},
                    }
                ]
            },
        },
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Done."}]},
        },
    )

    assert chunks[-1] == {"type": "markdown_text", "text": "\n\nDone."}


def test_projector_uses_visible_command_title_without_markdown_ticks():
    chunks = _project(
        {
            "type": "item.completed",
            "item": {
                "id": "cmd-call",
                "type": "commandExecution",
                "command": '/bin/bash -lc "call kalshi list_events --limit 2"',
                "status": "completed",
                "exit_code": 0,
                "aggregated_output": '{"events":[]}',
            },
        },
    )

    assert chunks == [
        {
            "type": "task_update",
            "id": "cmd-call",
            "title": "Command execution",
            "status": "complete",
            "details": "```sh\ncall kalshi list_events --limit 2\n```",
            "output": '{"events":[]}',
        },
    ]


def test_projector_does_not_stream_accumulated_command_output_to_slack_cards():
    chunks = _project(
        {
            "type": "item.started",
            "item": {
                "id": "cmd-call",
                "type": "commandExecution",
                "command": "/bin/bash -lc 'call vlogs service_health'",
                "status": "inProgress",
            },
        },
        {
            "type": "item.commandExecution.outputDelta",
            "itemId": "cmd-call",
            "delta": '{"status":',
        },
        {
            "type": "item.commandExecution.outputDelta",
            "itemId": "cmd-call",
            "delta": "500}",
        },
        {
            "type": "item.completed",
            "item": {
                "id": "cmd-call",
                "type": "commandExecution",
                "command": "/bin/bash -lc 'call vlogs service_health'",
                "status": "failed",
                "exitCode": 1,
                "aggregatedOutput": '{"status":500}',
            },
        },
    )

    assert chunks == [
        {
            "type": "task_update",
            "id": "cmd-call",
            "title": "Command execution",
            "status": "in_progress",
            "details": "```sh\ncall vlogs service_health\n```",
        },
        {
            "type": "task_update",
            "id": "cmd-call",
            "title": "Command execution",
            "status": "error",
            "details": "```sh\ncall vlogs service_health\n```",
            "output": 'exit code 1\n{"status":500}',
        },
    ]


def test_projector_bounds_task_output_for_native_chat_sdk_task_cards():
    chunks = _project(
        {
            "type": "item.started",
            "itemId": "thinking-1",
            "item": {"id": "thinking-1", "type": "agentMessage", "phase": "commentary"},
        },
        {
            "type": "item.agentMessage.delta",
            "itemId": "thinking-1",
            "delta": "Inspecting " + "x" * 500,
        },
        {
            "type": "item.completed",
            "item": {
                "id": "cmd-call",
                "type": "commandExecution",
                "command": '/bin/bash -lc "call kalshi list_events --limit 2"',
                "status": "completed",
                "exit_code": 0,
                "aggregated_output": "```json\n" + '{"events":[' + '"x",' * 200 + '"z"]}' + "\n```",
            },
        },
    )

    for chunk in chunks:
        _assert_chat_sdk_chunk(chunk)
        if chunk["type"] == "task_update" and "output" in chunk:
            assert len(chunk["output"]) <= 230
            assert "```" not in chunk["output"]


def test_projector_polishes_real_codex_fixture_for_native_task_cards():
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "services/slackbot/test-fixtures/codex/exe_a89da7f248bb4724-min.json"
    )
    events = json.loads(fixture_path.read_text())["events"]
    chunks = _project(*events)

    for chunk in chunks:
        _assert_chat_sdk_chunk(chunk)
    task_chunks = [chunk for chunk in chunks if chunk["type"] == "task_update"]
    thinking_chunks = [
        chunk for chunk in task_chunks if str(chunk.get("title", "")).startswith("Thinking")
    ]
    assert thinking_chunks
    assert {chunk["id"] for chunk in thinking_chunks} == {"thinking"}
    assert any(
        chunk["title"].startswith("Thinking: Use the AI ecosystem brief skill")
        for chunk in thinking_chunks
    )
    for chunk in task_chunks:
        assert len(chunk["title"]) <= 128
        if "output" in chunk:
            assert len(chunk["output"]) <= 230
            assert "```" not in chunk["output"]


def test_runtime_header_chunk_keeps_metadata_at_top_as_markdown():
    assert runtime_header_chunk(
        harness="claude-code",
        engine="claude-code",
        persona_id=None,
        model="claude-opus-4-8",
        overlay_image="ghcr.io/tempoxyz/centaur-tempo:sha-3ce166a",
    ) == {
        "type": "markdown_text",
        "text": "_base · claude-code · claude-opus-4-8 · centaur-tempo:sha-3ce166a_\n\n",
    }


def test_runtime_header_chunk_infers_claude_code_default_model(monkeypatch):
    monkeypatch.delenv("CLAUDE_MODEL", raising=False)

    assert runtime_header_chunk(
        harness="claude-code",
        engine="claude-code",
        persona_id=None,
    ) == {
        "type": "markdown_text",
        "text": "_base · claude-code · claude-opus-4-8_\n\n",
    }


def test_projector_emits_slack_task_update_errors_for_failed_work():
    chunks = _project(
        {
            "type": "turn.plan.updated",
            "plan": [{"step": "Broken validation", "status": "failed"}],
        },
        {
            "type": "item.completed",
            "item": {
                "id": "cmd-1",
                "type": "commandExecution",
                "command": "false",
                "status": "completed",
                "exit_code": 1,
                "aggregated_output": "failed",
            },
        },
        {"type": "error", "error": "execution failed"},
    )

    for chunk in chunks:
        _assert_chat_sdk_chunk(chunk)
    error_chunks = [
        chunk
        for chunk in chunks
        if chunk["type"] == "task_update" and chunk["status"] == "error"
    ]
    assert error_chunks == [
        {
            "type": "task_update",
            "id": "plan:1",
            "title": "Broken validation",
            "status": "error",
        },
        {
            "type": "task_update",
            "id": "cmd-1",
            "title": "Command execution",
            "status": "error",
            "details": "```sh\nfalse\n```",
            "output": "exit code 1\nfailed",
        },
        {
            "type": "task_update",
            "id": error_chunks[2]["id"],
            "title": "Execution error",
            "status": "error",
            "output": "execution failed",
        },
    ]
