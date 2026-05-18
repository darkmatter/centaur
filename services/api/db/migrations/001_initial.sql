-- migrate:up
CREATE TABLE IF NOT EXISTS sandbox_sessions (
    thread_key         TEXT PRIMARY KEY,
    sandbox_id         TEXT NOT NULL,
    harness            TEXT NOT NULL DEFAULT 'amp',
    engine             TEXT NOT NULL DEFAULT 'amp',
    state              TEXT NOT NULL DEFAULT 'creating'
                       CHECK (state IN ('creating','running','idle','error','stopped','gone')),
    last_delivered_id  TEXT,
    thread_name        TEXT,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          TEXT PRIMARY KEY,
    thread_key  TEXT NOT NULL,
    role        TEXT NOT NULL,
    user_id     TEXT,
    parts       JSONB NOT NULL DEFAULT '[]',
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
    ON chat_messages (thread_key, created_at);

CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    key_prefix  TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    scopes      TEXT[] NOT NULL DEFAULT '{"tools:*"}',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash
    ON api_keys (key_hash) WHERE revoked_at IS NULL;

-- migrate:down
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS sandbox_sessions;
