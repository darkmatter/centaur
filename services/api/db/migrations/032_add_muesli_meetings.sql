-- migrate:up

CREATE TABLE IF NOT EXISTS muesli_meetings (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL DEFAULT 'muesli',
    host            TEXT NOT NULL DEFAULT '',
    meeting_id      BIGINT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    duration_seconds DOUBLE PRECISION,
    word_count      INTEGER,
    raw_transcript  TEXT NOT NULL DEFAULT '',
    formatted_notes TEXT NOT NULL DEFAULT '',
    notes_state     TEXT NOT NULL DEFAULT '',
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    workflow_run_id TEXT,
    created_by_key  TEXT NOT NULL DEFAULT '',
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (host, meeting_id)
);

CREATE INDEX IF NOT EXISTS idx_muesli_meetings_started_at
    ON muesli_meetings (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_muesli_meetings_host
    ON muesli_meetings (host, started_at DESC);

-- migrate:down

DROP TABLE IF EXISTS muesli_meetings;
