-- migrate:up

ALTER TABLE agent_execution_requests
    ADD COLUMN IF NOT EXISTS worker_id TEXT,
    ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_execution_requests_worker_lease
    ON agent_execution_requests (status, worker_lease_expires_at)
    WHERE status IN ('running', 'cancel_requested', 'retry_wait');

-- migrate:down

DROP INDEX IF EXISTS idx_agent_execution_requests_worker_lease;

ALTER TABLE agent_execution_requests
    DROP COLUMN IF EXISTS worker_lease_expires_at,
    DROP COLUMN IF EXISTS worker_id;
