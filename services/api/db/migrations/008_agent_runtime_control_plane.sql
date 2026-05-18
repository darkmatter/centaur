-- migrate:up

CREATE TABLE IF NOT EXISTS agent_runtime_assignments (
    thread_key                  TEXT NOT NULL,
    assignment_generation       BIGINT NOT NULL,
    runtime_id                  TEXT NOT NULL,
    harness                     TEXT NOT NULL,
    engine                      TEXT NOT NULL,
    persona_id                  TEXT,
    prompt_ref                  TEXT,
    effective_agents_md_sha256  TEXT NOT NULL,
    state                       TEXT NOT NULL
                                CHECK (state IN ('active', 'released')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at                 TIMESTAMPTZ,
    PRIMARY KEY (thread_key, assignment_generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_assignments_active_thread
    ON agent_runtime_assignments (thread_key)
    WHERE state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_assignments_active_runtime
    ON agent_runtime_assignments (runtime_id)
    WHERE state = 'active';

CREATE TABLE IF NOT EXISTS agent_spawn_requests (
    thread_key      TEXT NOT NULL,
    spawn_id        TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_json   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_key, spawn_id)
);

CREATE TABLE IF NOT EXISTS agent_release_requests (
    thread_key      TEXT NOT NULL,
    release_id      TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_json   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_key, release_id)
);

CREATE TABLE IF NOT EXISTS agent_message_requests (
    thread_key              TEXT NOT NULL,
    message_id              TEXT NOT NULL,
    assignment_generation   BIGINT NOT NULL,
    request_hash            TEXT NOT NULL,
    event_json              JSONB NOT NULL,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivered_execution_id  TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_key, message_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_message_requests_thread_created
    ON agent_message_requests (thread_key, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_message_requests_undelivered
    ON agent_message_requests (thread_key, assignment_generation, created_at)
    WHERE delivered_execution_id IS NULL;

CREATE TABLE IF NOT EXISTS agent_execution_requests (
    execution_id         TEXT PRIMARY KEY,
    thread_key           TEXT NOT NULL,
    assignment_generation BIGINT NOT NULL,
    execute_id           TEXT NOT NULL,
    request_hash         TEXT NOT NULL,
    durable_turn_id      TEXT,
    status               TEXT NOT NULL
                         CHECK (status IN (
                            'queued',
                            'running',
                            'retry_wait',
                            'cancel_requested',
                            'completed',
                            'failed_permanent',
                            'cancelled'
                         )),
    delivery             JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at           TIMESTAMPTZ,
    started_at           TIMESTAMPTZ,
    last_progress_at     TIMESTAMPTZ,
    silence_deadline_at  TIMESTAMPTZ,
    hard_deadline_at     TIMESTAMPTZ,
    stream_break_count   INTEGER NOT NULL DEFAULT 0,
    last_stream_break_at TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    terminal_reason      TEXT,
    result_text          TEXT,
    result_json          JSONB,
    error_text           TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (thread_key, execute_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_requests_status_created
    ON agent_execution_requests (status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_execution_requests_thread_created
    ON agent_execution_requests (thread_key, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_execution_requests_watchdog
    ON agent_execution_requests (status, silence_deadline_at, hard_deadline_at)
    WHERE status IN ('queued', 'running', 'cancel_requested', 'retry_wait');

CREATE TABLE IF NOT EXISTS agent_execution_events (
    event_id       BIGSERIAL PRIMARY KEY,
    thread_key     TEXT NOT NULL,
    execution_id   TEXT,
    event_kind     TEXT NOT NULL,
    event_json     JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_events_thread
    ON agent_execution_events (thread_key, event_id);

CREATE INDEX IF NOT EXISTS idx_agent_execution_events_execution
    ON agent_execution_events (execution_id, event_id);

CREATE TABLE IF NOT EXISTS agent_final_delivery_outbox (
    execution_id   TEXT PRIMARY KEY,
    thread_key     TEXT NOT NULL,
    delivery       JSONB NOT NULL DEFAULT '{}'::jsonb,
    state          TEXT NOT NULL
                   CHECK (state IN (
                       'awaiting_terminal',
                       'pending',
                       'sending',
                       'retry_wait',
                       'delivered',
                       'dead_letter'
                   )),
    final_payload  JSONB,
    attempt_count  INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    lease_owner    TEXT,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_final_delivery_outbox_state
    ON agent_final_delivery_outbox (state, next_attempt_at);

-- migrate:down

DROP INDEX IF EXISTS idx_agent_final_delivery_outbox_state;
DROP TABLE IF EXISTS agent_final_delivery_outbox;

DROP INDEX IF EXISTS idx_agent_execution_events_execution;
DROP INDEX IF EXISTS idx_agent_execution_events_thread;
DROP TABLE IF EXISTS agent_execution_events;

DROP INDEX IF EXISTS idx_agent_execution_requests_watchdog;
DROP INDEX IF EXISTS idx_agent_execution_requests_thread_created;
DROP INDEX IF EXISTS idx_agent_execution_requests_status_created;
DROP TABLE IF EXISTS agent_execution_requests;

DROP INDEX IF EXISTS idx_agent_message_requests_undelivered;
DROP INDEX IF EXISTS idx_agent_message_requests_thread_created;
DROP TABLE IF EXISTS agent_message_requests;

DROP TABLE IF EXISTS agent_release_requests;
DROP TABLE IF EXISTS agent_spawn_requests;

DROP INDEX IF EXISTS idx_agent_runtime_assignments_active_runtime;
DROP INDEX IF EXISTS idx_agent_runtime_assignments_active_thread;
DROP TABLE IF EXISTS agent_runtime_assignments;
