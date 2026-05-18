from __future__ import annotations

import sys
import types


def test_set_trace_context_uses_supported_laminar_session_signature(monkeypatch):
    from api import laminar_tracing

    calls: list[tuple[str, object]] = []

    class FakeLaminar:
        @staticmethod
        def set_session(*, session_id=None):
            calls.append(("session", session_id))

        @staticmethod
        def set_metadata(metadata):
            calls.append(("metadata", metadata))

    fake_lmnr = types.SimpleNamespace(Laminar=FakeLaminar)
    monkeypatch.setitem(sys.modules, "lmnr", fake_lmnr)
    monkeypatch.setattr(laminar_tracing, "_available", True)
    monkeypatch.setattr(laminar_tracing, "_initialized", True)

    laminar_tracing.set_trace_context(
        user_id="U123",
        session_id="thread-1",
        metadata={"thread_key": "thread-1"},
    )

    assert calls == [
        ("session", "thread-1"),
        ("metadata", {"thread_key": "thread-1", "user_id": "U123"}),
    ]
