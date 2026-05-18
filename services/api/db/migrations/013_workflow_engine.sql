-- migrate:up

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id              TEXT PRIMARY KEY,
    workflow_name       TEXT NOT NULL,
    workflow_version    TEXT NOT NULL,
    workflow_source_path TEXT,
    request_hash        TEXT NOT NULL,
    trigger_key         TEXT,
    parent_run_id       TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
    root_run_id         TEXT NOT NULL,
    thread_key          TEXT,
    status              TEXT NOT NULL
                        CHECK (status IN ('queued', 'running', 'sleeping', 'waiting', 'completed', 'failed', 'cancelled')),
    input_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_json         JSONB,
    error_text          TEXT,
    available_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    worker_id           TEXT,
    worker_lease_expires_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workflow_runs
    ADD COLUMN IF NOT EXISTS workflow_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workflow_version TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workflow_source_path TEXT,
    ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS trigger_key TEXT,
    ADD COLUMN IF NOT EXISTS parent_run_id TEXT,
    ADD COLUMN IF NOT EXISTS root_run_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS thread_key TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS output_json JSONB,
    ADD COLUMN IF NOT EXISTS error_text TEXT,
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS worker_id TEXT,
    ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_trigger_key_idx
    ON workflow_runs (workflow_name, trigger_key)
    WHERE trigger_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_runs_status_created_idx
    ON workflow_runs (status, created_at);

CREATE INDEX IF NOT EXISTS workflow_runs_claim_idx
    ON workflow_runs (status, available_at, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx
    ON workflow_runs (parent_run_id, created_at);

CREATE INDEX IF NOT EXISTS workflow_runs_root_idx
    ON workflow_runs (root_run_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
    run_id              TEXT NOT NULL REFERENCES workflow_runs (run_id) ON DELETE CASCADE,
    checkpoint_name     TEXT NOT NULL,
    step_kind           TEXT,
    state               JSONB,
    execution_id        TEXT,
    child_run_id        TEXT REFERENCES workflow_runs (run_id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, checkpoint_name)
);

ALTER TABLE workflow_checkpoints
    ADD COLUMN IF NOT EXISTS step_kind TEXT,
    ADD COLUMN IF NOT EXISTS state JSONB,
    ADD COLUMN IF NOT EXISTS execution_id TEXT,
    ADD COLUMN IF NOT EXISTS child_run_id TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS workflow_checkpoints_execution_id_idx
    ON workflow_checkpoints (execution_id)
    WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_checkpoints_child_run_id_idx
    ON workflow_checkpoints (child_run_id)
    WHERE child_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_schedules (
    schedule_id         TEXT PRIMARY KEY,
    workflow_name       TEXT NOT NULL,
    schedule_kind       TEXT NOT NULL
                        CHECK (schedule_kind IN ('cron', 'interval')),
    schedule_expr       TEXT,
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    interval_seconds    INTEGER,
    catchup_policy      TEXT NOT NULL DEFAULT 'skip'
                        CHECK (catchup_policy IN ('skip', 'all')),
    input_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at         TIMESTAMPTZ NOT NULL,
    last_run_at         TIMESTAMPTZ,
    last_trigger_key    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (schedule_kind = 'cron' AND schedule_expr IS NOT NULL AND interval_seconds IS NULL)
        OR
        (schedule_kind = 'interval' AND schedule_expr IS NULL AND interval_seconds IS NOT NULL AND interval_seconds > 0)
    )
);

ALTER TABLE workflow_schedules
    ADD COLUMN IF NOT EXISTS workflow_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS schedule_kind TEXT NOT NULL DEFAULT 'cron',
    ADD COLUMN IF NOT EXISTS schedule_expr TEXT,
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS interval_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS catchup_policy TEXT NOT NULL DEFAULT 'skip',
    ADD COLUMN IF NOT EXISTS input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_trigger_key TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
    ON workflow_schedules (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS workflow_events (
    event_type          TEXT NOT NULL,
    correlation_id      TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_type, correlation_id)
);

ALTER TABLE workflow_events
    ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- migrate:down

DROP TABLE IF EXISTS workflow_events;

DROP INDEX IF EXISTS workflow_schedules_due_idx;
DROP TABLE IF EXISTS workflow_schedules;

DROP INDEX IF EXISTS workflow_checkpoints_child_run_id_idx;
DROP INDEX IF EXISTS workflow_checkpoints_execution_id_idx;
DROP TABLE IF EXISTS workflow_checkpoints;

DROP INDEX IF EXISTS workflow_runs_root_idx;
DROP INDEX IF EXISTS workflow_runs_parent_idx;
DROP INDEX IF EXISTS workflow_runs_claim_idx;
DROP INDEX IF EXISTS workflow_runs_status_created_idx;
DROP INDEX IF EXISTS workflow_runs_trigger_key_idx;
DROP TABLE IF EXISTS workflow_runs;
