-- migrate:up

CREATE TABLE IF NOT EXISTS company_context_documents (
    document_id        TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    source_type        TEXT NOT NULL,
    source_document_id TEXT NOT NULL,
    source_chunk_id    TEXT NOT NULL DEFAULT '',
    parent_document_id TEXT REFERENCES company_context_documents(document_id) ON DELETE CASCADE,
    title              TEXT NOT NULL DEFAULT '',
    body               TEXT NOT NULL DEFAULT '',
    url                TEXT NOT NULL DEFAULT '',
    author_id          TEXT NOT NULL DEFAULT '',
    author_name        TEXT NOT NULL DEFAULT '',
    access_scope       TEXT NOT NULL DEFAULT 'company',
    occurred_at        TIMESTAMPTZ,
    source_updated_at  TIMESTAMPTZ,
    content_hash       TEXT NOT NULL DEFAULT '',
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (source <> ''),
    CHECK (source_type <> ''),
    CHECK (source_document_id <> ''),
    UNIQUE (source, source_type, source_document_id, source_chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_company_context_documents_source_time
    ON company_context_documents (source, source_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_context_documents_parent
    ON company_context_documents (parent_document_id);

CREATE INDEX IF NOT EXISTS idx_company_context_documents_updated
    ON company_context_documents (source_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_context_documents_metadata
    ON company_context_documents USING GIN (metadata);

-- migrate:down

DROP INDEX IF EXISTS idx_company_context_documents_metadata;
DROP INDEX IF EXISTS idx_company_context_documents_updated;
DROP INDEX IF EXISTS idx_company_context_documents_parent;
DROP INDEX IF EXISTS idx_company_context_documents_source_time;
DROP TABLE IF EXISTS company_context_documents;
