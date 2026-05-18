from api.observability import ExecutionObservationAccumulator, project_execution_observations


def _context() -> dict:
    return {
        "execution_id": "exe-123",
        "thread_key": "slack:C123:1.23",
        "assignment_generation": 7,
        "harness": "amp",
        "engine": "amp",
        "persona_id": "eng",
        "prompt_ref": "persona:eng",
        "prompt_sha": "sha-123",
    }


def test_project_execution_observations_and_summary_roll_up_usage_and_tools():
    accumulator = ExecutionObservationAccumulator()

    assistant_tool = {
        "type": "assistant",
        "message": {
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
    tool_result = {
        "type": "tool",
        "content": [{"tool_use_id": "toolu_test", "content": {"ok": True}, "is_error": False}],
    }
    assistant_text = {
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": "Here is the synthesis."}],
            "usage": {"input_tokens": 5, "output_tokens": 15, "cost_usd": 0.123},
            "model": "claude-sonnet",
        },
    }

    observations = []
    for event in (assistant_tool, tool_result, assistant_text):
        projected = project_execution_observations(event, **_context())
        observations.extend(projected)
        for event_kind, payload in projected:
            accumulator.observe(event_kind, payload)

    event_kinds = [event_kind for event_kind, _ in observations]
    assert event_kinds == [
        "assistant_tool_use_observed",
        "usage_observed",
        "tool_result_observed",
        "assistant_text_observed",
        "usage_observed",
    ]

    summary = accumulator.build_summary(
        **_context(),
        status="completed",
        terminal_reason="completed",
        duration_s=4.2,
    )
    assert summary["assistant_tool_use_events"] == 1
    assert summary["tool_result_events"] == 1
    assert summary["assistant_text_events"] == 1
    assert summary["assistant_text_chars"] == len("Here is the synthesis.")
    assert summary["total_tokens"] == 50
    assert summary["cost_usd"] == 0.123
    assert summary["models"] == ["claude-sonnet"]
    assert summary["tool_calls_by_name"] == {"web_search": 1}
