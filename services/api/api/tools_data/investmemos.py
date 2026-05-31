"""SQL query functions for investmemos data, owned by the API service.

The ``investmemos`` tool runs in the sandbox, which has no route to the core DB,
so it reaches this data over HTTP through ``routers/tools_data.py``. These
functions are the sole DB-query path: the router runs them on
``request.app.state.db_pool`` (which exposes ``.fetch``/``.fetchrow``).

They take a connection-like ``conn`` argument rather than opening their own. The
grouping/ranking runs here (one source); the router resolves source/kind defaults
and re-clamps ``limit``/``max_chars`` because the sandbox is a hostile boundary.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

DEFAULT_MEMO_SOURCE = "invest_memo_corpus"
DEFAULT_MEMO_KIND = "invest_memo_chunk"


def _normalize_company_type(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "protocol": "crypto_protocol",
        "defi": "crypto_protocol",
        "software": "software_business",
        "saas": "software_business",
        "ai": "ai_startup",
        "public": "public_equities",
        "equities": "public_equities",
    }
    return aliases.get(normalized, normalized)


def _normalize_stage(value: str | None) -> str | None:
    return value.strip().lower().replace(" ", "_") if value else None


def _clip(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _query_tokens(query: str) -> list[str]:
    tokens = [token for token in re.findall(r"[a-z0-9]+", query.lower()) if len(token) >= 3]
    deduped: list[str] = []
    for token in tokens:
        if token not in deduped:
            deduped.append(token)
    return deduped[:10]


@dataclass
class _ChunkHit:
    document_id: str
    memo_name: str
    stage_hint: str
    type_hint: str
    relative_path: str
    score: float
    excerpt: str
    source_id: str


async def list_memos(conn: Any, *, query: str | None, limit: int, source: str) -> dict[str, Any]:
    """List memo documents from the indexed memo corpus using ``conn``."""
    rows = await conn.fetch(
        """
        SELECT external_id, data, fetched_at
        FROM raw_records
        WHERE source = $1
          AND kind = 'document'
          AND (
            $2::text IS NULL
            OR lower(coalesce(data->>'memo_name', '')) LIKE lower('%' || $2 || '%')
          )
        ORDER BY fetched_at DESC
        LIMIT $3
        """,
        source,
        query.strip() if query else None,
        max(1, min(limit, 200)),
    )
    memos: list[dict[str, Any]] = []
    for row in rows:
        data = _as_dict(row["data"])
        memos.append(
            {
                "document_id": row["external_id"],
                "memo_name": data.get("memo_name"),
                "relative_path": data.get("relative_path"),
                "stage_hint": data.get("stage_hint"),
                "type_hint": data.get("type_hint"),
                "content_hash": data.get("content_hash"),
                "fetched_at": row["fetched_at"].isoformat() if row["fetched_at"] else None,
            }
        )
    return {"status": "ok", "source": source, "count": len(memos), "memos": memos}


async def _search_chunks(
    conn: Any,
    *,
    query: str,
    source: str,
    kind: str,
    stage: str | None,
    company_type: str | None,
    chunk_limit: int,
) -> list[_ChunkHit]:
    tokens = _query_tokens(query)
    or_ts_query = " | ".join(tokens)
    like_patterns = [f"%{token}%" for token in tokens[:8]]
    rows = await conn.fetch(
        """
        WITH candidates AS (
            SELECT
                source_id,
                content,
                metadata,
                created_at,
                CASE
                    WHEN $1::text <> '' THEN ts_rank_cd(content_tsv, to_tsquery('english', $1))
                    ELSE 0
                END AS fts_or_score,
                CASE
                    WHEN $2::text <> '' THEN ts_rank_cd(content_tsv, plainto_tsquery('english', $2))
                    ELSE 0
                END AS fts_and_score
            FROM embeddings
            WHERE source = $3
              AND kind = $4
              AND ($5::text IS NULL OR metadata->>'stage_hint' = $5)
              AND ($6::text IS NULL OR metadata->>'type_hint' = $6)
              AND (
                ($1::text <> '' AND content_tsv @@ to_tsquery('english', $1))
                OR ($2::text <> '' AND content_tsv @@ plainto_tsquery('english', $2))
                OR (array_length($7::text[], 1) IS NOT NULL AND lower(content) LIKE ANY($7::text[]))
              )
            ORDER BY fts_or_score DESC, fts_and_score DESC, created_at DESC
            LIMIT $8
        )
        SELECT source_id, content, metadata, fts_or_score, fts_and_score
        FROM candidates
        ORDER BY fts_or_score DESC, fts_and_score DESC
        """,
        or_ts_query,
        query,
        source,
        kind,
        stage,
        company_type,
        like_patterns if like_patterns else None,
        max(1, min(chunk_limit, 200)),
    )
    if not rows and tokens:
        rows = await conn.fetch(
            """
            SELECT source_id, content, metadata, 0::float AS fts_or_score, 0::float AS fts_and_score
            FROM embeddings
            WHERE source = $1
              AND kind = $2
              AND ($3::text IS NULL OR metadata->>'stage_hint' = $3)
              AND ($4::text IS NULL OR metadata->>'type_hint' = $4)
              AND lower(content) LIKE ANY($5::text[])
            ORDER BY created_at DESC
            LIMIT $6
            """,
            source,
            kind,
            stage,
            company_type,
            like_patterns,
            max(1, min(chunk_limit, 200)),
        )
    hits: list[_ChunkHit] = []
    for row in rows:
        metadata = _as_dict(row["metadata"])
        document_id = str(
            metadata.get("document_id")
            or str(row["source_id"]).split(":")[0]
        )
        memo_name = str(metadata.get("memo_name") or document_id)
        content = str(row["content"] or "")
        token_hits = sum(1 for token in tokens if token in content.lower())
        lexical_bonus = (token_hits / max(len(tokens), 1)) if tokens else 0.0
        fts_or_score = float(row["fts_or_score"] or 0.0)
        fts_and_score = float(row["fts_and_score"] or 0.0)
        combined_score = (fts_and_score * 1.7) + (fts_or_score * 1.1) + lexical_bonus
        hits.append(
            _ChunkHit(
                document_id=document_id,
                memo_name=memo_name,
                stage_hint=str(metadata.get("stage_hint") or "unknown"),
                type_hint=str(metadata.get("type_hint") or "unknown"),
                relative_path=str(metadata.get("relative_path") or ""),
                score=combined_score,
                excerpt=_clip(content.strip(), 420),
                source_id=str(row["source_id"]),
            )
        )
    return hits


async def search_memos(
    conn: Any,
    *,
    query: str,
    limit: int,
    stage: str | None,
    company_type: str | None,
    source: str,
    kind: str,
) -> dict[str, Any]:
    """Search indexed memo chunks and aggregate top documents using ``conn``.

    Normalization, grouping, and ranking run here so they stay a single source.
    ``limit`` is expected pre-clamped; ``source``/``kind`` pre-resolved.
    """
    normalized_stage = _normalize_stage(stage)
    normalized_type = _normalize_company_type(company_type)
    chunk_limit = limit * 12

    hits = await _search_chunks(
        conn,
        query=query,
        source=source,
        kind=kind,
        stage=normalized_stage,
        company_type=normalized_type,
        chunk_limit=chunk_limit,
    )

    grouped: dict[str, dict[str, Any]] = {}
    for hit in hits:
        doc = grouped.setdefault(
            hit.document_id,
            {
                "document_id": hit.document_id,
                "memo_name": hit.memo_name,
                "stage_hint": hit.stage_hint,
                "type_hint": hit.type_hint,
                "relative_path": hit.relative_path,
                "score": hit.score,
                "matched_chunks": 0,
                "source_ids": [],
                "excerpts": [],
            },
        )
        doc["score"] = max(float(doc["score"]), hit.score)
        doc["matched_chunks"] += 1
        if len(doc["source_ids"]) < 6:
            doc["source_ids"].append(hit.source_id)
        if len(doc["excerpts"]) < 3:
            doc["excerpts"].append(hit.excerpt)

    ranked = sorted(grouped.values(), key=lambda item: float(item["score"]), reverse=True)[:limit]
    return {
        "status": "ok",
        "query": query,
        "source": source,
        "kind": kind,
        "count": len(ranked),
        "results": ranked,
    }


async def read_memo(
    conn: Any,
    *,
    memo: str,
    max_chars: int,
    source: str,
    kind: str,
) -> dict[str, Any]:
    """Read memo content by document ID or memo name using ``conn``."""
    row = await conn.fetchrow(
        """
        SELECT external_id, data
        FROM raw_records
        WHERE source = $1
          AND kind = 'document'
          AND (
            external_id = $2
            OR lower(coalesce(data->>'memo_name', '')) = lower($2)
          )
        ORDER BY fetched_at DESC
        LIMIT 1
        """,
        source,
        memo,
    )
    if not row:
        row = await conn.fetchrow(
            """
            SELECT external_id, data
            FROM raw_records
            WHERE source = $1
              AND kind = 'document'
              AND lower(coalesce(data->>'memo_name', '')) LIKE lower('%' || $2 || '%')
            ORDER BY fetched_at DESC
            LIMIT 1
            """,
            source,
            memo,
        )
    if not row:
        return {"status": "error", "error": f"Memo not found: {memo}"}

    document_id = str(row["external_id"])
    meta = _as_dict(row["data"])
    chunk_rows = await conn.fetch(
        """
        SELECT content, metadata
        FROM embeddings
        WHERE source = $1
          AND kind = $2
          AND metadata->>'document_id' = $3
        ORDER BY
          COALESCE((metadata->>'chunk_index')::int, 0) ASC,
          created_at ASC
        LIMIT 500
        """,
        source,
        kind,
        document_id,
    )
    text_parts: list[str] = []
    total = 0
    for chunk in chunk_rows:
        content = str(chunk["content"] or "")
        remaining = max_chars - total
        if remaining <= 0:
            break
        if len(content) > remaining:
            text_parts.append(content[:remaining])
            total = max_chars
            break
        text_parts.append(content)
        total += len(content)
    content = "\n\n".join(part for part in text_parts if part).strip()
    return {
        "status": "ok",
        "document_id": document_id,
        "memo_name": meta.get("memo_name"),
        "stage_hint": meta.get("stage_hint"),
        "type_hint": meta.get("type_hint"),
        "chars": len(content),
        "content": content,
    }
