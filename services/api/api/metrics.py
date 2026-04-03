from __future__ import annotations

from asyncpg import Pool
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

HTTP_REQUESTS_TOTAL = Counter(
    "http_requests_total",
    "Total HTTP requests served by the API.",
    ["method", "path", "status"],
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds.",
    ["method", "path"],
)
HTTP_REQUESTS_IN_PROGRESS = Gauge(
    "http_requests_in_progress",
    "Number of in-flight HTTP requests.",
)

AGENT_SESSIONS_ACTIVE = Gauge(
    "agent_sessions_active",
    "Number of running sandbox sessions.",
)
AGENT_EXECUTIONS_TOTAL = Counter(
    "agent_executions_total",
    "Total completed agent executions.",
    ["harness", "status"],
)
AGENT_EXECUTION_DURATION_SECONDS = Histogram(
    "agent_execution_duration_seconds",
    "Agent execution duration in seconds.",
    ["harness", "status"],
)

# Tool call metrics
TOOL_CALLS_TOTAL = Counter(
    "agent_tool_calls_total",
    "Total tool calls by tool name and outcome.",
    ["tool_name", "tool_method", "success"],
)
TOOL_CALL_DURATION_SECONDS = Histogram(
    "agent_tool_call_duration_seconds",
    "Tool call latency in seconds.",
    ["tool_name", "tool_method"],
)

# Execution lifecycle metrics
EXECUTIONS_ENQUEUED_TOTAL = Counter(
    "agent_executions_enqueued_total",
    "Total executions enqueued.",
    ["harness"],
)
EXECUTIONS_CLAIMED_TOTAL = Counter(
    "agent_executions_claimed_total",
    "Total executions claimed by a worker.",
    ["harness"],
)
EXECUTION_QUEUE_DELAY_SECONDS = Histogram(
    "agent_execution_queue_delay_seconds",
    "Time from enqueue to claim in seconds.",
    ["harness"],
)
EXECUTION_WATCHDOG_TIMEOUTS_TOTAL = Counter(
    "agent_execution_watchdog_timeouts_total",
    "Execution watchdog timeouts.",
    ["harness", "reason"],
)
EXECUTION_REQUESTS_GAUGE = Gauge(
    "agent_execution_requests",
    "Current execution requests by status.",
    ["status"],
)

# Final delivery metrics
FINAL_DELIVERY_OUTBOX_GAUGE = Gauge(
    "agent_final_delivery_outbox",
    "Final delivery outbox items by state.",
    ["state"],
)

# Warm pool metrics
WARM_POOL_CONTAINERS = Gauge(
    "agent_warm_pool_containers",
    "Warm pool container counts.",
    ["state"],
)
WARM_POOL_CLAIMS_TOTAL = Counter(
    "agent_warm_pool_claims_total",
    "Warm pool claim outcomes.",
    ["outcome"],
)
EXECUTION_TERMINAL_TOTAL = Counter(
    "agent_execution_terminal_total",
    "Terminal execution outcomes by harness and reason.",
    ["harness", "status", "terminal_reason"],
)
MESSAGE_EVENTS_TOTAL = Counter(
    "agent_message_events_total",
    "Stored message events by role and whether attachments were present.",
    ["role", "has_attachments"],
)
MESSAGE_TEXT_CHARS = Histogram(
    "agent_message_text_chars",
    "Character count for stored message text.",
    ["role"],
)
MESSAGE_ATTACHMENTS_TOTAL = Counter(
    "agent_message_attachments_total",
    "Attachment references stored on messages.",
    ["role"],
)
USAGE_TOKENS_TOTAL = Counter(
    "agent_usage_tokens_total",
    "Observed model token usage by harness, model, and token category.",
    ["harness", "model", "token_type"],
)
USAGE_COST_USD_TOTAL = Counter(
    "agent_usage_cost_usd_total",
    "Observed model cost in USD by harness and model.",
    ["harness", "model"],
)


def observe_http_request(method: str, path: str, status: int, duration_s: float) -> None:
    HTTP_REQUESTS_TOTAL.labels(method=method, path=path, status=str(status)).inc()
    HTTP_REQUEST_DURATION_SECONDS.labels(method=method, path=path).observe(duration_s)


def record_agent_execution(harness: str, status: str, duration_s: float) -> None:
    AGENT_EXECUTIONS_TOTAL.labels(harness=harness, status=status).inc()
    AGENT_EXECUTION_DURATION_SECONDS.labels(harness=harness, status=status).observe(duration_s)


def record_execution_terminal(harness: str, status: str, terminal_reason: str) -> None:
    EXECUTION_TERMINAL_TOTAL.labels(
        harness=harness,
        status=status,
        terminal_reason=terminal_reason,
    ).inc()


def record_tool_call(tool_name: str, tool_method: str, success: bool, duration_s: float) -> None:
    TOOL_CALLS_TOTAL.labels(tool_name=tool_name, tool_method=tool_method, success=str(success).lower()).inc()
    TOOL_CALL_DURATION_SECONDS.labels(tool_name=tool_name, tool_method=tool_method).observe(duration_s)


def record_execution_enqueued(harness: str) -> None:
    EXECUTIONS_ENQUEUED_TOTAL.labels(harness=harness).inc()


def record_execution_claimed(harness: str, queue_delay_s: float) -> None:
    EXECUTIONS_CLAIMED_TOTAL.labels(harness=harness).inc()
    EXECUTION_QUEUE_DELAY_SECONDS.labels(harness=harness).observe(queue_delay_s)


def record_execution_watchdog_timeout(harness: str, reason: str) -> None:
    EXECUTION_WATCHDOG_TIMEOUTS_TOTAL.labels(harness=harness, reason=reason).inc()


def record_warm_pool_claim(outcome: str) -> None:
    WARM_POOL_CLAIMS_TOTAL.labels(outcome=outcome).inc()


def record_message_observation(role: str, text_chars: int, attachment_count: int) -> None:
    has_attachments = "true" if attachment_count > 0 else "false"
    MESSAGE_EVENTS_TOTAL.labels(role=role, has_attachments=has_attachments).inc()
    MESSAGE_TEXT_CHARS.labels(role=role).observe(max(text_chars, 0))
    if attachment_count > 0:
        MESSAGE_ATTACHMENTS_TOTAL.labels(role=role).inc(attachment_count)


def record_usage_observation(
    harness: str,
    model: str | None,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    cost_usd: float = 0.0,
) -> None:
    resolved_model = model or "unknown"
    token_values = {
        "input_tokens": max(input_tokens, 0),
        "output_tokens": max(output_tokens, 0),
        "cache_creation_input_tokens": max(cache_creation_input_tokens, 0),
        "cache_read_input_tokens": max(cache_read_input_tokens, 0),
    }
    for token_type, value in token_values.items():
        if value > 0:
            USAGE_TOKENS_TOTAL.labels(
                harness=harness,
                model=resolved_model,
                token_type=token_type,
            ).inc(value)
    if cost_usd > 0:
        USAGE_COST_USD_TOTAL.labels(harness=harness, model=resolved_model).inc(cost_usd)


async def refresh_runtime_metrics(pool: Pool) -> None:
    # Active sandbox sessions
    active_sessions = await pool.fetchval(
        "SELECT COUNT(*) FROM sandbox_sessions WHERE state = 'running'"
    )
    AGENT_SESSIONS_ACTIVE.set(int(active_sessions or 0))

    # Execution queue depth by status
    EXECUTION_REQUESTS_GAUGE._metrics.clear()
    rows = await pool.fetch(
        "SELECT status, COUNT(*) AS cnt FROM agent_execution_requests "
        "WHERE status IN ('queued', 'running', 'retry_wait', 'cancel_requested') "
        "GROUP BY status"
    )
    for row in rows:
        EXECUTION_REQUESTS_GAUGE.labels(status=row["status"]).set(row["cnt"])

    # Final delivery outbox backlog
    FINAL_DELIVERY_OUTBOX_GAUGE._metrics.clear()
    rows = await pool.fetch(
        "SELECT state, COUNT(*) AS cnt FROM agent_final_delivery_outbox "
        "WHERE state NOT IN ('delivered') "
        "GROUP BY state"
    )
    for row in rows:
        FINAL_DELIVERY_OUTBOX_GAUGE.labels(state=row["state"]).set(row["cnt"])


async def render_metrics(pool: Pool) -> bytes:
    await refresh_runtime_metrics(pool)
    return generate_latest()


__all__ = [
    "AGENT_EXECUTION_DURATION_SECONDS",
    "AGENT_EXECUTIONS_TOTAL",
    "AGENT_SESSIONS_ACTIVE",
    "CONTENT_TYPE_LATEST",
    "EXECUTION_TERMINAL_TOTAL",
    "EXECUTION_QUEUE_DELAY_SECONDS",
    "EXECUTION_REQUESTS_GAUGE",
    "EXECUTION_WATCHDOG_TIMEOUTS_TOTAL",
    "EXECUTIONS_CLAIMED_TOTAL",
    "EXECUTIONS_ENQUEUED_TOTAL",
    "FINAL_DELIVERY_OUTBOX_GAUGE",
    "HTTP_REQUESTS_IN_PROGRESS",
    "MESSAGE_ATTACHMENTS_TOTAL",
    "MESSAGE_EVENTS_TOTAL",
    "MESSAGE_TEXT_CHARS",
    "TOOL_CALL_DURATION_SECONDS",
    "TOOL_CALLS_TOTAL",
    "USAGE_COST_USD_TOTAL",
    "USAGE_TOKENS_TOTAL",
    "WARM_POOL_CLAIMS_TOTAL",
    "WARM_POOL_CONTAINERS",
    "observe_http_request",
    "record_agent_execution",
    "record_execution_claimed",
    "record_execution_enqueued",
    "record_execution_terminal",
    "record_execution_watchdog_timeout",
    "record_message_observation",
    "record_tool_call",
    "record_usage_observation",
    "record_warm_pool_claim",
    "render_metrics",
]
