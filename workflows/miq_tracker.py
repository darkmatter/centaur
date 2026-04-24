"""Workflow: weekly MIQ/RIFF tracker for Paradigm Ops and I&R teams.

Runs every Monday at 4:00am PST. Evaluates the previous completed
Sun-Thu block for all members of #miq-operations and
#miq-investing-and-research, writes results to the MIQ tracker Google
Sheet, and posts a summary table into #miq-bot.

Status definitions:
  - MIQ    : member posted in channel before midnight PST on that day
  - RIFF   : member posted AND started a thread of 20+ words
             - Ops 2026 rule: thread can be started any time during that same week
             - I&R 2026 rule: thread must be started within 24 hours of the original post
  - No MIQ : no post by midnight PST on that day
  - OOO    : member marked OOO in Google Sheet (manual override for now)

Edge case: Alana Palmedo is on both teams. Her post in
#miq-investing-and-research counts for both Ops and I&R.

Results are always posted to #miq-bot; the destination is intentionally
not configurable at runtime.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "miq_tracker"


# ── Team rosters (canonical Slack display names) ─────────────────────────────
OPS_MEMBERS = [
    "Alana Palmedo", "David Swain", "Jordan Qualls", "Katie Biber",
    "Justin Slaughter", "Alex Grieve", "Dan McCarthy",
    "Josie Franciose McGuinn", "Veit Moeller", "Chris Kraeuter",
    "Pam Tholen", "Lindsay Slocum", "Ishan Goyal", "Ben Hinshaw",
    "Alex Popescu",
]

IR_MEMBERS = [
    "Alana Palmedo", "Arjun Balaji", "Frankie xyz", "Matt Huang",
    "Alpin Yukseloglu", "Ricardo de Arruda", "Storm Slivkoff",
    "Dan Robinson", "Georgios Konstantopoulos",
]

CHANNELS = {
    "Ops 2026": "#miq-operations",
    "I&R 2026": "#miq-investing-and-research",
}

SUMMARY_CHANNEL = "#miq-bot"
TRACKER_SHEET_ID = "1x7dGtXCRHOyEqT2PUaY9YNtf2Dhq2SPaYm04c-DcY7o"
SHEET_READ_RANGE = "A1:AZ500"
SLACK_DUMP_LIMIT = 1500

# Active weekdays (Sun=6, Mon=0, Tue=1, Wed=2, Thu=3 in Python weekday())
ACTIVE_WEEKDAYS = {6, 0, 1, 2, 3}  # Sun, Mon, Tue, Wed, Thu

RIFF_MIN_WORDS = 20
STATUS_RIFF = "RIFF"
STATUS_MIQ = "MIQ"
STATUS_NO_MIQ = "No MIQ"
STATUS_OOO = "OOO"
DATE_HEADER_CANDIDATES = {"date", "day", "week", "weekof", "weekending"}


@dataclass(frozen=True)
class SlackMember:
    canonical_name: str
    user_id: str
    username: str
    real_name: str


@dataclass(frozen=True)
class SheetLayout:
    tab: str
    raw_values: list[list[str]]
    header_row_index: int
    date_column_index: int
    member_columns: dict[str, int]
    date_rows: dict[dt.date, int]
    next_row_index: int


@dataclass
class Input:
    sheet_id: str = TRACKER_SHEET_ID
    timezone: str = "America/Los_Angeles"
    run_hour: int = 4  # 4am PST Mondays
    run_minute: int = 0
    max_iterations: int = 0  # 0 = run forever; set to 1 for one-shot test
    dry_run: bool = False  # if True, do not write to sheet or send summary
    summary_channel: str = SUMMARY_CHANNEL


# ── Core logic ───────────────────────────────────────────────────────────────

def _previous_week_dates(now_pst: dt.datetime) -> list[dt.date]:
    """Return the previous completed Sun-Thu block before ``now_pst``."""
    today = now_pst.date()
    days_since_last_completed_thursday = (today.weekday() - 3) % 7
    if days_since_last_completed_thursday == 0:
        days_since_last_completed_thursday = 7
    last_completed_thursday = today - dt.timedelta(days=days_since_last_completed_thursday)
    previous_sunday = last_completed_thursday - dt.timedelta(days=4)
    return [previous_sunday + dt.timedelta(days=i) for i in range(5)]


def _word_count(text: str) -> int:
    return len([w for w in text.split() if w.strip()])


def _compact_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def _quote_sheet_title(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def _col_to_a1(column_index: int) -> str:
    if column_index < 0:
        raise ValueError("column_index must be >= 0")
    value = column_index + 1
    letters = []
    while value > 0:
        value, remainder = divmod(value - 1, 26)
        letters.append(chr(ord("A") + remainder))
    return "".join(reversed(letters))


def _sheet_cell(raw_values: list[list[str]], row_index: int, column_index: int) -> str:
    if row_index >= len(raw_values):
        return ""
    row = raw_values[row_index]
    if column_index >= len(row):
        return ""
    return str(row[column_index]).strip()


def _is_ooo(value: str) -> bool:
    return str(value or "").strip().upper() == STATUS_OOO


def _parse_slack_timestamp(value: str, tz: ZoneInfo) -> dt.datetime | None:
    try:
        return dt.datetime.fromtimestamp(float(value), tz=dt.timezone.utc).astimezone(tz)
    except (TypeError, ValueError, OSError):
        return None


def _parse_sheet_date(value: str, *, year_hint: int | None = None) -> dt.date | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = re.sub(r"\s+", " ", text)

    with_year = [
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m/%d/%y",
        "%m-%d-%Y",
        "%m-%d-%y",
        "%b %d, %Y",
        "%B %d, %Y",
        "%a %m/%d/%Y",
        "%A %m/%d/%Y",
        "%a %b %d, %Y",
        "%A, %B %d, %Y",
    ]
    for fmt in with_year:
        try:
            return dt.datetime.strptime(normalized, fmt).date()
        except ValueError:
            continue

    if year_hint is not None:
        without_year = [
            "%m/%d",
            "%m-%d",
            "%b %d",
            "%B %d",
            "%a %m/%d",
            "%A %m/%d",
        ]
        for fmt in without_year:
            try:
                parsed = dt.datetime.strptime(normalized, fmt)
                return dt.date(year_hint, parsed.month, parsed.day)
            except ValueError:
                continue

    return None


def _render_date_cell(day: dt.date) -> str:
    return f"{day.month}/{day.day}/{day.year}"


def _find_header_row_index(raw_values: list[list[str]], members: list[str]) -> int:
    target_names = {_compact_name(member) for member in members}
    best_index = -1
    best_score = -1

    for row_index, row in enumerate(raw_values[:10]):
        row_cells = {_compact_name(str(cell)) for cell in row if str(cell).strip()}
        score = len(row_cells & target_names)
        if score > best_score:
            best_score = score
            best_index = row_index

    if best_index < 0 or best_score <= 0:
        raise ValueError("Could not locate tracker header row")

    return best_index


def _find_member_columns(header_row: list[str], members: list[str]) -> dict[str, int]:
    member_columns: dict[str, int] = {}
    header_compact = [_compact_name(str(cell)) for cell in header_row]

    for member in members:
        member_key = _compact_name(member)
        exact_match = next((index for index, cell in enumerate(header_compact) if cell == member_key), None)
        if exact_match is not None:
            member_columns[member] = exact_match
            continue

        partial_match = next(
            (
                index
                for index, cell in enumerate(header_compact)
                if cell and (member_key in cell or cell in member_key)
            ),
            None,
        )
        if partial_match is None:
            raise ValueError(f"Could not locate sheet column for member '{member}'")
        member_columns[member] = partial_match

    return member_columns


def _find_date_column_index(
    raw_values: list[list[str]],
    *,
    header_row_index: int,
    target_dates: list[dt.date],
) -> int:
    header_row = raw_values[header_row_index]
    for index, cell in enumerate(header_row):
        if _compact_name(str(cell)) in DATE_HEADER_CANDIDATES:
            return index

    best_index = 0
    best_score = -1
    year_hint = min(target_dates).year if target_dates else None
    column_count = max((len(row) for row in raw_values), default=0)

    for column_index in range(column_count):
        score = 0
        for row_index in range(header_row_index + 1, len(raw_values)):
            if _parse_sheet_date(_sheet_cell(raw_values, row_index, column_index), year_hint=year_hint):
                score += 1
        if score > best_score:
            best_score = score
            best_index = column_index

    if best_score <= 0:
        raise ValueError("Could not locate date column in tracker sheet")

    return best_index


def _build_sheet_layout(tab: str, raw_values: list[list[str]], members: list[str], dates: list[dt.date]) -> SheetLayout:
    if not raw_values:
        raise ValueError(f"Tab '{tab}' is empty")

    header_row_index = _find_header_row_index(raw_values, members)
    header_row = raw_values[header_row_index]
    member_columns = _find_member_columns(header_row, members)
    date_column_index = _find_date_column_index(
        raw_values, header_row_index=header_row_index, target_dates=dates
    )

    year_hint = min(dates).year if dates else None
    target_date_set = set(dates)
    date_rows: dict[dt.date, int] = {}
    last_nonempty_row_index = header_row_index

    for row_index in range(header_row_index + 1, len(raw_values)):
        row = raw_values[row_index]
        if any(str(cell).strip() for cell in row):
            last_nonempty_row_index = row_index
        row_date = _parse_sheet_date(
            _sheet_cell(raw_values, row_index, date_column_index),
            year_hint=year_hint,
        )
        if row_date in target_date_set and row_date not in date_rows:
            date_rows[row_date] = row_index

    return SheetLayout(
        tab=tab,
        raw_values=raw_values,
        header_row_index=header_row_index,
        date_column_index=date_column_index,
        member_columns=member_columns,
        date_rows=date_rows,
        next_row_index=last_nonempty_row_index + 1,
    )


def _ensure_tool_success(result: Any, *, tool: str, method: str) -> Any:
    if isinstance(result, dict) and result.get("error"):
        raise RuntimeError(f"{tool}.{method} failed: {result['error']}")
    return result


def _resolve_member_directory(users: list[dict[str, Any]], members: list[str]) -> dict[str, SlackMember]:
    resolved: dict[str, SlackMember] = {}
    filtered_users = [user for user in users if not user.get("deleted") and not user.get("is_bot")]

    for member in members:
        member_key = _compact_name(member)
        exact_matches = [
            user
            for user in filtered_users
            if member_key in {
                _compact_name(str(user.get("real_name") or "")),
                _compact_name(str(user.get("name") or "")),
            }
        ]
        candidates = exact_matches
        if not candidates:
            candidates = [
                user
                for user in filtered_users
                if member_key
                and (
                    member_key in _compact_name(str(user.get("real_name") or ""))
                    or _compact_name(str(user.get("real_name") or "")) in member_key
                    or member_key in _compact_name(str(user.get("name") or ""))
                    or _compact_name(str(user.get("name") or "")) in member_key
                )
            ]

        if len(candidates) != 1:
            raise ValueError(
                f"Expected exactly one Slack user for '{member}', found {len(candidates)}"
            )

        user = candidates[0]
        resolved[member] = SlackMember(
            canonical_name=member,
            user_id=str(user.get("id") or "").strip(),
            username=str(user.get("name") or "").strip(),
            real_name=str(user.get("real_name") or "").strip(),
        )

    return resolved


def _evaluate_member(
    member: str,
    day: dt.date,
    posts_by_member_day: dict[tuple[str, dt.date], list[dict[str, Any]]],
    ooo_overrides: dict[tuple[str, dt.date], bool],
    member_directory: dict[str, SlackMember],
    team_riff_rule: str,  # "same_week" (Ops) or "24h" (I&R)
) -> str:
    """Return one of: RIFF, MIQ, No MIQ, OOO."""
    if ooo_overrides.get((member, day)):
        return STATUS_OOO

    posts = posts_by_member_day.get((member, day), [])
    if not posts:
        return STATUS_NO_MIQ

    member_user_id = member_directory[member].user_id

    for post in posts:
        thread_replies = post.get("thread_replies", [])
        own_replies = [r for r in thread_replies if r["user_id"] == member_user_id]

        if team_riff_rule == "24h":
            post_ts = post["ts"]
            cutoff = post_ts + dt.timedelta(hours=24)
            qualifying = [
                reply
                for reply in own_replies
                if reply["ts"] <= cutoff and _word_count(reply["text"]) >= RIFF_MIN_WORDS
            ]
        else:  # same_week — any time during Sun-Thu of the same completed week
            week_start = day - dt.timedelta(days=day.weekday() + 1 if day.weekday() != 6 else 0)
            week_end = week_start + dt.timedelta(days=4)  # Sun..Thu
            qualifying = [
                reply
                for reply in own_replies
                if week_start <= reply["ts"].date() <= week_end
                and _word_count(reply["text"]) >= RIFF_MIN_WORDS
            ]

        if qualifying:
            return STATUS_RIFF

    return STATUS_MIQ


# ── Tool-backed helpers ──────────────────────────────────────────────────────

async def _read_sheet_layout(
    ctx: WorkflowContext,
    sheet_id: str,
    tab: str,
    members: list[str],
    dates: list[dt.date],
) -> SheetLayout:
    result = await ctx.call_tool(
        "gsuite",
        "sheets_read",
        {
            "spreadsheet_id": sheet_id,
            "range_notation": f"{_quote_sheet_title(tab)}!{SHEET_READ_RANGE}",
        },
    )
    payload = _ensure_tool_success(result, tool="gsuite", method="sheets_read")
    raw_values = payload.get("raw_values", []) if isinstance(payload, dict) else []
    return _build_sheet_layout(tab, raw_values, members, dates)


async def fetch_channel_posts(
    ctx: WorkflowContext,
    channel: str,
    dates: list[dt.date],
    member_directory: dict[str, SlackMember],
    timezone: ZoneInfo,
) -> dict[tuple[str, dt.date], list[dict[str, Any]]]:
    """Return member/day posts with inline thread replies from the Slack tool."""
    result = await ctx.call_tool(
        "slack",
        "dump_channel_with_threads",
        {
            "channel_name": channel.lstrip("#"),
            "limit": SLACK_DUMP_LIMIT,
            "min_replies": 0,
        },
    )
    payload = _ensure_tool_success(result, tool="slack", method="dump_channel_with_threads")
    messages = payload.get("messages", []) if isinstance(payload, dict) else []

    dates_set = set(dates)
    members_by_user_id = {member.user_id: member.canonical_name for member in member_directory.values()}
    posts_by_member_day: dict[tuple[str, dt.date], list[dict[str, Any]]] = {}

    for message in messages:
        user_id = str(message.get("user_id") or "").strip()
        member_name = members_by_user_id.get(user_id)
        if not member_name:
            continue

        ts = _parse_slack_timestamp(str(message.get("timestamp") or ""), timezone)
        if ts is None:
            continue
        day = ts.date()
        if day not in dates_set or day.weekday() not in ACTIVE_WEEKDAYS:
            continue

        replies = []
        for reply in message.get("replies", []):
            reply_ts = _parse_slack_timestamp(str(reply.get("timestamp") or ""), timezone)
            if reply_ts is None:
                continue
            replies.append(
                {
                    "user_id": str(reply.get("user_id") or "").strip(),
                    "ts": reply_ts,
                    "text": str(reply.get("text") or "").strip(),
                }
            )

        posts_by_member_day.setdefault((member_name, day), []).append(
            {
                "ts": ts,
                "text": str(message.get("text") or "").strip(),
                "thread_replies": replies,
            }
        )

    return posts_by_member_day


async def fetch_ooo_overrides(
    ctx: WorkflowContext,
    sheet_id: str,
    dates: list[dt.date],
) -> dict[tuple[str, dt.date], bool]:
    """Read any OOO entries already present in the tracker tabs."""
    overrides: dict[tuple[str, dt.date], bool] = {}

    for tab, members in (("Ops 2026", OPS_MEMBERS), ("I&R 2026", IR_MEMBERS)):
        layout = await _read_sheet_layout(ctx, sheet_id, tab, members, dates)
        for day, row_index in layout.date_rows.items():
            for member, column_index in layout.member_columns.items():
                if _is_ooo(_sheet_cell(layout.raw_values, row_index, column_index)):
                    overrides[(member, day)] = True

    return overrides


async def write_results_to_sheet(
    ctx: WorkflowContext,
    sheet_id: str,
    tab: str,
    members: list[str],
    dates: list[dt.date],
    results: dict[tuple[str, dt.date], str],
) -> dict[str, Any]:
    """Upsert one row per date while preserving any pre-existing OOO cells."""
    layout = await _read_sheet_layout(ctx, sheet_id, tab, members, dates)
    quoted_tab = _quote_sheet_title(tab)
    date_rows = dict(layout.date_rows)
    next_row_index = layout.next_row_index
    updates: list[dict[str, Any]] = []
    rows_appended = 0
    statuses_written = 0
    ooo_preserved = 0

    for day in sorted(dates):
        if day.weekday() not in ACTIVE_WEEKDAYS:
            continue

        row_index = date_rows.get(day)
        if row_index is None:
            row_index = next_row_index
            next_row_index += 1
            rows_appended += 1
            date_rows[day] = row_index
            updates.append(
                {
                    "range": (
                        f"{quoted_tab}!{_col_to_a1(layout.date_column_index)}{row_index + 1}"
                    ),
                    "values": [[_render_date_cell(day)]],
                }
            )

        for member in members:
            column_index = layout.member_columns[member]
            existing_value = _sheet_cell(layout.raw_values, row_index, column_index)
            if _is_ooo(existing_value):
                ooo_preserved += 1
                continue

            status = results.get((member, day), STATUS_NO_MIQ)
            updates.append(
                {
                    "range": f"{quoted_tab}!{_col_to_a1(column_index)}{row_index + 1}",
                    "values": [[status]],
                }
            )
            statuses_written += 1

    if updates:
        response = await ctx.call_tool(
            "gsuite",
            "sheets_batch_update",
            {
                "spreadsheet_id": sheet_id,
                "updates": updates,
                "value_input_option": "USER_ENTERED",
            },
        )
        _ensure_tool_success(response, tool="gsuite", method="sheets_batch_update")

    return {
        "tab": tab,
        "rows_appended": rows_appended,
        "statuses_written": statuses_written,
        "ooo_preserved": ooo_preserved,
    }


def _format_summary_table(
    members: list[str],
    dates: list[dt.date],
    results: dict[tuple[str, dt.date], str],
) -> list[str]:
    headers = ["Member", *[day.strftime("%a %-m/%-d") for day in dates]]
    rows = [
        [member, *[results.get((member, day), STATUS_NO_MIQ) for day in dates]]
        for member in members
    ]
    widths = [len(header) for header in headers]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))

    def format_row(values: list[str]) -> str:
        return " | ".join(value.ljust(widths[index]) for index, value in enumerate(values))

    separator = "-+-".join("-" * width for width in widths)
    return [format_row(headers), separator, *(format_row(row) for row in rows)]


def _build_summary_text(
    dates: list[dt.date],
    ops_members: list[str],
    ops_results: dict[tuple[str, dt.date], str],
    ir_members: list[str],
    ir_results: dict[tuple[str, dt.date], str],
) -> str:
    lines = [
        "*MIQ Tracker Update*",
        f"Week: `{dates[0]}` -> `{dates[-1]}`",
        f"Destination: `{SUMMARY_CHANNEL}`",
        "Legend: `RIFF`, `MIQ`, `OOO`, `No MIQ`",
        "",
        "*Ops 2026*",
        "```text",
        *_format_summary_table(ops_members, dates, ops_results),
        "```",
        "",
        "*I&R 2026*",
        "```text",
        *_format_summary_table(ir_members, dates, ir_results),
        "```",
    ]
    return "\n".join(lines)


async def send_summary_message(
    ctx: WorkflowContext,
    channel: str,
    dates: list[dt.date],
    ops_members: list[str],
    ops_results: dict[tuple[str, dt.date], str],
    ir_members: list[str],
    ir_results: dict[tuple[str, dt.date], str],
) -> dict[str, Any]:
    """Post the weekly summary table to the fixed MIQ bot channel."""
    text = _build_summary_text(dates, ops_members, ops_results, ir_members, ir_results)
    result = await ctx.call_tool(
        "slack",
        "send_message",
        {"channel": channel, "text": text, "no_attribution": True},
    )
    return _ensure_tool_success(result, tool="slack", method="send_message")


# ── Handler ──────────────────────────────────────────────────────────────────

async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Weekly run loop: evaluate the prior completed Sun-Thu block."""
    if not inp.sheet_id.strip():
        raise ValueError("sheet_id must be configured")
    if inp.summary_channel.strip().lstrip("#") != SUMMARY_CHANNEL.lstrip("#"):
        raise ValueError(f"summary_channel must remain fixed to {SUMMARY_CHANNEL}")

    iteration = 0
    tz = ZoneInfo(inp.timezone)
    all_members = list(dict.fromkeys([*OPS_MEMBERS, *IR_MEMBERS]))

    while True:
        iteration += 1
        now = dt.datetime.now(dt.timezone.utc).astimezone(tz)
        week_dates = _previous_week_dates(now)
        ctx.log(f"Evaluating completed week: {week_dates[0]} .. {week_dates[-1]}")

        users = await ctx.call_tool("slack", "list_users", {"limit": 1000})
        member_directory = _resolve_member_directory(
            _ensure_tool_success(users, tool="slack", method="list_users"),
            all_members,
        )

        ops_posts = await fetch_channel_posts(
            ctx, CHANNELS["Ops 2026"], week_dates, member_directory, tz
        )
        ir_posts = await fetch_channel_posts(
            ctx, CHANNELS["I&R 2026"], week_dates, member_directory, tz
        )
        ooo_overrides = await fetch_ooo_overrides(ctx, inp.sheet_id, week_dates)

        ops_results: dict[tuple[str, dt.date], str] = {}
        ir_results: dict[tuple[str, dt.date], str] = {}

        for day in week_dates:
            if day.weekday() not in ACTIVE_WEEKDAYS:
                continue
            for member in OPS_MEMBERS:
                posts_source = ir_posts if member == "Alana Palmedo" else ops_posts
                ops_results[(member, day)] = _evaluate_member(
                    member,
                    day,
                    posts_source,
                    ooo_overrides,
                    member_directory,
                    "same_week",
                )
            for member in IR_MEMBERS:
                ir_results[(member, day)] = _evaluate_member(
                    member,
                    day,
                    ir_posts,
                    ooo_overrides,
                    member_directory,
                    "24h",
                )

        if not inp.dry_run:
            await write_results_to_sheet(
                ctx, inp.sheet_id, "Ops 2026", OPS_MEMBERS, week_dates, ops_results
            )
            await write_results_to_sheet(
                ctx, inp.sheet_id, "I&R 2026", IR_MEMBERS, week_dates, ir_results
            )
            await send_summary_message(
                ctx,
                SUMMARY_CHANNEL,
                week_dates,
                OPS_MEMBERS,
                ops_results,
                IR_MEMBERS,
                ir_results,
            )

        if inp.max_iterations > 0 and iteration >= inp.max_iterations:
            return {
                "status": "done",
                "iterations": iteration,
                "week": [str(day) for day in week_dates],
                "sheet_id": inp.sheet_id,
                "summary_channel": SUMMARY_CHANNEL,
            }

        days_until_monday = (0 - now.weekday()) % 7 or 7
        next_monday = now + dt.timedelta(days=days_until_monday)
        next_run = next_monday.replace(
            hour=inp.run_hour, minute=inp.run_minute, second=0, microsecond=0
        )
        if next_run <= now:
            next_run += dt.timedelta(days=7)

        await ctx.sleep(f"wait_{iteration + 1}", next_run - now)
