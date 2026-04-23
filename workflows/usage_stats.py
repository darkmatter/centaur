"""Workflow: regenerate usage stats for the Centaur usage dashboard.

Queries agent_execution_events (Postgres) for tool/skill/user/team data
and nginx access logs (VictoriaLogs) for app traffic. Writes aggregated
stats to the usage_stats table as a single JSONB blob.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from typing import Any

import httpx

from api.workflow_engine import WorkflowContext

log = logging.getLogger(__name__)

WORKFLOW_NAME = "usage_stats"
INTERVAL = 300  # every 5 minutes

USER_MAP = {
    "U016MDTJM4J": ("Georgios Konstantopoulos", "georgios"),
    "U016V976J67": ("Jordan Qualls", "jordan"),
    "U01E7K6TC23": ("Lindsay Slocum", "lindsay"),
    "U01EG4BF4P7": ("Dan McCarthy", "dmccarthy"),
    "U02BCK5JFEG": ("Alex Ehlers", "alex"),
    "U02NBBUC6L8": ("Frankie xyz", "frankie"),
    "U02QKB5V6MC": ("Justin Slaughter", "justin"),
    "U03FGFTMG5A": ("Josie McGuinn", "josie"),
    "U03H4BH5AGL": ("Katie Biber", "katie"),
    "U03SDG6C6TC": ("Karina Berry", "karina"),
    "U03T8NE9JQH": ("Elena Page", "elena"),
    "U045TR9PGAZ": ("Brandon Wong", "brandon"),
    "U04889DSTEX": ("Dominique Little", "dominique"),
    "U04BL2T3D1S": ("Storm Slivkoff", "storm"),
    "U04BXMURWB0": ("Amy Sinclair", "amy"),
    "U04BY02ADG8": ("Alana Palmedo", "apalmedo"),
    "U05GY06RHMY": ("Alex Grieve", "agrieve"),
    "U05L1BZ4TJL": ("Chris Shu", "chris"),
    "U05P8C3NL0K": ("Tony Coppola", "tony"),
    "U05T7DMT84A": ("Vidhu Pinnamaraju", "vidhu"),
    "U076CL29AP5": ("David Swain", "david"),
    "U07F8P45GE4": ("Gracie Globerman", "gracie"),
    "U08ECTHML6T": ("Alpin Yukseloglu", "alpin"),
    "U08RSFNLG4W": ("Ricardo de Arruda", "ricardo"),
    "U08SGTSS5QS": ("Caleb Onofrei", "caleb"),
    "U08SPTN5Z36": ("Karina Ruiz Garcia", "kruizgarcia"),
    "U092QGQPD1N": ("Jordan Kong", "jkong"),
    "U0936H4LM8V": ("Veit Moeller", "veit"),
    "U094WMH3GPL": ("Chris Kraeuter", "ckraeuter"),
    "U09MYLH6K5F": ("Madison Parker", "madison"),
    "U09QAKUEHQB": ("Spencer Fluetsch", "spencer"),
    "U09TLJNR4PR": ("Ishan Goyal", "ishan"),
    "U0A1XRY62Q0": ("Trevor Holmgren", "trevor"),
    "U0A3UL147TN": ("Rama Somayajula", "rama"),
    "U0A43GX8Z8R": ("Asher Sedlin", "asher"),
    "U0A4UDV8VK2": ("Pam Tholen", "pam"),
    "U0A5X8LFC10": ("Chris Mann", "cmann"),
    "U0A88CAMB96": ("Stefan Schropp", "stefan"),
    "UGX1TH8TS": ("Dan Robinson", "dan"),
    "UGZCSQTPE": ("Matt Huang", "matt"),
    "UJ34LKUH0": ("Arjun Balaji", "arjun"),
}

TEAM_MAP = {
    "U016MDTJM4J": "I&R", "UGZCSQTPE": "I&R", "UGX1TH8TS": "I&R",
    "U02NBBUC6L8": "I&R", "U04BY02ADG8": "I&R", "UJ34LKUH0": "I&R",
    "U08ECTHML6T": "I&R", "U08RSFNLG4W": "I&R", "U04BL2T3D1S": "I&R",
    "U05L1BZ4TJL": "Talent", "U01EG4BF4P7": "Talent",
    "U01E7K6TC23": "Finance", "U0A4UDV8VK2": "Finance",
    "U016V976J67": "Finance", "U09QAKUEHQB": "Finance",
    "U0A43GX8Z8R": "Finance", "U05T7DMT84A": "Finance",
    "U08SGTSS5QS": "Finance", "U02BCK5JFEG": "Finance",
    "U0A3UL147TN": "Trading",
    "U092QGQPD1N": "Operations", "U0A1XRY62Q0": "Operations",
    "U09TLJNR4PR": "Operations",
    "U03H4BH5AGL": "Legal", "U0A88CAMB96": "Legal",
    "U04889DSTEX": "Policy", "U05GY06RHMY": "Policy",
    "U02QKB5V6MC": "Policy", "U09MYLH6K5F": "Policy",
    "U076CL29AP5": "Communications", "U094WMH3GPL": "Communications",
    "U0936H4LM8V": "Communications",
    "U03FGFTMG5A": "Events", "U05P8C3NL0K": "Events",
    "U08SPTN5Z36": "Events",
    "U03T8NE9JQH": "Admin", "U04BXMURWB0": "Admin",
    "U07F8P45GE4": "Admin", "U03SDG6C6TC": "Admin",
    "U045TR9PGAZ": "Engineering", "U0A5X8LFC10": "Engineering",
}

TEAM_EMOJIS = {
    "I&R": "\U0001F52C", "Finance": "\U0001F4B0", "Admin": "\U0001F4C5",
    "Policy": "\U0001F3DB", "Leadership": "\U0001F451",
    "Communications": "\U0001F4E2", "Legal": "\u2696\uFE0F",
    "Trading": "\U0001F4C8", "Events": "\U0001F389",
    "Engineering": "\U0001F527", "Talent": "\U0001F465",
    "Operations": "\u2699\uFE0F", "Centaur": "\U0001F916",
    "Other": "\U0001F4AC",
}

SKILL_EMOJIS = {
    "gap-analysis": "\U0001F50D", "improve-gap-task": "\U0001F4A1",
    "policy-gigabrain": "\U0001F9E0", "building-skills": "\U0001F3D7",
    "sourcer": "\U0001F3AF", "learning-synthesis": "\U0001F4DA",
    "centaur-builder": "\U0001F6E0", "josh-thought-partner": "\U0001F4AC",
    "tldr": "\U0001F4CB", "creating-tools": "\U0001F527",
    "walkthrough": "\U0001F6B6", "talent-placement-updates": "\U0001F465",
    "qa": "\u2705", "term-sheet": "\U0001F4DD",
    "writing-friday-intl-slack": "\u270D\uFE0F",
    "archiving-thread-files-to-drive": "\U0001F4E6",
    "ship": "\U0001F680", "trade-approval": "\U0001F4B1",
    "preparing-monthly-trade-compliance": "\U0001F4CA",
    "slack-artifact-retrieval": "\U0001F50E", "gtm": "\U0001F4E3",
    "ir-companyprep": "\U0001F3E2", "researching-event-dates": "\U0001F4C5",
    "venue-scout": "\U0001F4CD",
}

APP_EMOJIS = {
    "docs": "\U0001F4D6", "usage": "\U0001F4CA",
    "hello-react": "\u269B\uFE0F", "tool-dashboard": "\U0001F4CA",
    "paradigm-sentiment-tracker": "\U0001F4C8",
    "block-metrics": "\u26D3\uFE0F", "dashboard": "\U0001F4CA",
    "test": "\U0001F9EA", "shift-timeline": "\U0001F4C5",
    "touchpoint-bot": "\U0001F916",
}

NOISE_WORDS = frozenset({
    "it", "on", "in", "to", "at", "or", "an", "is", "be", "do",
    "him", "her", "out", "them", "through", "and", "parity", "tool",
    "ordering", "these", "this", "that",
})

INTERNAL_TOOLS = frozenset({
    "paradigmdb", "vlogs", "personas", "workflow", "agent", "investmemos",
    "research", "events", "termsheet", "social-monitor", "demo", "unit410",
    "infra", "crypto", "archiver", "media", "vmetrics", "metadata",
    "productivity", "comms", "nano-banana", "read_web_page",
})

STATIC_EXTS = frozenset({
    "css", "js", "png", "ico", "json", "svg", "jpg",
    "woff", "woff2", "map", "webp",
})

CALL_RE = re.compile(r"call\s+([a-z][a-z0-9_-]*)\s+([a-z][a-z0-9_-]*)")
CURL_RE = re.compile(r"/tools/([a-z][a-z0-9_-]+)/([a-z][a-z0-9_-]+)")


def _thread_to_slack_url(thread_key: str) -> str | None:
    if ":" not in thread_key:
        return None
    channel, ts = thread_key.split(":", 1)
    if not channel.startswith(("C", "D", "G")):
        return None
    return f"https://slack.com/archives/{channel}/p{ts.replace('.', '')}"


def _parse_tool_call(cmd: str) -> tuple[str, str] | None:
    m = CALL_RE.match(cmd)
    if m and m.group(1) != "discover":
        return m.group(1), m.group(2)
    m = CURL_RE.search(cmd)
    if m:
        return m.group(1), m.group(2)
    return None


def _fmt_user(uid: str, cnt: int) -> str:
    if uid == "unknown":
        return f"Centaur ({cnt})"
    name = USER_MAP.get(uid, (uid,))[0]
    short = name.split()[0] if " " in name else name
    return f"{short} ({cnt})"


async def _get_thread_users(pool) -> dict[str, str]:
    rows = await pool.fetch(
        "SELECT thread_key, user_id FROM ("
        "  SELECT thread_key, user_id,"
        "    ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY created_at) as rn"
        "  FROM chat_messages WHERE role = 'user' AND user_id IS NOT NULL"
        ") sub WHERE rn = 1"
    )
    return {r["thread_key"]: r["user_id"] for r in rows}


async def _extract_tools_and_users(
    pool, thread_users: dict[str, str],
) -> tuple[list[dict], list[dict]]:
    """Single pass over shell_command events to build both tool and user stats."""
    rows = await pool.fetch(
        "SELECT thread_key, created_at, event_json::text as ej "
        "FROM agent_execution_events "
        "WHERE event_kind = 'amp_raw_event' "
        "  AND event_json->>'type' = 'assistant' "
        "  AND event_json::text LIKE '%shell_command%'"
        "  AND created_at > NOW() - INTERVAL '90 days'"
    )

    tool_stats: dict[str, dict] = {}
    user_stats: dict[str, dict] = {}

    for row in rows:
        ej = json.loads(row["ej"])
        for block in ej.get("message", {}).get("content", []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") != "shell_command":
                continue
            cmd = block.get("input", {}).get("command", "")
            parsed = _parse_tool_call(cmd)
            if not parsed:
                continue
            tool, method = parsed
            if tool in NOISE_WORDS:
                continue

            uid = thread_users.get(row["thread_key"], "unknown")
            day = row["created_at"].strftime("%Y-%m-%d")

            # Tool stats
            if tool not in tool_stats:
                tool_stats[tool] = {
                    "count": 0, "threads": set(), "users": Counter(),
                    "methods": Counter(), "first": "9999", "last": "0000",
                    "first_thread": None, "last_thread": None,
                }
            ts = tool_stats[tool]
            ts["count"] += 1
            ts["threads"].add(row["thread_key"])
            ts["users"][uid] += 1
            ts["methods"][method] += 1
            if day < ts["first"]:
                ts["first"] = day
                ts["first_thread"] = row["thread_key"]
            if day >= ts["last"]:
                ts["last"] = day
                ts["last_thread"] = row["thread_key"]

            # User stats
            if uid not in user_stats:
                user_stats[uid] = {
                    "count": 0, "threads": set(), "tools": set(),
                    "top_tools": Counter(),
                }
            us = user_stats[uid]
            us["count"] += 1
            us["threads"].add(row["thread_key"])
            us["tools"].add(tool)
            us["top_tools"][tool] += 1

    # Build tool rows
    tool_rows = []
    for tool in sorted(tool_stats, key=lambda t: len(tool_stats[t]["threads"]), reverse=True):
        s = tool_stats[tool]
        top = s["methods"].most_common(3)
        tool_rows.append({
            "tool": tool,
            "calls": s["count"],
            "threads": len(s["threads"]),
            "users": len(s["users"]),
            "methods_count": len(s["methods"]),
            "calls_per_thread": round(s["count"] / len(s["threads"]), 1),
            "method1": f"{top[0][0]} ({top[0][1]:,})" if len(top) > 0 else "",
            "method2": f"{top[1][0]} ({top[1][1]:,})" if len(top) > 1 else "",
            "method3": f"{top[2][0]} ({top[2][1]:,})" if len(top) > 2 else "",
            "first_seen": s["first"],
            "last_seen": s["last"],
            "first_url": _thread_to_slack_url(s["first_thread"] or ""),
            "last_url": _thread_to_slack_url(s["last_thread"] or ""),
            "icon": "centaur.png" if tool in INTERNAL_TOOLS else f"icons/{tool}.png",
        })

    # Build user rows
    user_rows = []
    for uid in sorted(user_stats, key=lambda u: user_stats[u]["count"], reverse=True):
        s = user_stats[uid]
        name_handle = USER_MAP.get(uid, ("Centaur", "\u2014") if uid == "unknown" else (uid, uid))
        name, handle = name_handle
        team = TEAM_MAP.get(uid, "Centaur" if uid == "unknown" else "Other")
        top = s["top_tools"].most_common(3)
        user_rows.append({
            "name": name,
            "handle": handle,
            "team": team,
            "team_emoji": TEAM_EMOJIS.get(team, ""),
            "calls": s["count"],
            "threads": len(s["threads"]),
            "tools": len(s["tools"]),
            "calls_per_thread": round(s["count"] / len(s["threads"]), 1),
            "tool1": f"{top[0][0]} ({top[0][1]:,})" if len(top) > 0 else "",
            "tool2": f"{top[1][0]} ({top[1][1]:,})" if len(top) > 1 else "",
            "tool3": f"{top[2][0]} ({top[2][1]:,})" if len(top) > 2 else "",
        })

    return tool_rows, user_rows


async def _extract_skills(pool, thread_users: dict[str, str]) -> list[dict]:
    rows = await pool.fetch(
        "SELECT e.thread_key, e.created_at, "
        "  elem->'input'->>'name' as skill_name "
        "FROM agent_execution_events e, "
        "  jsonb_array_elements(e.event_json->'message'->'content') elem "
        "WHERE e.event_kind = 'amp_raw_event' "
        "  AND e.event_json->>'type' = 'assistant' "
        "  AND elem->>'type' = 'tool_use' "
        "  AND elem->>'name' = 'skill' "
        "  AND elem->'input'->>'name' IS NOT NULL"
        "  AND e.created_at > NOW() - INTERVAL '90 days'"
    )

    skill_stats: dict[str, dict] = {}
    for row in rows:
        skill = row["skill_name"]
        uid = thread_users.get(row["thread_key"], "unknown")
        day = row["created_at"].strftime("%Y-%m-%d")
        if skill not in skill_stats:
            skill_stats[skill] = {
                "count": 0, "threads": set(), "users": Counter(),
                "first": "9999", "last": "0000",
                "first_thread": None, "last_thread": None,
            }
        s = skill_stats[skill]
        s["count"] += 1
        s["threads"].add(row["thread_key"])
        s["users"][uid] += 1
        if day < s["first"]:
            s["first"] = day
            s["first_thread"] = row["thread_key"]
        if day >= s["last"]:
            s["last"] = day
            s["last_thread"] = row["thread_key"]

    result = []
    for skill in sorted(skill_stats, key=lambda k: len(skill_stats[k]["threads"]), reverse=True):
        s = skill_stats[skill]
        top_users = s["users"].most_common(3)
        result.append({
            "skill": skill,
            "calls": s["count"],
            "threads": len(s["threads"]),
            "users": len(s["users"]),
            "calls_per_thread": round(s["count"] / len(s["threads"]), 1),
            "user1": _fmt_user(*top_users[0]) if len(top_users) > 0 else "",
            "user2": _fmt_user(*top_users[1]) if len(top_users) > 1 else "",
            "user3": _fmt_user(*top_users[2]) if len(top_users) > 2 else "",
            "first_seen": s["first"],
            "last_seen": s["last"],
            "first_url": _thread_to_slack_url(s["first_thread"] or ""),
            "last_url": _thread_to_slack_url(s["last_thread"] or ""),
            "emoji": SKILL_EMOJIS.get(skill, "\U0001F4AC"),
        })
    return result


def _build_teams(user_rows: list[dict]) -> list[dict]:
    teams: dict[str, dict] = {}
    for u in user_rows:
        t = u["team"]
        if t not in teams:
            teams[t] = {"calls": 0, "threads_sum": 0, "members": []}
        teams[t]["calls"] += u["calls"]
        teams[t]["threads_sum"] += u["threads"]
        teams[t]["members"].append(u["name"])

    result = []
    for name in sorted(teams, key=lambda k: teams[k]["calls"], reverse=True):
        t = teams[name]
        n = len(t["members"])
        result.append({
            "team": name,
            "members": n,
            "calls": t["calls"],
            "threads": t["threads_sum"],
            "calls_per_member": round(t["calls"] / n, 1) if n else 0,
            "threads_per_member": round(t["threads_sum"] / n, 1) if n else 0,
            "member_list": ", ".join(sorted(t["members"])),
            "emoji": TEAM_EMOJIS.get(name, ""),
        })
    return result


async def _extract_apps(pool) -> list[dict]:
    app_rows = await pool.fetch(
        "SELECT name, status FROM apps ORDER BY name"
    )
    app_status = {r["name"]: r["status"] for r in app_rows}

    app_stats: dict[str, dict] = defaultdict(
        lambda: {"views": 0, "requests": 0, "ips": set(), "errors": 0, "paths": Counter()}
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "http://victorialogs:9428/select/logsql/query",
                params={
                    "query": (
                        '_time:7d AND _msg:/apps/ AND _msg:"HTTP/1.1" AND NOT _msg:INFO'
                    ),
                    "limit": "10000",
                },
            )
            resp.raise_for_status()
            lines = resp.text.strip().split("\n")
            if len(lines) >= 10000:
                log.warning("VictoriaLogs returned 10000 rows (limit hit), app stats may be undercounted")
            for line in lines:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = d.get("_msg", "")
                app_m = re.search(r"/apps/([a-z0-9_-]+)(/[^\s?]*)?", msg)
                if not app_m:
                    continue
                app = app_m.group(1)
                subpath = app_m.group(2) or "/"
                ext = subpath.rsplit(".", 1)[-1] if "." in subpath else ""
                is_static = ext in STATIC_EXTS
                status_m = re.search(r'" (\d{3}) ', msg)
                status = int(status_m.group(1)) if status_m else 0
                ip_m = re.search(r'"(\d+\.\d+\.\d+\.\d+)"$', msg)
                ip = ip_m.group(1) if ip_m else ""

                s = app_stats[app]
                s["requests"] += 1
                if ip:
                    s["ips"].add(ip)
                if status >= 400:
                    s["errors"] += 1
                if status == 200 and not is_static and "GET" in msg:
                    s["views"] += 1
                    s["paths"][subpath] += 1
    except Exception:
        log.warning("failed to query VictoriaLogs for app traffic", exc_info=True)

    result = []
    for app in sorted(app_stats, key=lambda a: app_stats[a]["views"], reverse=True):
        s = app_stats[app]
        if s["views"] == 0 and s["requests"] < 3:
            continue
        top_paths = s["paths"].most_common(3)
        result.append({
            "app": app,
            "views": s["views"],
            "requests": s["requests"],
            "visitors": len(s["ips"]),
            "errors": s["errors"],
            "error_rate": round(s["errors"] / s["requests"] * 100, 1) if s["requests"] > 0 else 0,
            "status": app_status.get(app, "?"),
            "path1": f"{top_paths[0][0]} ({top_paths[0][1]})" if len(top_paths) > 0 else "",
            "path2": f"{top_paths[1][0]} ({top_paths[1][1]})" if len(top_paths) > 1 else "",
            "path3": f"{top_paths[2][0]} ({top_paths[2][1]})" if len(top_paths) > 2 else "",
            "emoji": APP_EMOJIS.get(app, "\U0001F4E6"),
        })
    return result


async def handler(_inp: dict[str, Any], ctx: WorkflowContext) -> dict[str, Any]:
    pool = ctx._pool

    thread_users = await ctx.step(
        "get_thread_users",
        lambda: _get_thread_users(pool),
        step_kind="gather",
    )

    tools_and_users = await ctx.step(
        "extract_tools_and_users",
        lambda: _extract_tools_and_users(pool, thread_users),
        step_kind="gather",
    )
    tools, users = tools_and_users

    skills = await ctx.step(
        "extract_skills",
        lambda: _extract_skills(pool, thread_users),
        step_kind="gather",
    )

    teams = await ctx.step(
        "build_teams",
        lambda: _build_teams(users),
        step_kind="transform",
    )

    apps = await ctx.step(
        "extract_apps",
        lambda: _extract_apps(pool),
        step_kind="gather",
    )

    data = {
        "tools": tools,
        "skills": skills,
        "users": users,
        "teams": teams,
        "apps": apps,
    }

    await ctx.step(
        "write_stats",
        lambda: pool.execute(
            "INSERT INTO usage_stats (id, data_json, generated_at) "
            "VALUES ('current', $1::jsonb, NOW()) "
            "ON CONFLICT (id) DO UPDATE SET data_json = $1::jsonb, generated_at = NOW()",
            json.dumps(data),
        ),
        step_kind="persist",
    )

    ctx.log(
        "usage_stats_generated",
        tools=len(tools),
        skills=len(skills),
        users=len(users),
        teams=len(teams),
        apps=len(apps),
    )

    return {
        "status": "ok",
        "tools": len(tools),
        "skills": len(skills),
        "users": len(users),
        "teams": len(teams),
        "apps": len(apps),
    }
