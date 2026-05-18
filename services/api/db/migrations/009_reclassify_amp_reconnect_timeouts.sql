-- migrate:up

WITH corrected AS (
    UPDATE agent_execution_requests
    SET status = 'failed_permanent',
        terminal_reason = 'amp_reconnect_timeout',
        error_text = COALESCE(
            NULLIF(error_text, ''),
            NULLIF(result_text, ''),
            'Timed out while reconnecting. Please retry after reconnecting.'
        ),
        updated_at = NOW()
    WHERE status = 'completed'
      AND COALESCE(terminal_reason, 'completed') = 'completed'
      AND lower(COALESCE(result_text, '')) LIKE '%timed out while reconnecting%'
    RETURNING execution_id, thread_key, terminal_reason, result_text, error_text
)
INSERT INTO agent_execution_events (thread_key, execution_id, event_kind, event_json)
SELECT
    c.thread_key,
    c.execution_id,
    'execution_state',
    jsonb_build_object(
        'type', 'execution.state',
        'execution_id', c.execution_id,
        'thread_key', c.thread_key,
        'status', 'failed_permanent',
        'terminal_reason', c.terminal_reason,
        'result_text', COALESCE(c.result_text, ''),
        'error_text', COALESCE(c.error_text, '')
    )
FROM corrected c;

UPDATE agent_final_delivery_outbox o
SET final_payload = jsonb_build_object(
        'execution_id', e.execution_id,
        'thread_key', e.thread_key,
        'status', e.status,
        'terminal_reason', e.terminal_reason,
        'result_text', COALESCE(e.result_text, ''),
        'error_text', COALESCE(e.error_text, '')
    ),
    updated_at = NOW()
FROM agent_execution_requests e
WHERE o.execution_id = e.execution_id
  AND e.status = 'failed_permanent'
  AND e.terminal_reason = 'amp_reconnect_timeout';

-- migrate:down

-- Data correction migration; no automatic rollback.
