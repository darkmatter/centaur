-- migrate:up

CREATE TABLE IF NOT EXISTS slack_sync_channels (
    channel_id      TEXT PRIMARY KEY,
    channel_name    TEXT NOT NULL DEFAULT '',
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    is_member       BOOLEAN NOT NULL DEFAULT FALSE,
    topic           TEXT NOT NULL DEFAULT '',
    purpose         TEXT NOT NULL DEFAULT '',
    member_count    INTEGER NOT NULL DEFAULT 0,
    raw_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_sync_channels_member
    ON slack_sync_channels (is_member, channel_name);

CREATE TABLE IF NOT EXISTS slack_sync_users (
    user_id       TEXT PRIMARY KEY,
    user_name     TEXT NOT NULL DEFAULT '',
    real_name     TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    is_bot        BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
    team_id       TEXT NOT NULL DEFAULT '',
    raw_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_sync_users_real_name
    ON slack_sync_users (real_name);

CREATE TABLE IF NOT EXISTS slack_sync_runs (
    run_id             TEXT PRIMARY KEY,
    workflow_run_id    TEXT,
    mode               TEXT NOT NULL DEFAULT 'incremental',
    status             TEXT NOT NULL,
    channels_requested JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_synced    JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_skipped   JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_failed    JSONB NOT NULL DEFAULT '[]'::jsonb,
    messages_fetched   INTEGER NOT NULL DEFAULT 0,
    messages_upserted  INTEGER NOT NULL DEFAULT 0,
    threads_fetched    INTEGER NOT NULL DEFAULT 0,
    replies_fetched    INTEGER NOT NULL DEFAULT 0,
    replies_upserted   INTEGER NOT NULL DEFAULT 0,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ,
    error_text         TEXT NOT NULL DEFAULT '',
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_slack_sync_runs_started
    ON slack_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS slack_sync_messages (
    channel_id        TEXT NOT NULL REFERENCES slack_sync_channels(channel_id) ON DELETE CASCADE,
    message_ts        TEXT NOT NULL,
    occurred_at       TIMESTAMPTZ,
    thread_ts         TEXT,
    parent_message_ts TEXT,
    is_thread_root    BOOLEAN NOT NULL DEFAULT FALSE,
    user_id           TEXT NOT NULL DEFAULT '',
    bot_id            TEXT NOT NULL DEFAULT '',
    message_type      TEXT NOT NULL DEFAULT 'message',
    message_subtype   TEXT,
    text              TEXT NOT NULL DEFAULT '',
    permalink         TEXT NOT NULL DEFAULT '',
    reply_count       INTEGER NOT NULL DEFAULT 0,
    reply_users       JSONB NOT NULL DEFAULT '[]'::jsonb,
    latest_reply_ts   TEXT,
    raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_run_id     TEXT REFERENCES slack_sync_runs(run_id) ON DELETE SET NULL,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, message_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_sync_messages_thread
    ON slack_sync_messages (channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS idx_slack_sync_messages_occurred
    ON slack_sync_messages (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_sync_messages_user
    ON slack_sync_messages (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_sync_messages_text
    ON slack_sync_messages
    USING GIN (to_tsvector('english', coalesce(text, '')));

CREATE TABLE IF NOT EXISTS slack_sync_checkpoints (
    channel_id            TEXT PRIMARY KEY REFERENCES slack_sync_channels(channel_id) ON DELETE CASCADE,
    cursor                TEXT,
    watermark_ts          TEXT,
    oldest_ts             TEXT,
    latest_ts             TEXT,
    lookback_days         INTEGER NOT NULL DEFAULT 30,
    thread_lookback_days  INTEGER NOT NULL DEFAULT 3,
    last_run_id           TEXT REFERENCES slack_sync_runs(run_id) ON DELETE SET NULL,
    last_success_at       TIMESTAMPTZ,
    last_error            TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migrate:down

DROP TABLE IF EXISTS slack_sync_checkpoints;
DROP INDEX IF EXISTS idx_slack_sync_messages_text;
DROP INDEX IF EXISTS idx_slack_sync_messages_user;
DROP INDEX IF EXISTS idx_slack_sync_messages_occurred;
DROP INDEX IF EXISTS idx_slack_sync_messages_thread;
DROP TABLE IF EXISTS slack_sync_messages;
DROP INDEX IF EXISTS idx_slack_sync_runs_started;
DROP TABLE IF EXISTS slack_sync_runs;
DROP INDEX IF EXISTS idx_slack_sync_users_real_name;
DROP TABLE IF EXISTS slack_sync_users;
DROP INDEX IF EXISTS idx_slack_sync_channels_member;
DROP TABLE IF EXISTS slack_sync_channels;
