-- migrate:up

-- Resume support: persist upstream agent thread ID so old threads can be continued
-- after container GC/crash.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS agent_thread_id TEXT;

-- Reconciliation can move sessions to suspended when containers disappear or are GC'd.
ALTER TABLE sandbox_sessions DROP CONSTRAINT IF EXISTS sandbox_sessions_state_check;
ALTER TABLE sandbox_sessions ADD CONSTRAINT sandbox_sessions_state_check
    CHECK (state IN ('creating','running','idle','error','stopped','gone','delivering','suspended'));

-- migrate:down

ALTER TABLE sandbox_sessions DROP CONSTRAINT IF EXISTS sandbox_sessions_state_check;
ALTER TABLE sandbox_sessions ADD CONSTRAINT sandbox_sessions_state_check
    CHECK (state IN ('creating','running','idle','error','stopped','gone','delivering'));

ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS agent_thread_id;
