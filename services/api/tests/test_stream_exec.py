"""Tests for result extraction and message persistence (inject_stdin / stream_connect)."""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


# ---------------------------------------------------------------------------
# Result extraction — the bug was that result_text stayed "" because the code
# expected turn.done.result to be a dict, but it's actually a string.
# ---------------------------------------------------------------------------

def _extract_result(lines: list[str]) -> str:
    """Mimic the extraction logic in _stream_stdout."""
    result_text = ""
    for line in lines:
        try:
            evt = json.loads(line)
            if evt.get("type") == "turn.done":
                r = evt.get("result", "")
                result_text = (
                    r
                    if isinstance(r, str)
                    else r.get("text", "")
                    if isinstance(r, dict)
                    else ""
                )
            elif evt.get("type") == "result" and isinstance(evt.get("text"), str):
                result_text = evt["text"]
        except (json.JSONDecodeError, TypeError):
            pass
    return result_text


class TestResultExtraction:
    def test_string_result(self):
        lines = [
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({"type": "turn.done", "turn_id": 1, "result": "OK"}),
        ]
        assert _extract_result(lines) == "OK"

    def test_dict_result_with_text(self):
        lines = [
            json.dumps({"type": "turn.done", "turn_id": 1, "result": {"text": "hello"}}),
        ]
        assert _extract_result(lines) == "hello"

    def test_empty_result(self):
        lines = [
            json.dumps({"type": "turn.done", "turn_id": 1, "result": ""}),
        ]
        assert _extract_result(lines) == ""

    def test_missing_result_key(self):
        lines = [
            json.dumps({"type": "turn.done", "turn_id": 1}),
        ]
        assert _extract_result(lines) == ""

    def test_multiline_result(self):
        long_text = "Line 1\nLine 2\nLine 3"
        lines = [
            json.dumps({"type": "turn.done", "turn_id": 1, "result": long_text}),
        ]
        assert _extract_result(lines) == long_text

    def test_result_event_fallback(self):
        lines = [
            json.dumps({"type": "result", "text": "fallback answer"}),
        ]
        assert _extract_result(lines) == "fallback answer"

    def test_malformed_json_skipped(self):
        lines = [
            "not json at all",
            json.dumps({"type": "turn.done", "turn_id": 1, "result": "OK"}),
        ]
        assert _extract_result(lines) == "OK"

    def test_old_bug_dict_expectation_would_fail(self):
        """The old code did evt.get('result', {}).get('text', '') which returns ''
        when result is a plain string. This test ensures we handle strings."""
        line = json.dumps({"type": "turn.done", "turn_id": 1, "result": "DONE"})
        # Old logic (broken):
        evt = json.loads(line)
        old_result = (
            evt.get("result", {}).get("text", "")
            if isinstance(evt.get("result"), dict)
            else ""
        )
        assert old_result == "", "Old logic should return empty for string result"

        # New logic (fixed):
        assert _extract_result([line]) == "DONE"
