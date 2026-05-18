-- migrate:up

CREATE TABLE IF NOT EXISTS usage_stats (
    id              TEXT PRIMARY KEY DEFAULT 'current',
    data_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 'current')
);

-- migrate:down

DROP TABLE IF EXISTS usage_stats;
