-- migrate:up

-- Persist in-flight turn payload so a container restart can replay the active turn.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS inflight_turn_id TEXT;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS inflight_turn_input JSONB;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS inflight_started_at TIMESTAMPTZ;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS inflight_attempts INTEGER NOT NULL DEFAULT 0;

-- Persist final turn result in DB (not process memory) for restart-safe status polling.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_result TEXT;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_result_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_inflight
    ON sandbox_sessions (inflight_started_at)
    WHERE inflight_turn_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_sandbox_sessions_inflight;

ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS last_result_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS last_result;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS inflight_attempts;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS inflight_started_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS inflight_turn_input;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS inflight_turn_id;
