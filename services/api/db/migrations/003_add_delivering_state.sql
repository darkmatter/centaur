-- migrate:up

-- Add 'delivering' state for atomic delivery claims
ALTER TABLE sandbox_sessions DROP CONSTRAINT IF EXISTS sandbox_sessions_state_check;
ALTER TABLE sandbox_sessions ADD CONSTRAINT sandbox_sessions_state_check
    CHECK (state IN ('creating','running','idle','error','stopped','gone','delivering'));

-- migrate:down

ALTER TABLE sandbox_sessions DROP CONSTRAINT IF EXISTS sandbox_sessions_state_check;
ALTER TABLE sandbox_sessions ADD CONSTRAINT sandbox_sessions_state_check
    CHECK (state IN ('creating','running','idle','error','stopped','gone'));
