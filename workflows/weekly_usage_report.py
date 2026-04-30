"""Workflow: post weekly Centaur usage summary to #ai-agent."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "weekly_usage_report"
SCHEDULE = {
    "cron": "0 12 * * 5",
    "timezone": "America/Los_Angeles",
    "slack_channel": "ai-agent",
}

REPO = "https://github.com/paradigmxyz/centaur"
SKILL_DIR = Path("/app/.agents/skills")
WORKFLOW_DIR = Path("/app/workflows")
DASHBOARD_URL = "https://svc-ai.dayno.xyz/apps/usage"


def _load_skill_descs() -> dict[str, str]:
    descs: dict[str, str] = {}
    if not SKILL_DIR.is_dir():
        return descs
    for skill_md in SKILL_DIR.glob("*/SKILL.md"):
        name = skill_md.parent.name
        content = skill_md.read_text()
        m = re.search(r'description:\s*"?(.+?)"?\s*\n', content)
        if m:
            raw = m.group(1).strip().rstrip('"')
            desc = raw.split(". ")[0]
            if not desc.endswith("."):
                desc += "."
            descs[name] = desc
    return descs


def _load_workflow_descs() -> dict[str, str]:
    descs: dict[str, str] = {}
    if not WORKFLOW_DIR.is_dir():
        return descs
    for wf_file in WORKFLOW_DIR.glob("*.py"):
        if wf_file.name.startswith("_"):
            continue
        content = wf_file.read_text()
        m = re.search(r'"""(.+?)"""', content, re.DOTALL)
        if m:
            raw = m.group(1).strip()
            raw = re.sub(r"^Workflow:\s*", "", raw)
            desc = raw.split(". ")[0].split("\n")[0]
            if not desc.endswith("."):
                desc += "."
            descs[wf_file.stem] = desc
    return descs


def _cell(text: Any) -> dict:
    t = str(text) if str(text) != "" else "\u2014"
    return {"type": "raw_text", "text": t}


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _build_blocks(
    stats: dict,
    new_apps: list[dict],
    skill_descs: dict[str, str],
    workflow_descs: dict[str, str],
) -> list[dict]:
    wall = stats["windows"]["all"]
    w7 = stats["windows"]["7d"]
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)).strftime("%Y-%m-%d")

    all_skills_first = {s["skill"]: s["first_seen"] for s in wall.get("skills", [])}
    all_wf_first = {w["workflow"]: w["first_seen"] for w in wall.get("workflows", [])}
    new_skills = sorted(
        [s for s in w7.get("skills", []) if all_skills_first.get(s["skill"], "") >= cutoff],
        key=lambda x: x["calls"], reverse=True,
    )
    new_workflows = sorted(
        [w for w in w7.get("workflows", []) if all_wf_first.get(w["workflow"], "") >= cutoff],
        key=lambda x: x["total"], reverse=True,
    )

    teams_raw = [t for t in w7.get("teams", []) if t["team"] != "Centaur Internal"]
    users = sorted(
        [u for u in w7.get("users", []) if u.get("team") != "Other" and u["name"] != "Centaur Internal"],
        key=lambda u: (u["threads"], u.get("tokens", 0)), reverse=True,
    )

    blocks: list[dict] = []

    blocks.append({"type": "header", "text": {
        "type": "plain_text",
        "text": f":centaur: Weekly Centaur Usage Summary {today} :centaur:",
        "emoji": True,
    }})
    blocks.append({"type": "divider"})

    # New features: Apps, Workflows, Skills
    all_features: list[tuple[str, str, str]] = []
    for a in new_apps:
        all_features.append(("New App", a["name"], a.get("desc", "\u2014")))
    for w in new_workflows:
        desc = workflow_descs.get(w["workflow"], "\u2014")
        all_features.append(("New Workflow", w["workflow"], desc))
    for s in new_skills:
        desc = skill_descs.get(s["skill"], "\u2014")
        all_features.append(("New Skill", s["skill"], desc))

    if all_features:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*New Centaur Features* :ship_it_parrot:"}})
        feat_rows = [[_cell("Type"), _cell("Name"), _cell("Description")]]
        for ftype, name, desc in all_features:
            feat_rows.append([_cell(ftype), _cell(name), _cell(desc)])
        blocks.append({
            "type": "table",
            "column_settings": [{"align": "left"}, {"align": "left"}, {"align": "left", "is_wrapped": True}],
            "rows": feat_rows,
        })
        blocks.append({"type": "divider"})

    # Teams table — compute metrics, then sort by (S/M, T/M)
    team_data = []
    for t in teams_raw:
        members = t["members"]
        sessions = t["threads"]
        tokens = sum(u.get("tokens", 0) for u in users if u["team"] == t["team"])
        spm = round(sessions / members, 1) if members > 0 else 0
        tpm_raw = round(tokens / members) if members > 0 else 0
        team_data.append({"t": t, "members": members, "sessions": sessions, "tokens": tokens, "spm": spm, "tpm_raw": tpm_raw})
    team_data.sort(key=lambda x: (x["spm"], x["tpm_raw"]), reverse=True)

    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Top Centaur Usage by Team* :celebrate:"}})
    team_rows = [[_cell("#"), _cell("Team"), _cell("Members"), _cell("Sessions"), _cell("Tokens"), _cell("S/M"), _cell("T/M")]]
    for i, td in enumerate(team_data):
        t = td["t"]
        emoji = t.get("emoji", "")
        team_rows.append([_cell(i + 1), _cell(f"{emoji} {t['team']}"), _cell(td["members"]), _cell(td["sessions"]), _cell(_fmt_tokens(td["tokens"])), _cell(td["spm"]), _cell(_fmt_tokens(td["tpm_raw"]))])
    blocks.append({
        "type": "table",
        "column_settings": [{"align": "center"}, {"align": "left"}, {"align": "right"}, {"align": "right"}, {"align": "right"}, {"align": "right"}, {"align": "right"}],
        "rows": team_rows,
    })
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"<{DASHBOARD_URL}/teams|See live team leaderboard>"}]})
    blocks.append({"type": "divider"})

    # Users table
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Top Centaur Usage by User* :catjam:"}})
    user_rows = [[_cell("#"), _cell("User"), _cell("Team"), _cell("Sessions"), _cell("Tokens")]]
    for i, u in enumerate(users):
        user_rows.append([_cell(i + 1), _cell(u["name"]), _cell(u["team"]), _cell(u["threads"]), _cell(_fmt_tokens(u.get("tokens", 0)))])
    blocks.append({
        "type": "table",
        "column_settings": [{"align": "center"}, {"align": "left"}, {"align": "left"}, {"align": "right"}, {"align": "right"}],
        "rows": user_rows,
    })
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"<{DASHBOARD_URL}/users|See live user leaderboard>"}]})

    return blocks


async def handler(_inp: dict[str, Any], ctx: WorkflowContext) -> dict[str, Any]:
    pool = ctx._pool

    # Fetch usage stats
    stats = await ctx.step("fetch_stats", lambda: _fetch_stats(pool), step_kind="gather")

    # Fetch new apps (created in last 7 days)
    new_apps = await ctx.step("fetch_new_apps", lambda: _fetch_new_apps(pool), step_kind="gather")

    # Load descriptions from filesystem
    skill_descs = _load_skill_descs()
    workflow_descs = _load_workflow_descs()

    blocks = _build_blocks(stats, new_apps, skill_descs, workflow_descs)

    await ctx.call_tool("slack", "send_message", {
        "channel": "ai-agent",
        "text": ":centaur: Weekly Centaur Usage Summary :centaur:",
        "blocks": blocks,
        "no_attribution": True,
    })

    return {"status": "ok", "features": len(blocks)}


async def _fetch_stats(pool) -> dict:
    row = await pool.fetchrow(
        "SELECT data_json FROM usage_stats WHERE id = 'current'"
    )
    if not row:
        return {"windows": {"7d": {}, "all": {}}}
    data = row["data_json"]
    if isinstance(data, str):
        data = json.loads(data)
    return data


async def _fetch_new_apps(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT name, repo_url FROM apps "
        "WHERE created_at > NOW() - INTERVAL '7 days' "
        "ORDER BY created_at"
    )
    result = []
    for r in rows:
        repo = r["repo_url"] or ""
        if not repo.startswith("http"):
            repo = f"https://github.com/{repo}" if "/" in repo else ""
        result.append({"name": r["name"], "url": repo, "desc": "\u2014"})
    return result


