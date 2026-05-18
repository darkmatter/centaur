-- migrate:up

-- Wire health tracking (separate from sandbox lifecycle state)
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS wire_lease_id TEXT;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS wire_connected_at TIMESTAMPTZ;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS wire_last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_wire
    ON sandbox_sessions (wire_lease_id) WHERE wire_lease_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_sandbox_sessions_wire;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS wire_last_seen_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS wire_connected_at;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS wire_lease_id;
