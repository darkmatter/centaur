import importlib.util
import json
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[2] / "sandbox" / "amp-wrapper.py"


def _load_amp_wrapper_module():
    spec = importlib.util.spec_from_file_location("test_amp_wrapper_module", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(monkeypatch, build_results, *, startup_tid: str = ""):
    module = _load_amp_wrapper_module()
    emitted: list[dict] = []
    commands: list[dict] = []

    monkeypatch.setattr(module, "AMP_BASE", ["amp"])
    monkeypatch.setattr(module.signal, "signal", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(module, "emit", lambda line: emitted.append(json.loads(line)))

    if startup_tid:
        monkeypatch.setenv("AMP_CONTINUE_THREAD_ID", startup_tid)
    else:
        monkeypatch.delenv("AMP_CONTINUE_THREAD_ID", raising=False)

    results = iter(build_results(module))

    def fake_run(cmd, stdin_data=None):
        commands.append({"cmd": cmd, "stdin_data": stdin_data})
        return next(results)

    monkeypatch.setattr(module, "run", fake_run)

    with pytest.raises(SystemExit) as excinfo:
        module.main()

    assert excinfo.value.code == 0
    return module, emitted, commands


def test_main_emits_heartbeat_before_startup_and_handoff_continue(monkeypatch):
    module, emitted, commands = _run_main(
        monkeypatch,
        lambda mod: [mod.RunResult(0, chain_tid="T-next"), mod.RunResult(0)],
    )

    assert emitted == [
        {
            "type": "system",
            "subtype": module.WRAPPER_HEARTBEAT_SUBTYPE,
            "phase": "startup",
        },
        {
            "type": "system",
            "subtype": module.WRAPPER_HEARTBEAT_SUBTYPE,
            "phase": "handoff_continue",
        },
    ]
    assert commands == [
        {"cmd": ["amp"], "stdin_data": None},
        {
            "cmd": ["amp", "threads", "continue", "T-next"],
            "stdin_data": module.CONTINUE_MSG,
        },
    ]


def test_main_emits_heartbeat_before_crash_restart(monkeypatch):
    module, emitted, commands = _run_main(
        monkeypatch,
        lambda mod: [mod.RunResult(1), mod.RunResult(0)],
    )

    assert [event for event in emitted if event["type"] == "system"] == [
        {
            "type": "system",
            "subtype": module.WRAPPER_HEARTBEAT_SUBTYPE,
            "phase": "startup",
        },
        {
            "type": "system",
            "subtype": module.WRAPPER_HEARTBEAT_SUBTYPE,
            "phase": "crash_restart",
        },
    ]
    assert emitted[1] == {
        "type": "error",
        "error": {"message": "amp exited with code 1, restarting (1/5)"},
    }
    assert commands == [
        {"cmd": ["amp"], "stdin_data": None},
        {"cmd": ["amp"], "stdin_data": None},
    ]
