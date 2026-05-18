from __future__ import annotations

import datetime as dt

import pytest

from api.runtime_control import ControlPlaneError

from workflows.lp_meeting_brief_batch import (
    IR_CALENDAR_ID,
    Input,
    _dedupe_events,
    _agent_result_text,
    _looks_like_lp_meeting,
    _window_bounds,
    handler,
)


def _event(
    summary: str,
    *,
    attendees: list[str] | None = None,
    description: str = "",
    has_visibility: bool = True,
    event_id: str | None = None,
) -> dict:
    return {
        "id": event_id or summary.lower().replace(" ", "-"),
        "summary": summary,
        "description": description,
        "attendees": attendees or ["allocator@example.com", "owner@paradigm.xyz"],
        "has_visibility": has_visibility,
        "start": "2026-05-06T16:00:00+00:00",
    }


def test_ir_calendar_external_events_are_treated_as_lp_meetings() -> None:
    assert _looks_like_lp_meeting(
        _event("Conference catch-up with OPTrust"), IR_CALENDAR_ID
    )


def test_lp_meeting_filter_accepts_positive_examples_and_paraphrases() -> None:
    positives = [
        "LP briefing memo: OPTrust",
        "Meeting with Texas ERS pension team",
        "University endowment update",
        "Family office allocator intro",
        "Sovereign wealth fund diligence call",
    ]
    paraphrases = [
        "Same-day allocator prep for the retirement system",
        "Prep us for today's investor office meeting",
    ]

    for summary in [*positives, *paraphrases]:
        assert _looks_like_lp_meeting(_event(summary), "pam@paradigm.xyz"), summary


def test_lp_meeting_filter_rejects_negative_examples() -> None:
    negatives = [
        "Candidate interview loop",
        "Portfolio company board meeting",
        "Team all hands",
    ]
    for summary in negatives:
        assert not _looks_like_lp_meeting(_event(summary), "pam@paradigm.xyz"), summary


def test_lp_meeting_filter_rejects_private_or_internal_only_events() -> None:
    assert not _looks_like_lp_meeting(
        _event("Allocator meeting", has_visibility=False), IR_CALENDAR_ID
    )
    assert not _looks_like_lp_meeting(
        _event(
            "Allocator meeting",
            attendees=["owner@paradigm.xyz", "colleague@paradigm.xyz"],
        ),
        IR_CALENDAR_ID,
    )


def test_dedupe_events_keeps_first_copy_of_each_event() -> None:
    deduped = _dedupe_events(
        [
            _event("OPTrust", event_id="evt-1"),
            _event("OPTrust duplicate", event_id="evt-1"),
            _event("Mariner", event_id="evt-2"),
        ]
    )
    assert [event["id"] for event in deduped] == ["evt-1", "evt-2"]
    assert deduped[0]["summary"] == "OPTrust"


def test_window_bounds_uses_target_date_in_requested_timezone() -> None:
    start, end = _window_bounds(
        Input(target_date="2026-05-06", timezone="America/Los_Angeles"),
        dt.datetime(2026, 5, 5, 12, 0, tzinfo=dt.timezone.utc),
    )

    assert start.isoformat() == "2026-05-06T00:00:00-07:00"
    assert end.isoformat() == "2026-05-07T00:00:00-07:00"


def test_agent_result_text_accepts_direct_and_child_workflow_shapes() -> None:
    assert _agent_result_text({"result_text": "direct memo"}) == "direct memo"
    assert _agent_result_text({"output_json": {"result_text": "child memo"}}) == "child memo"
    assert _agent_result_text({"output_json": {"execution": {"result_text": "execution memo"}}}) == "execution memo"
    assert _agent_result_text({"status": "completed"}) == ""


class _StubCtx:
    def __init__(self, agent_result: dict):
        self.agent_result = agent_result

    async def run_agent(self, *_args, **_kwargs):
        return self.agent_result


@pytest.mark.asyncio
async def test_handler_fails_when_child_agent_workflow_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_call_tool_step(*_args, **_kwargs):
        return [_event("LP briefing memo: OPTrust")]

    monkeypatch.setattr("workflows.lp_meeting_brief_batch._call_tool_step", fake_call_tool_step)

    with pytest.raises(ControlPlaneError, match="LP brief child workflow failed"):
        await handler(
            Input(calendar_ids=[IR_CALENDAR_ID], create_docs=False, create_bundle_doc=False),
            _StubCtx({"status": "failed", "error_text": "boom"}),
        )


@pytest.mark.asyncio
async def test_handler_fails_when_child_agent_returns_empty_memo(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_call_tool_step(*_args, **_kwargs):
        return [_event("LP briefing memo: OPTrust")]

    monkeypatch.setattr("workflows.lp_meeting_brief_batch._call_tool_step", fake_call_tool_step)

    with pytest.raises(ControlPlaneError, match="returned no memo text"):
        await handler(
            Input(calendar_ids=[IR_CALENDAR_ID], create_docs=False, create_bundle_doc=False),
            _StubCtx({"status": "completed", "output_json": {}}),
        )
