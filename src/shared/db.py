from __future__ import annotations

from typing import Any

import asyncpg
import structlog

log = structlog.get_logger()


async def create_pool(database_url: str) -> asyncpg.Pool:
    pool = await asyncpg.create_pool(
        database_url,
        min_size=2,
        max_size=10,
        command_timeout=60,
    )
    assert pool is not None
    await _ensure_schema(pool)
    return pool


async def close_pool(pool: asyncpg.Pool) -> None:
    await pool.close()


async def execute(pool: asyncpg.Pool, query: str, *args: Any) -> str:
    return await pool.execute(query, *args)


async def fetch(pool: asyncpg.Pool, query: str, *args: Any) -> list[asyncpg.Record]:
    return await pool.fetch(query, *args)


async def fetchrow(pool: asyncpg.Pool, query: str, *args: Any) -> asyncpg.Record | None:
    return await pool.fetchrow(query, *args)


async def _ensure_schema(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS raw_records (
                source       TEXT NOT NULL,
                kind         TEXT NOT NULL,
                external_id  TEXT NOT NULL,
                fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                content_hash TEXT NOT NULL,
                data         JSONB NOT NULL,
                PRIMARY KEY (source, kind, external_id, content_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_raw_lookup
                ON raw_records (source, kind, external_id, fetched_at);
            CREATE INDEX IF NOT EXISTS idx_raw_by_time
                ON raw_records (source, kind, fetched_at);
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_cursors (
                cursor_key TEXT PRIMARY KEY,
                source     TEXT NOT NULL,
                kind       TEXT NOT NULL,
                entity_id  TEXT,
                cursor     TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_sync_cursors_source
                ON sync_cursors (source, kind, entity_id);
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS people (
                slug            TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                email           TEXT,
                role            TEXT,
                is_direct_report BOOLEAN NOT NULL DEFAULT false,
                focus_area      TEXT
            );
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS entity_mappings (
                source      TEXT NOT NULL,
                external_id TEXT NOT NULL,
                person_slug TEXT NOT NULL REFERENCES people(slug),
                PRIMARY KEY (source, external_id)
            );
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS embeddings (
                id         BIGSERIAL PRIMARY KEY,
                source     TEXT NOT NULL,
                kind       TEXT NOT NULL,
                source_id  TEXT NOT NULL,
                content    TEXT NOT NULL,
                embedding  vector(1536),
                metadata   JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                tsv        tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', content)
                ) STORED,
                UNIQUE (source, kind, source_id)
            );
            CREATE INDEX IF NOT EXISTS idx_embeddings_vec
                ON embeddings USING ivfflat (embedding vector_cosine_ops)
                WITH (lists = 100);
            CREATE INDEX IF NOT EXISTS idx_embeddings_tsv
                ON embeddings USING gin (tsv);
            CREATE INDEX IF NOT EXISTS idx_embeddings_source
                ON embeddings (source, kind);
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_runs (
                id              BIGSERIAL PRIMARY KEY,
                source          TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'pending',
                started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                finished_at     TIMESTAMPTZ,
                records_synced  INT NOT NULL DEFAULT 0,
                error_message   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_runs_source
                ON sync_runs (source, started_at DESC);
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS secrets (
                key          TEXT PRIMARY KEY,
                value        TEXT NOT NULL,
                source       TEXT,
                description  TEXT,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_sessions (
                slack_thread_key TEXT PRIMARY KEY,
                container_id     TEXT NOT NULL,
                harness          TEXT NOT NULL DEFAULT 'amp',
                agent_thread_id  TEXT,
                state            TEXT NOT NULL DEFAULT 'running',
                repo             TEXT,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_activity    TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )
        await conn.execute(
            "ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS thread_name TEXT"
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_turns (
                id               BIGSERIAL PRIMARY KEY,
                slack_thread_key TEXT NOT NULL REFERENCES agent_sessions(slack_thread_key)
                                     ON DELETE CASCADE,
                turn_id          INT NOT NULL,
                user_message     TEXT NOT NULL,
                events           JSONB NOT NULL DEFAULT '[]',
                result           TEXT NOT NULL DEFAULT '',
                started_at       TIMESTAMPTZ NOT NULL,
                finished_at      TIMESTAMPTZ,
                exit_code        INT,
                timed_out        BOOLEAN NOT NULL DEFAULT false,
                duration_s       REAL NOT NULL DEFAULT 0,
                UNIQUE (slack_thread_key, turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_turns_thread
                ON agent_turns (slack_thread_key, turn_id);
            """
        )
        await conn.execute(
            "ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS artifacts JSONB NOT NULL DEFAULT '[]'"
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS thread_events_ledger (
                event_id           TEXT PRIMARY KEY,
                slack_thread_key   TEXT NOT NULL,
                source             TEXT NOT NULL,
                event_type         TEXT NOT NULL,
                event_seq          BIGINT NOT NULL,
                occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                payload            JSONB NOT NULL DEFAULT '{}'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_events_ledger_thread_seq
                ON thread_events_ledger (slack_thread_key, event_seq);
            CREATE INDEX IF NOT EXISTS idx_thread_events_ledger_thread_time
                ON thread_events_ledger (slack_thread_key, occurred_at DESC);
            """
        )
    log.info("schema_ensured")
