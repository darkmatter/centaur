-- migrate:up

CREATE TABLE IF NOT EXISTS thread_traces (
    thread_key  TEXT PRIMARY KEY,
    trace_id    UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO thread_traces (thread_key, trace_id)
SELECT thread_key, trace_id
FROM sandbox_sessions
WHERE trace_id IS NOT NULL
ON CONFLICT (thread_key) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_traces_trace_id
    ON thread_traces (trace_id);

-- migrate:down

DROP INDEX IF EXISTS idx_thread_traces_trace_id;
DROP TABLE IF EXISTS thread_traces;
