"""Tests for stream_reconnect skip_done_count — the handoff follow fix.

When the slackbot reconnects after a follow=true handoff, the API replays
the container's full stdout history (via logs=True).  The old turn's
turn.done event appears in the replay.  Without skip_done_count,
stream_reconnect would stop at the first turn.done and never stream the
followed thread's output.

skip_done_count=1 tells stream_reconnect to skip the first turn.done event
so the stream continues through to the followed thread's output and its
eventual turn.done.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _simulate_stream_turn(lines: list[str], *, skip_done_count: int = 0) -> list[str]:
    """Simulate the turn.done counting logic from stream_reconnect.

    Applies the same termination check as agent.py's stream_reconnect,
    returning only the lines that would be yielded before the generator
    breaks.
    """
    yielded: list[str] = []
    done_seen = 0

    for line in lines:
        yielded.append(line)
        try:
            evt = json.loads(line)
            if evt.get("type") == "turn.done":
                done_seen += 1
                if done_seen <= skip_done_count:
                    continue
                # Would return here in _stream_turn
                return yielded
        except (json.JSONDecodeError, TypeError):
            pass

    return yielded


# ── Fixtures that mimic real container stdout during a handoff ──────────

# The container stdout after a follow=true handoff looks like:
# 1. [original thread events]
# 2. turn.done from the original thread (empty result)
# 3. [followed thread events — new Amp thread in same container]
# 4. turn.done from the followed thread (with real result)

ORIGINAL_EVENTS = [
    json.dumps({"type": "system", "subtype": "init", "session_id": "T-original"}),
    json.dumps({
        "type": "assistant",
        "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "tool1", "name": "handoff",
             "input": {"goal": "Count lines", "follow": True}},
        ]},
    }),
    json.dumps({
        "type": "user",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tool1",
             "content": '{"newThreadID":"T-followed"}'},
        ]},
    }),
    json.dumps({"type": "result", "subtype": "error_during_execution",
                "is_error": True, "error": "Connection error."}),
    json.dumps({"type": "turn.done", "turn_id": 1, "result": ""}),
]

FOLLOWED_EVENTS = [
    json.dumps({"type": "system", "subtype": "init", "session_id": "T-followed"}),
    json.dumps({
        "type": "assistant",
        "message": {"role": "assistant", "content": [
            {"type": "text", "text": "AGENTS.md has 42 lines."},
        ]},
    }),
    json.dumps({"type": "turn.done", "turn_id": 1, "result": "AGENTS.md has 42 lines."}),
]


class TestSkipDoneCount:
    def test_default_stops_at_first_turn_done(self):
        """Without skip_done_count, stream stops at the old turn.done."""
        all_lines = ORIGINAL_EVENTS + FOLLOWED_EVENTS
        yielded = _simulate_stream_turn(all_lines, skip_done_count=0)
        # Should stop at the original turn.done (index 4)
        assert len(yielded) == len(ORIGINAL_EVENTS)
        last = json.loads(yielded[-1])
        assert last["type"] == "turn.done"
        assert last["result"] == ""

    def test_skip_one_streams_through_to_followed(self):
        """skip_done_count=1 skips old turn.done and continues to followed output."""
        all_lines = ORIGINAL_EVENTS + FOLLOWED_EVENTS
        yielded = _simulate_stream_turn(all_lines, skip_done_count=1)
        # Should include all original events + all followed events
        assert len(yielded) == len(all_lines)
        last = json.loads(yielded[-1])
        assert last["type"] == "turn.done"
        assert last["result"] == "AGENTS.md has 42 lines."

    def test_skip_zero_is_backward_compatible(self):
        """Normal reconnect (no handoff) should still stop at first turn.done."""
        normal_lines = [
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [
                    {"type": "text", "text": "Hello"},
                ],
            }}),
            json.dumps({"type": "turn.done", "turn_id": 1, "result": "Hello"}),
        ]
        yielded = _simulate_stream_turn(normal_lines, skip_done_count=0)
        assert len(yielded) == 3
        last = json.loads(yielded[-1])
        assert last["result"] == "Hello"

    def test_chained_handoff_skip_two(self):
        """Double handoff: skip_done_count=2 skips two turn.done events."""
        second_handoff_events = [
            json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [
                    {"type": "tool_use", "id": "tool2", "name": "handoff",
                     "input": {"goal": "Do more", "follow": True}},
                ],
            }}),
            json.dumps({"type": "turn.done", "turn_id": 1, "result": ""}),
        ]
        final_events = [
            json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [
                    {"type": "text", "text": "Final answer"},
                ],
            }}),
            json.dumps({"type": "turn.done", "turn_id": 1, "result": "Final answer"}),
        ]
        all_lines = ORIGINAL_EVENTS + second_handoff_events + final_events
        yielded = _simulate_stream_turn(all_lines, skip_done_count=2)
        assert len(yielded) == len(all_lines)
        last = json.loads(yielded[-1])
        assert last["result"] == "Final answer"

    def test_no_turn_done_returns_all(self):
        """If the stream has no turn.done (EOF), all lines are yielded."""
        lines = [
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [
                    {"type": "text", "text": "partial"},
                ],
            }}),
        ]
        yielded = _simulate_stream_turn(lines, skip_done_count=1)
        assert len(yielded) == 2
