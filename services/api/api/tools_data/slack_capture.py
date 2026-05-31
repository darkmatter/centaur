"""Live Slack-send capture, owned by the API service.

When a sandbox agent is running with Slackbot live delivery, a Slack message it
sends into its **own** live thread should fold into the in-progress Slackbot
reply rather than post a separate duplicate message. This module holds that
decision + the session hand-off; it is reached two ways:

- the local ``slack`` tool pre-calls ``POST /agent/tools-data/slack/capture``
  before posting (the path after the tool-CLI cutover); and
- ``api.tool_manager`` calls it inline for the in-process tool path.

Both supply the agent's ``thread_key`` and the requested channel/thread_ts/text.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from api import slackbot_client

log = structlog.get_logger()

_CHANNEL_ID_RE = re.compile(r"^[CDG][A-Z0-9]+$")


async def capture_live_slack_send(
    pool: Any,
    *,
    thread_key: str,
    channel: str,
    thread_ts: str,
    text: str,
) -> dict[str, Any] | None:
    """Fold a Slack send into the active Slackbot live reply, if applicable.

    Returns the capture envelope when the send was captured (caller posts
    nothing), or ``None`` when the caller should post to Slack normally.
    """
    if pool is None or not thread_key:
        return None

    parts = thread_key.split(":")
    if len(parts) < 4 or parts[0] != "slack":
        return None
    active_channel = parts[2]
    active_thread_ts = parts[3]

    requested_channel = str(channel or "").lstrip("#")
    requested_thread_ts = str(thread_ts or "")
    channel_is_id = bool(_CHANNEL_ID_RE.match(requested_channel))
    if channel_is_id and requested_channel != active_channel:
        return None
    if requested_thread_ts and requested_thread_ts != active_thread_ts:
        return None

    text = str(text or "").strip()
    if not text:
        return None

    session_id = await pool.fetchval(
        "SELECT metadata->>'slackbot_agent_session_id' "
        "FROM agent_execution_requests "
        "WHERE thread_key = $1 "
        "AND status = 'running' "
        "AND ("
        "  metadata->>'slackbot_live_delivery' = 'true' "
        "  OR metadata->>('slackbot' || '_v' || '2_live_delivery') = 'true'"
        ") "
        "AND COALESCE(metadata->>'slackbot_agent_session_id', '') <> '' "
        "ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT 1",
        thread_key,
    )
    session_id = str(session_id or "").strip()
    if not session_id:
        return None

    await slackbot_client.session_text(session_id, text)
    log.info(
        "slack_send_message_captured",
        thread_key=thread_key,
        slackbot_agent_session_id=session_id,
    )
    return {
        "captured": True,
        "message": (
            "Captured into the active Slackbot live reply; no separate Slack "
            "message was posted."
        ),
        "channel": active_channel,
        "thread_ts": active_thread_ts,
    }
