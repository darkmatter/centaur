-- migrate:up

CREATE TABLE IF NOT EXISTS apps (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    repo_url            TEXT NOT NULL,
    container_id        TEXT,
    status              TEXT NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building', 'running', 'stopped', 'failed')),
    port                INTEGER NOT NULL DEFAULT 3000,
    basic_auth_user     TEXT,
    basic_auth_pass_hash TEXT,
    env_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
    build_cmd           TEXT,
    start_cmd           TEXT,
    created_by          TEXT,
    build_log           TEXT,
    error_text          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE apps
    ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS repo_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS container_id TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'building',
    ADD COLUMN IF NOT EXISTS port INTEGER NOT NULL DEFAULT 3000,
    ADD COLUMN IF NOT EXISTS basic_auth_user TEXT,
    ADD COLUMN IF NOT EXISTS basic_auth_pass_hash TEXT,
    ADD COLUMN IF NOT EXISTS env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS build_cmd TEXT,
    ADD COLUMN IF NOT EXISTS start_cmd TEXT,
    ADD COLUMN IF NOT EXISTS created_by TEXT,
    ADD COLUMN IF NOT EXISTS build_log TEXT,
    ADD COLUMN IF NOT EXISTS error_text TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS apps_status_idx ON apps (status);
CREATE INDEX IF NOT EXISTS apps_name_idx ON apps (name);

-- migrate:down

DROP INDEX IF EXISTS apps_name_idx;
DROP INDEX IF EXISTS apps_status_idx;
DROP TABLE IF EXISTS apps;
