"""Workflow: Pre-meeting brief generator.

30 minutes before an external call, gathers context from all available sources
(Granola, Slack, CRM, web, market data) and delivers a concise prep brief.

Ported from gtmskill's src/centaur/meeting-brief-*.ts
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "pre_meeting_brief"


@dataclass
class Input:
    meeting_title: str = ""
    start_at: str = ""  # ISO datetime
    timezone: str = "America/Los_Angeles"
    description: str = ""
    attendees: list[dict] = field(default_factory=list)
    # attendee shape: {name, email, company, title, internal}
    slack_channel: str = ""  # where to deliver the brief
    slack_user_id: str = ""  # who to DM
    company_hint: str = ""  # optional: skip inference
    max_iterations: int = 1


INTERNAL_DOMAINS = {"paradigm.xyz"}
PERSONAL_DOMAINS = {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "me.com", "protonmail.com"}

BRIEF_SYSTEM_PROMPT = """You are a pre-meeting briefing agent for Paradigm.
The source material was gathered through native Centaur tools, not a custom app.
Write a concise, high-signal prep brief for a busy investor or GTM lead.

Return valid JSON matching this shape exactly:
{"headline":"string","who_they_are":["string"],"why_now":["string"],"prior_context":["string"],"open_loops":["string"],"suggested_questions":["string"],"risks":["string"]}

Rules:
- Lead with the most decision-useful insight, not background.
- Prefer specific names, metrics, and dates over generic statements.
- Use only the provided evidence. Do not fabricate context.
- Keep each bullet to one line.
- If evidence is sparse, say so plainly and concentrate on what should be verified live in the meeting.
- Suggested questions should be things the user can actually ask in the meeting."""


def _email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    return email.split("@")[1].lower()


def _external_attendees(attendees: list[dict]) -> list[dict]:
    return [
        a for a in attendees
        if not a.get("internal")
        and (_email_domain(a.get("email")) or "") not in INTERNAL_DOMAINS
    ]


def _infer_hints(title: str, attendees: list[dict], description: str = "") -> dict:
    ext = _external_attendees(attendees)
    companies = []
    people = []
    domains = []

    for a in ext:
        if a.get("name"):
            people.append(a["name"])
        if a.get("company"):
            companies.append(a["company"])
        domain = _email_domain(a.get("email"))
        if domain and domain not in PERSONAL_DOMAINS and domain not in INTERNAL_DOMAINS:
            domains.append(domain)
            # Infer company from domain
            label = domain.split(".")[0].replace("-", " ").replace("_", " ").title()
            companies.append(label)

    # Extract fragments from title
    noise = {"paradigm", "meeting", "call", "sync", "intro", "catch up", "check in", "weekly", "monthly"}
    fragments = [f.strip() for f in title.replace("/", " ").replace("-", " ").split() if f.strip().lower() not in noise and len(f) >= 2]

    return {
        "companies": list(dict.fromkeys(companies)),  # dedupe preserving order
        "people": list(dict.fromkeys(people)),
        "domains": list(dict.fromkeys(domains)),
        "query_terms": list(dict.fromkeys(companies + people + fragments)),
    }


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Gather evidence from all sources and generate a pre-meeting brief."""

    hints = _infer_hints(inp.meeting_title, inp.attendees, inp.description)
    company = inp.company_hint or (hints["companies"][0] if hints["companies"] else "")
    person = hints["people"][0] if hints["people"] else ""
    search_term = company or person or inp.meeting_title
    web_query = f"{company} latest news partnerships funding" if company else f"{inp.meeting_title} latest news"

    # Step 1: Gather evidence from all sources in parallel via agent
    evidence_prompt = f"""You are gathering context for a pre-meeting brief.

Meeting: {inp.meeting_title}
Time: {inp.start_at} ({inp.timezone})
Company: {company or 'unknown'}
Attendees: {', '.join(a.get('name', '') for a in inp.attendees)}

Search for context using these tools. Execute ALL of them:

1. Search Granola for prior meeting notes about "{search_term}"
2. Search Slack messages for "{search_term}"
3. Search the web for "{web_query}"
4. If "{company}" looks like a crypto project, search CoinGecko for market context

For each source, return what you found in this format:

GRANOLA RESULTS:
[list what you found]

SLACK RESULTS:
[list what you found]

WEB RESULTS:
[list what you found]

MARKET DATA:
[list what you found]

Be thorough. Include dates, names, and specific facts."""

    evidence = await ctx.run_agent("gather_evidence", text=evidence_prompt)

    # Step 2: Generate the brief
    evidence_text = evidence.get("result_text", "") if isinstance(evidence, dict) else str(evidence)

    brief_prompt = f"""{BRIEF_SYSTEM_PROMPT}

Meeting Title: {inp.meeting_title}
Start Time: {inp.start_at}
Timezone: {inp.timezone}
Company: {company or 'unknown'}

Attendees:
{chr(10).join(f"- {a.get('name', '?')} ({a.get('title', '?')} @ {a.get('company', '?')})" for a in inp.attendees)}

Evidence gathered:
{evidence_text}

Produce the prep brief JSON now."""

    brief_result = await ctx.run_agent("generate_brief", text=brief_prompt)
    brief_text = brief_result.get("result_text", "") if isinstance(brief_result, dict) else str(brief_result)

    # Step 3: Format and deliver
    delivery_prompt = f"""Format this pre-meeting brief for Slack delivery. The brief JSON and context are below.

Meeting: {inp.meeting_title}
Company: {company or inp.meeting_title}
Time: {inp.start_at} ({inp.timezone})

Brief output:
{brief_text}

Format it as a clean, readable Slack message with these sections:
- Headline (one line)
- Who They Are (bullets)
- Why Now (bullets)
- Prior Context (bullets, skip if empty)
- Open Loops (bullets, skip if empty)
- Suggested Questions (numbered)
- Risks (bullets, skip if empty)

Use plain text only. No markdown headers, no bold (**), no emojis.
Keep it concise — this is a quick skim before the meeting.

{"Then send it to Slack user " + inp.slack_user_id + " as a DM." if inp.slack_user_id else "Return the formatted text."}"""

    delivery = await ctx.run_agent("deliver_brief", text=delivery_prompt)

    return {
        "status": "delivered",
        "meeting": inp.meeting_title,
        "company": company,
        "brief": brief_text,
        "delivery": delivery.get("result_text", "") if isinstance(delivery, dict) else str(delivery),
    }
