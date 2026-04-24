from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from workflows.miq_tracker import (
    IR_MEMBERS,
    OPS_MEMBERS,
    _build_sheet_layout,
    _previous_week_dates,
    _resolve_member_directory,
)


def test_previous_week_dates_uses_last_completed_sun_thu_window() -> None:
    now = dt.datetime(2026, 4, 20, 4, 0, tzinfo=ZoneInfo("America/Los_Angeles"))

    dates = _previous_week_dates(now)

    assert dates == [
        dt.date(2026, 4, 12),
        dt.date(2026, 4, 13),
        dt.date(2026, 4, 14),
        dt.date(2026, 4, 15),
        dt.date(2026, 4, 16),
    ]


def test_resolve_member_directory_matches_real_names_and_usernames() -> None:
    users = [
        {
            "id": "U1",
            "name": "georgios",
            "real_name": "Georgios Konstantopoulos",
            "is_bot": False,
        },
        {
            "id": "U2",
            "name": "frankiexyz",
            "real_name": "Frankie Xyz",
            "is_bot": False,
        },
        {
            "id": "U3",
            "name": "danm",
            "real_name": "Dan McCarthy",
            "is_bot": False,
        },
    ]

    directory = _resolve_member_directory(
        users,
        ["Georgios Konstantopoulos", "Frankie xyz", "Dan McCarthy"],
    )

    assert directory["Georgios Konstantopoulos"].user_id == "U1"
    assert directory["Frankie xyz"].user_id == "U2"
    assert directory["Dan McCarthy"].user_id == "U3"


def test_build_sheet_layout_detects_headers_dates_and_member_columns() -> None:
    dates = [
        dt.date(2026, 4, 12),
        dt.date(2026, 4, 13),
        dt.date(2026, 4, 14),
        dt.date(2026, 4, 15),
        dt.date(2026, 4, 16),
    ]
    raw_values = [
        ["Week", "Alana Palmedo", "David Swain", "Jordan Qualls"],
        ["4/12/2026", "RIFF", "MIQ", "OOO"],
        ["4/13/2026", "MIQ", "No MIQ", "MIQ"],
    ]

    layout = _build_sheet_layout(
        "Ops 2026",
        raw_values,
        OPS_MEMBERS[:3],
        dates,
    )

    assert layout.header_row_index == 0
    assert layout.date_column_index == 0
    assert layout.member_columns == {
        "Alana Palmedo": 1,
        "David Swain": 2,
        "Jordan Qualls": 3,
    }
    assert layout.date_rows == {
        dt.date(2026, 4, 12): 1,
        dt.date(2026, 4, 13): 2,
    }
    assert layout.next_row_index == 3


def test_build_sheet_layout_handles_ir_tab_shape() -> None:
    dates = [
        dt.date(2026, 4, 12),
        dt.date(2026, 4, 13),
        dt.date(2026, 4, 14),
        dt.date(2026, 4, 15),
        dt.date(2026, 4, 16),
    ]
    raw_values = [
        ["Date", "Alana Palmedo", "Arjun Balaji", "Frankie xyz"],
        ["2026-04-12", "OOO", "MIQ", "RIFF"],
    ]

    layout = _build_sheet_layout(
        "I&R 2026",
        raw_values,
        IR_MEMBERS[:3],
        dates,
    )

    assert layout.member_columns["Frankie xyz"] == 3
    assert layout.date_rows[dt.date(2026, 4, 12)] == 1
