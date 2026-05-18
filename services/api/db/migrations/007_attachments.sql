-- migrate:up
CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    thread_key  TEXT NOT NULL,
    message_id  TEXT REFERENCES chat_messages(id),
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    data        BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_key);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- migrate:down
DROP INDEX IF EXISTS idx_attachments_message;
DROP INDEX IF EXISTS idx_attachments_thread;
DROP TABLE IF EXISTS attachments;
