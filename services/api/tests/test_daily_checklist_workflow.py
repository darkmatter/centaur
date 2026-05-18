from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from workflows.daily_checklist_digest import (
    Input,
    _extract_dated_sections,
    _iteration_prefix,
    _manual_slack_target,
    _select_previous_section,
    _start_of_week_utc,
)


def test_extract_dated_sections_and_select_previous_day() -> None:
    text = """
    Apr 10, 2026
    Carry over item A
    Carry over item B

    Apr 11, 2026
    Most recent prior-day item

    Apr 12, 2026
    Current-day item that should not seed tomorrow's checklist when run on Apr 12
    """

    sections = _extract_dated_sections(text)

    assert [section_date.isoformat() for section_date, _ in sections] == [
        "2026-04-10",
        "2026-04-11",
        "2026-04-12",
    ]

    section_date, section_text = _select_previous_section(
        text,
        today=dt.date(2026, 4, 12),
    )

    assert section_date == dt.date(2026, 4, 11)
    assert "Most recent prior-day item" in section_text
    assert "Current-day item" not in section_text


def test_select_previous_day_from_reverse_chronological_doc() -> None:
    text = """
    Apr 12, 2026
    Current-day item

    Apr 11, 2026
    Expected prior-day item

    Apr 10, 2026
    Older item
    """

    section_date, section_text = _select_previous_section(
        text,
        today=dt.date(2026, 4, 12),
    )

    assert section_date == dt.date(2026, 4, 11)
    assert "Expected prior-day item" in section_text
    assert "Older item" not in section_text


def test_start_of_week_uses_local_monday_boundary() -> None:
    now_local = dt.datetime(2026, 4, 12, 9, 30, tzinfo=ZoneInfo("America/New_York"))

    week_start, week_start_utc = _start_of_week_utc(now_local)

    assert week_start == dt.date(2026, 4, 6)
    assert week_start_utc == dt.datetime(2026, 4, 6, 4, 0, tzinfo=dt.timezone.utc)


def test_manual_slack_target_prefers_explicit_slack_fields() -> None:
    channel, thread_ts = _manual_slack_target(
        Input(
            slack_channel="asher-daily-checklist",
            slack_thread_ts="1776028628.021259",
        )
    )

    assert channel == "asher-daily-checklist"
    assert thread_ts == "1776028628.021259"


def test_iteration_prefix_changes_per_run_cycle() -> None:
    assert _iteration_prefix(1) == "iteration_1"
    assert _iteration_prefix(2) == "iteration_2"
