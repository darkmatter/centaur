-- migrate:up

ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS trace_id UUID;

UPDATE sandbox_sessions
SET trace_id = gen_random_uuid()
WHERE trace_id IS NULL;

ALTER TABLE sandbox_sessions
    ALTER COLUMN trace_id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN trace_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_sessions_trace_id
    ON sandbox_sessions (trace_id);

-- migrate:down

DROP INDEX IF EXISTS idx_sandbox_sessions_trace_id;
ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS trace_id;
