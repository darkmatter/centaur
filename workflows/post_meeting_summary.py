"""Workflow: Post-meeting summary drafter.

After a call ends, fetches the Granola note, generates a structured summary
with BLUF/takeaways/action items, and delivers for approval before posting
to #portfolio-gtm.

Ported from gtmskill's post-meeting flow.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "post_meeting_summary"


@dataclass
class Input:
    meeting_title: str = ""
    date: str = ""  # YYYY-MM-DD
    attendees: list[dict] = field(default_factory=list)
    company_hint: str = ""
    slack_channel: str = "portfolio-gtm"
    slack_user_id: str = ""  # who to send draft for approval
    granola_note_id: str = ""  # if known
    max_iterations: int = 1


SUMMARY_SYSTEM_PROMPT = """You are a post-meeting drafting agent for Paradigm.
You turn raw meeting notes into a structured JSON summary for internal circulation.

Return valid JSON matching this schema:
{
  "company": "string (counterparty org name, not attendee name)",
  "bluf": "string (one concrete sentence: most important outcome or metric)",
  "takeaways": ["I&R: ...", "I&R: ...", "GTK: ...", "GTK: ..."],
  "action_items": [{"description": "string", "owner": "string", "due_date": "string or null"}],
  "tags": ["string"],
  "sector": "string",
  "meeting_type": "string"
}

Rules:
- Use the counterparty organization as company, not the attendee name.
- Lead with a concrete BLUF containing the most important outcome or metric.
- Split takeaways into I&R (Interesting & Relevant — strategic insights) and GTK (Good To Know — context).
- Extract all real follow-ups into action_items.
- Use only the provided notes and evidence.
- Keep it concise and decision-useful.
- Valid sectors: robotics, drones, ai-infra, compute, foundation-models, applied-ai, crypto, defi, infrastructure, other
- Valid meeting_types: portfolio-checkin, customer-intro, regulatory, bd, internal, conference-talk, in-person"""


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Fetch meeting notes, generate summary, deliver for approval."""

    search_term = inp.company_hint or inp.meeting_title

    # Step 1: Fetch the meeting note from Granola
    fetch_prompt = f"""Find the meeting note for this call:

Title: {inp.meeting_title}
Date: {inp.date}
Attendees: {', '.join(a.get('name', '') for a in inp.attendees)}
{"Granola note ID: " + inp.granola_note_id if inp.granola_note_id else ""}

Search Granola for notes matching "{search_term}".
If you find a match, return the FULL notes markdown content.
Also search Slack for any prior context about "{search_term}" to help with the summary.

Return all the raw content you find — I need it for summarization."""

    note_data = await ctx.run_agent("fetch_note", text=fetch_prompt)
    note_text = note_data.get("result_text", "") if isinstance(note_data, dict) else str(note_data)

    # Step 2: Generate the structured summary
    summary_prompt = f"""{SUMMARY_SYSTEM_PROMPT}

Meeting Title: {inp.meeting_title}
Date: {inp.date}
Company Hint: {inp.company_hint or 'none'}

Attendees:
{chr(10).join(f"- {a.get('name', '?')} ({a.get('title', '?')} @ {a.get('company', '?')})" for a in inp.attendees)}

Meeting Notes and Context:
{note_text}

Return the MeetingSummary JSON only."""

    summary_result = await ctx.run_agent("generate_summary", text=summary_prompt)
    summary_text = summary_result.get("result_text", "") if isinstance(summary_result, dict) else str(summary_result)

    # Step 3: Format for Slack and deliver for approval
    format_prompt = f"""Format this meeting summary for posting to #portfolio-gtm on Slack.

Summary JSON:
{summary_text}

Format as:
Company Name
BLUF: [the bluf]

I&R:
- [each I&R takeaway without the prefix]

GTK:
- [each GTK takeaway without the prefix]

Next Steps:
- [each action item with owner and due date if available]

Tags: [comma separated]

Use plain text only. No markdown headers, no bold (**), no emojis.
Keep it tight — this goes to senior leadership.

{"Send it as a DM to user " + inp.slack_user_id + " for approval before posting to #" + inp.slack_channel + "." if inp.slack_user_id else "Return the formatted text."}"""

    delivery = await ctx.run_agent("format_and_deliver", text=format_prompt)

    return {
        "status": "draft_delivered",
        "meeting": inp.meeting_title,
        "company": inp.company_hint,
        "summary": summary_text,
        "formatted": delivery.get("result_text", "") if isinstance(delivery, dict) else str(delivery),
    }
