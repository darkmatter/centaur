-- migrate:up

-- Add columns if missing (idempotent for databases that already have the old schema)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_delivered_id TEXT;

-- Drop legacy columns from sandbox_sessions
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS channel_id;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS thread_ts;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS config_sent;

-- Ensure state check constraint is current
ALTER TABLE sandbox_sessions DROP CONSTRAINT IF EXISTS sandbox_sessions_state_check;
ALTER TABLE sandbox_sessions ADD CONSTRAINT sandbox_sessions_state_check
    CHECK (state IN ('creating','running','idle','error','stopped','gone'));

-- migrate:down

ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS thread_ts TEXT NOT NULL DEFAULT '';
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS config_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS last_delivered_id;
ALTER TABLE chat_messages DROP COLUMN IF EXISTS user_id;
