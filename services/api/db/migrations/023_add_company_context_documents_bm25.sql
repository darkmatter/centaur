-- migrate:up

CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE INDEX IF NOT EXISTS idx_company_context_documents_bm25
    ON company_context_documents
    USING bm25 (
        document_id,
        title,
        body,
        source,
        source_type,
        access_scope,
        occurred_at,
        source_updated_at,
        metadata
    )
    WITH (
        key_field = 'document_id',
        text_fields = '{
            "document_id": {
                "tokenizer": {"type": "keyword"}
            }
        }'
    );

-- migrate:down

DROP INDEX IF EXISTS idx_company_context_documents_bm25;
