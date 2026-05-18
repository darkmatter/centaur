from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any


WRAPPER_PY = Path(__file__).resolve().parents[2] / "sandbox" / "claude-app-wrapper.py"


def _load_wrapper() -> ModuleType:
    spec = importlib.util.spec_from_file_location("claude_app_wrapper", WRAPPER_PY)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_claude_cmd_defaults(monkeypatch) -> None:
    wrapper = _load_wrapper()
    monkeypatch.delenv("CLAUDE_MODEL", raising=False)
    monkeypatch.delenv("CLAUDE_CONTINUE_SESSION_ID", raising=False)
    monkeypatch.delenv("AMP_CONTINUE_THREAD_ID", raising=False)
    monkeypatch.chdir(Path("/tmp"))

    cmd = wrapper._build_claude_cmd()

    assert cmd[0] == "claude"
    assert "-p" in cmd
    assert "--input-format" in cmd and "stream-json" in cmd
    assert "--output-format" in cmd
    assert "--dangerously-skip-permissions" in cmd
    assert "--permission-mode" in cmd
    assert cmd[cmd.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--verbose" in cmd
    assert "--include-partial-messages" in cmd
    assert "--include-hook-events" not in cmd
    assert "--append-system-prompt-file" not in cmd
    assert "--model" in cmd
    assert cmd[cmd.index("--model") + 1] == "opus"
    assert "--resume" not in cmd


def test_build_claude_cmd_appends_agents_prompt(monkeypatch, tmp_path) -> None:
    wrapper = _load_wrapper()
    monkeypatch.chdir(tmp_path)
    (tmp_path / "AGENTS.md").write_text("Centaur context\n")

    cmd = wrapper._build_claude_cmd()

    assert "--append-system-prompt-file" in cmd
    assert cmd[cmd.index("--append-system-prompt-file") + 1] == "AGENTS.md"


def test_build_claude_cmd_model_and_resume(monkeypatch) -> None:
    wrapper = _load_wrapper()
    monkeypatch.setenv("CLAUDE_MODEL", "claude-opus-4-7")
    monkeypatch.setenv("CLAUDE_CONTINUE_SESSION_ID", "abc-123")

    cmd = wrapper._build_claude_cmd()

    assert "--model" in cmd
    model_idx = cmd.index("--model")
    assert cmd[model_idx + 1] == "claude-opus-4-7"
    assert "--resume" in cmd
    resume_idx = cmd.index("--resume")
    assert cmd[resume_idx + 1] == "abc-123"


def test_resume_falls_back_to_amp_var(monkeypatch) -> None:
    wrapper = _load_wrapper()
    monkeypatch.delenv("CLAUDE_CONTINUE_SESSION_ID", raising=False)
    monkeypatch.setenv("AMP_CONTINUE_THREAD_ID", "legacy-amp-thread")

    cmd = wrapper._build_claude_cmd()
    assert "--resume" in cmd
    assert cmd[cmd.index("--resume") + 1] == "legacy-amp-thread"


def test_rewrite_goal_translates_slash_command() -> None:
    wrapper = _load_wrapper()
    rewritten = wrapper._rewrite_goal(
        [{"type": "text", "text": "/goal ship the auth refactor"}]
    )
    assert len(rewritten) == 1
    text = rewritten[0]["text"]
    assert "ship the auth refactor" in text
    assert "working goal" in text


def test_rewrite_goal_passes_through_non_goal_text() -> None:
    wrapper = _load_wrapper()
    blocks = [{"type": "text", "text": "please review this diff"}]
    assert wrapper._rewrite_goal(blocks) == blocks


def test_rewrite_goal_passes_through_multi_block_message() -> None:
    wrapper = _load_wrapper()
    blocks = [
        {"type": "text", "text": "/goal foo"},
        {"type": "text", "text": "extra"},
    ]
    assert wrapper._rewrite_goal(blocks) == blocks


def test_handle_input_user_message_forwards_envelope(monkeypatch) -> None:
    wrapper = _load_wrapper()
    sent: list[dict[str, Any]] = []

    def fake_send(payload: dict[str, Any]) -> None:
        sent.append(payload)
        wrapper.TURN_DONE.set()

    monkeypatch.setattr(wrapper, "send_to_claude", fake_send)
    monkeypatch.setattr(wrapper, "emit", lambda *_args, **_kwargs: None)

    wrapper.handle_input(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "reply PONG"}],
            },
        }
    )

    assert sent == [
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "reply PONG"}],
            },
        }
    ]


def test_handle_input_goal_rewrites_to_single_instruction(monkeypatch) -> None:
    wrapper = _load_wrapper()
    sent: list[dict[str, Any]] = []
    emitted: list[dict[str, Any]] = []

    def fake_send(payload: dict[str, Any]) -> None:
        sent.append(payload)
        wrapper.TURN_DONE.set()

    monkeypatch.setattr(wrapper, "send_to_claude", fake_send)
    monkeypatch.setattr(wrapper, "emit", lambda payload: emitted.append(payload))

    wrapper.handle_input(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "/goal ship feature X"}],
            },
        }
    )

    assert len(sent) == 1
    assert sent[0]["type"] == "user"
    assert "ship feature X" in sent[0]["message"]["content"][0]["text"]
    assert emitted == []


def test_handle_input_interrupt_calls_interrupt(monkeypatch) -> None:
    wrapper = _load_wrapper()
    called: list[bool] = []
    monkeypatch.setattr(wrapper, "interrupt_active_turn", lambda *_a: called.append(True))

    wrapper.handle_input({"type": "interrupt"})
    assert called == [True]


def test_queued_interrupt_is_processed_while_waiting(monkeypatch) -> None:
    wrapper = _load_wrapper()
    sent: list[dict[str, Any]] = []
    called: list[bool] = []

    def fake_send(payload: dict[str, Any]) -> None:
        sent.append(payload)
        wrapper.INPUTS.put({"type": "interrupt"})

    def fake_interrupt(*_args) -> None:
        called.append(True)
        wrapper.TURN_DONE.set()

    monkeypatch.setattr(wrapper, "send_to_claude", fake_send)
    monkeypatch.setattr(wrapper, "interrupt_active_turn", fake_interrupt)

    wrapper.handle_input(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "long task"}],
            },
        }
    )

    assert sent
    assert called == [True]


def test_interrupt_emits_terminal_result(monkeypatch) -> None:
    wrapper = _load_wrapper()
    emitted: list[dict[str, Any]] = []

    class FakeApp:
        pid = os.getpid()

        def poll(self) -> None:
            return None

    monkeypatch.setattr(wrapper, "APP", FakeApp())
    monkeypatch.setattr(wrapper, "emit", lambda payload: emitted.append(payload))
    monkeypatch.setattr(wrapper.os, "killpg", lambda *_args: None)
    monkeypatch.setattr(wrapper.os, "getpgid", lambda pid: pid)

    wrapper.TURN_DONE.clear()
    wrapper.interrupt_active_turn()

    assert wrapper.TURN_DONE.is_set()
    assert emitted == [
        {
            "type": "result",
            "subtype": "error",
            "is_error": True,
            "result": "interrupted",
            "stop_reason": "interrupted",
            "terminal_reason": "interrupted",
        }
    ]


_OTEL_VARS = (
    "CLAUDE_OTEL_LAMINAR_ENDPOINT",
    "CLAUDE_OTEL_LAMINAR_BASE_URL",
    "CODEX_OTEL_LAMINAR_BASE_URL",
    "LMNR_BASE_URL",
    "LMNR_PROJECT_API_KEY",
    "CENTAUR_TRACE_ID",
    "CENTAUR_THREAD_KEY",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_TRACES_EXPORTER",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "CLAUDE_OTEL_ENVIRONMENT",
    "CODEX_OTEL_ENVIRONMENT",
    "DEPLOY_ENV",
    "ENVIRONMENT",
)


def _scrub_otel_env(monkeypatch) -> None:
    for var in _OTEL_VARS:
        monkeypatch.delenv(var, raising=False)


def test_configure_otel_noop_without_endpoint(monkeypatch) -> None:
    wrapper = _load_wrapper()
    _scrub_otel_env(monkeypatch)

    wrapper._configure_otel()

    for var in (
        "CLAUDE_CODE_ENABLE_TELEMETRY",
        "OTEL_TRACES_EXPORTER",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_RESOURCE_ATTRIBUTES",
    ):
        assert var not in os.environ


def test_configure_otel_wires_laminar_from_base_url(monkeypatch) -> None:
    wrapper = _load_wrapper()
    _scrub_otel_env(monkeypatch)
    monkeypatch.setenv("LMNR_BASE_URL", "http://laminar:8000")
    monkeypatch.setenv("LMNR_PROJECT_API_KEY", "lmnr-secret")
    monkeypatch.setenv("CENTAUR_TRACE_ID", "trace-abc")
    monkeypatch.setenv("CENTAUR_THREAD_KEY", "slack:C123:1700000000.000100")
    monkeypatch.setenv("DEPLOY_ENV", "staging")

    wrapper._configure_otel()

    assert os.environ["CLAUDE_CODE_ENABLE_TELEMETRY"] == "1"
    assert os.environ["OTEL_TRACES_EXPORTER"] == "otlp"
    assert os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] == "http://laminar:8000/v1/traces"
    assert os.environ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"] == "http/protobuf"
    headers = os.environ["OTEL_EXPORTER_OTLP_HEADERS"]
    assert "Authorization=Bearer lmnr-secret" in headers
    assert "x-trace-id=trace-abc" in headers
    assert "x-centaur-thread-key=slack:C123:1700000000.000100" in headers
    attrs = os.environ["OTEL_RESOURCE_ATTRIBUTES"]
    assert "service.name=centaur-claude-code" in attrs
    assert "deployment.environment=staging" in attrs
    assert "centaur.trace_id=trace-abc" in attrs
    # Thread key is percent-encoded to comply with the OTEL attrs format.
    assert "centaur.thread_key=slack%3AC123%3A1700000000.000100" in attrs


def test_configure_otel_keeps_traces_endpoint(monkeypatch) -> None:
    wrapper = _load_wrapper()
    _scrub_otel_env(monkeypatch)
    monkeypatch.setenv("LMNR_BASE_URL", "https://lmnr.example.com/v1/traces")

    wrapper._configure_otel()

    assert (
        os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
        == "https://lmnr.example.com/v1/traces"
    )


def test_configure_otel_respects_explicit_endpoint(monkeypatch) -> None:
    wrapper = _load_wrapper()
    _scrub_otel_env(monkeypatch)
    monkeypatch.setenv(
        "CLAUDE_OTEL_LAMINAR_ENDPOINT", "https://custom.example/v1/ingest"
    )
    monkeypatch.setenv("LMNR_BASE_URL", "http://should-be-overridden:8000")

    wrapper._configure_otel()

    assert (
        os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
        == "https://custom.example/v1/ingest"
    )
