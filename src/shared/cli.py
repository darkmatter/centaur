from __future__ import annotations

import asyncio
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import click
import structlog
import uvicorn
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from etl.config import ETLSettings
from etl.embeddings import EmbeddingService, hybrid_search
from etl.pipeline import run_continuous, run_sync
from shared.cli_tables import render_text_table
from shared.config import Settings
from shared.db import close_pool, create_pool, fetch
from shared.engineer.models import Phase
from shared.engineer.orchestrator import EngineerOrchestrator
from shared.engineer.session import EngineerSession
from shared.engineer.settings import engineer_settings
from shared.models import EmbeddingRecord
from shared.plugin_manager import PluginManager


_LOG_LEVELS = {
    "critical": 50,
    "error": 40,
    "warning": 30,
    "info": 20,
    "debug": 10,
}
_default_level = os.getenv("AI_V2_LOG_LEVEL", "warning").lower()
_log_level = _LOG_LEVELS.get(_default_level, 30)

_renderer: structlog.types.Processor = (
    structlog.dev.ConsoleRenderer()
    if sys.stderr.isatty()
    else structlog.processors.JSONRenderer()
)

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(_log_level),
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        _renderer,
    ],
)
log = structlog.get_logger()


@click.group()
def cli() -> None:
    """Tempo AI v2 — Postgres+pgvector data plane, API, and sandbox."""


# ---------------------------------------------------------------------------
# Dataplane commands
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--source", "-s", multiple=True, help="Specific sources to sync")
def sync(source: tuple[str, ...]) -> None:
    """Run full or per-source sync (extract → transform → embed)."""
    settings = ETLSettings()
    sources = list(source) if source else None
    results = asyncio.run(run_sync(settings, sources))
    total = sum(r.records_written for r in results)
    click.echo(f"\nSync complete: {len(results)} sources, {total} records written")
    for r in results:
        click.echo(f"  {r.source}: {r.records_written} records ({r.duration_ms}ms)")
        for kind, count in sorted(r.kinds.items()):
            click.echo(f"    {kind}: {count}")


@cli.command()
@click.option("--source", "-s", default=None, help="Filter by source")
@click.option("--batch-size", default=100, help="Records per embedding batch")
def embed(source: str | None, batch_size: int) -> None:
    """Generate/refresh embeddings for raw records."""
    settings = Settings()
    if not settings.openai_api_key:
        click.echo("Error: OPENAI_API_KEY not set", err=True)
        sys.exit(1)

    async def _run() -> None:
        pool = await create_pool(settings.database_url)
        svc = EmbeddingService(
            settings.openai_api_key,
            settings.embedding_model,
            settings.embedding_dimensions,
        )
        try:
            source_clause = ""
            args: list = []
            if source:
                source_clause = "WHERE r.source = $1"
                args.append(source)
            query = f"""
                SELECT r.source, r.kind, r.external_id,
                       r.data::text AS data_text
                FROM raw_records r
                LEFT JOIN embeddings e
                    ON e.source = r.source
                    AND e.kind = r.kind
                    AND e.source_id = r.external_id
                {source_clause}
                AND e.id IS NULL
                ORDER BY r.fetched_at DESC
            """
            rows = await fetch(pool, query, *args)
            click.echo(f"Found {len(rows)} records without embeddings")

            records: list[EmbeddingRecord] = []
            for row in rows:
                data = (
                    json.loads(row["data_text"])
                    if isinstance(row["data_text"], str)
                    else row["data_text"]
                )
                content_parts: list[str] = []
                for key in (
                    "title",
                    "name",
                    "text",
                    "body",
                    "content",
                    "description",
                    "summary",
                    "snippet",
                ):
                    val = data.get(key)
                    if val and isinstance(val, str):
                        content_parts.append(val)
                if not content_parts:
                    content_parts.append(json.dumps(data)[:2000])

                records.append(
                    EmbeddingRecord(
                        source=row["source"],
                        kind=row["kind"],
                        source_id=row["external_id"],
                        content=" ".join(content_parts)[:8000],
                        metadata={"external_id": row["external_id"]},
                    )
                )

            total_stored = 0
            for i in range(0, len(records), batch_size):
                batch = records[i : i + batch_size]
                stored = await svc.embed_and_store(pool, batch)
                total_stored += stored
                click.echo(f"  Embedded batch {i // batch_size + 1}: {stored} records")
            click.echo(f"Embedding complete: {total_stored} records")
        finally:
            await close_pool(pool)

    asyncio.run(_run())


@cli.command()
def status() -> None:
    """Show sync status (record counts, cursor positions)."""
    settings = Settings()

    async def _run() -> None:
        pool = await create_pool(settings.database_url)
        try:
            rows = await fetch(
                pool,
                """
                SELECT source, kind, COUNT(*) as count
                FROM raw_records GROUP BY source, kind ORDER BY source, kind
                """,
            )
            click.echo("=== Record Counts ===")
            current_source = ""
            for row in rows:
                if row["source"] != current_source:
                    current_source = row["source"]
                    click.echo(f"\n  {current_source}:")
                click.echo(f"    {row['kind']}: {row['count']}")

            cursors = await fetch(
                pool,
                """
                SELECT source, kind, entity_id, cursor, updated_at
                FROM sync_cursors ORDER BY source, kind
                """,
            )
            click.echo("\n=== Sync Cursors ===")
            for row in cursors:
                entity = f"/{row['entity_id']}" if row["entity_id"] else ""
                click.echo(
                    f"  {row['source']}/{row['kind']}{entity}: "
                    f"{row['cursor']} (updated: {row['updated_at']})"
                )

            emb_rows = await fetch(
                pool,
                """
                SELECT source, kind, COUNT(*) as count
                FROM embeddings GROUP BY source, kind ORDER BY source, kind
                """,
            )
            click.echo("\n=== Embeddings ===")
            for row in emb_rows:
                click.echo(f"  {row['source']}/{row['kind']}: {row['count']}")
        finally:
            await close_pool(pool)

    asyncio.run(_run())


@cli.command()
@click.argument("query")
@click.option("--limit", "-n", default=10, help="Number of results")
@click.option("--source", "-s", default=None, help="Filter by source")
def search(query: str, limit: int, source: str | None) -> None:
    """Test hybrid search (vector + full-text)."""
    settings = Settings()
    if not settings.openai_api_key:
        click.echo("Error: OPENAI_API_KEY not set", err=True)
        sys.exit(1)

    async def _run() -> None:
        pool = await create_pool(settings.database_url)
        svc = EmbeddingService(
            settings.openai_api_key,
            settings.embedding_model,
            settings.embedding_dimensions,
        )
        try:
            embeddings = await svc.embed_texts([query])
            query_embedding = embeddings[0]
            results = await hybrid_search(
                pool, query, query_embedding, limit=limit, source_filter=source
            )
            click.echo(f"\nSearch results for: {query}\n")
            for i, r in enumerate(results):
                click.echo(f"--- Result {i + 1} ---")
                click.echo(f"  Source: {r['source']}/{r['kind']}")
                click.echo(f"  ID: {r['source_id']}")
                click.echo(
                    f"  Scores: vec={r['vec_score']:.4f} "
                    f"fts={r['fts_score']:.4f} rrf={r['rrf_score']:.6f}"
                )
                content = r["content"][:200]
                click.echo(f"  Content: {content}...")
                click.echo()
        finally:
            await close_pool(pool)

    asyncio.run(_run())


@cli.command("migrate-from-sqlite")
@click.argument("sqlite_path")
def migrate_from_sqlite(sqlite_path: str) -> None:
    """Import data from existing metronome SQLite DB."""
    settings = Settings()
    db_path = Path(sqlite_path)
    if not db_path.exists():
        click.echo(f"Error: SQLite DB not found at {sqlite_path}", err=True)
        sys.exit(1)

    async def _run() -> None:
        pool = await create_pool(settings.database_url)
        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row

            click.echo("Migrating raw_records...")
            cursor = conn.execute(
                "SELECT source, kind, external_id, fetched_at, content_hash, data FROM raw__records"
            )
            total = 0
            while True:
                rows = cursor.fetchmany(1000)
                if not rows:
                    break
                async with pool.acquire() as pg:
                    for row in rows:
                        await pg.execute(
                            """
                            INSERT INTO raw_records
                                (source, kind, external_id,
                                 fetched_at, content_hash, data)
                            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                            ON CONFLICT DO NOTHING
                            """,
                            row["source"],
                            row["kind"],
                            row["external_id"],
                            row["fetched_at"],
                            row["content_hash"],
                            row["data"],
                        )
                        total += 1
                click.echo(f"  Migrated {total} records...")

            click.echo("Migrating sync_cursors...")
            try:
                cursor = conn.execute(
                    "SELECT cursor_key, source, kind, entity_id, "
                    "cursor, updated_at FROM sync_cursors"
                )
                cursor_rows = cursor.fetchall()
                async with pool.acquire() as pg:
                    for row in cursor_rows:
                        await pg.execute(
                            """
                            INSERT INTO sync_cursors
                                (cursor_key, source, kind,
                                 entity_id, cursor, updated_at)
                            VALUES ($1, $2, $3, $4, $5, $6)
                            ON CONFLICT DO NOTHING
                            """,
                            row["cursor_key"],
                            row["source"],
                            row["kind"],
                            row["entity_id"],
                            row["cursor"],
                            row["updated_at"],
                        )
            except sqlite3.OperationalError:
                click.echo("  No sync_cursors table found, skipping")

            click.echo("Migrating people...")
            try:
                cursor = conn.execute(
                    "SELECT slug, name, email, role, is_direct_report, focus_area FROM people"
                )
                people_rows = cursor.fetchall()
                async with pool.acquire() as pg:
                    for row in people_rows:
                        await pg.execute(
                            """
                            INSERT INTO people
                                (slug, name, email, role,
                                 is_direct_report, focus_area)
                            VALUES ($1, $2, $3, $4, $5, $6)
                            ON CONFLICT DO NOTHING
                            """,
                            row["slug"],
                            row["name"],
                            row["email"],
                            row["role"],
                            bool(row["is_direct_report"]),
                            row["focus_area"],
                        )
            except sqlite3.OperationalError:
                click.echo("  No people table found, skipping")

            click.echo("Migrating entity_mappings...")
            try:
                cursor = conn.execute(
                    "SELECT source, external_id, person_slug FROM entity_mappings"
                )
                mapping_rows = cursor.fetchall()
                async with pool.acquire() as pg:
                    for row in mapping_rows:
                        await pg.execute(
                            """
                            INSERT INTO entity_mappings
                                (source, external_id, person_slug)
                            VALUES ($1, $2, $3)
                            ON CONFLICT DO NOTHING
                            """,
                            row["source"],
                            row["external_id"],
                            row["person_slug"],
                        )
            except sqlite3.OperationalError:
                click.echo("  No entity_mappings table found, skipping")

            conn.close()
            click.echo(f"\nMigration complete: {total} raw records imported")
        finally:
            await close_pool(pool)

    asyncio.run(_run())


@cli.command()
@click.option("--interval", "-i", default=None, type=int, help="Sync interval in seconds")
def continuous(interval: int | None) -> None:
    """Run continuous sync loop."""
    settings = ETLSettings()
    asyncio.run(run_continuous(settings, interval))


@cli.group("engineer")
def engineer_group() -> None:
    """Engineer automation commands."""


@engineer_group.command("run")
@click.argument("task")
@click.option("--dry-run", is_flag=True, help="Run full loop but skip push/PR.")
@click.option("--skip-clarify", is_flag=True, help="Skip interactive clarification.")
@click.option(
    "--engine",
    type=click.Choice(["amp", "claude-code", "codex", "pi-mono"], case_sensitive=False),
    default=None,
    help="Engine preference alias (maps to model selection hints).",
)
@click.option(
    "--model",
    default=None,
    help="Explicit model id (e.g. claude-opus-4-6, claude-sonnet-4-6). Overrides --engine.",
)
def engineer_run(
    task: str,
    dry_run: bool,
    skip_clarify: bool,
    engine: str | None,
    model: str | None,
) -> None:
    """Run engineer workflow from CLI."""

    model_preference = (model or engine or "").strip() or None

    async def _run() -> None:
        session = EngineerSession(thread_key="cli", task=task, model_preference=model_preference)
        orchestrator = EngineerOrchestrator(
            settings=engineer_settings,
            dry_run=dry_run,
            skip_clarify=skip_clarify,
            model_preference=model_preference,
        )

        if not skip_clarify:
            _start_stdin_reader(session)

        async def _print(msg: str) -> None:
            click.echo(f"  {msg}")

        result = await orchestrator.run(session, post_message=_print)
        if result.success:
            click.echo(f"\nEngineer completed: {result.pr_url or result.summary}")
            return
        click.echo(f"\nEngineer failed: {result.error}", err=True)
        sys.exit(1)

    asyncio.run(_run())


def _start_stdin_reader(session: EngineerSession) -> None:
    """Feed stdin replies into an active clarification phase."""

    def _reader() -> None:
        while session.phase not in (Phase.DONE, Phase.FAILED):
            if session.phase != Phase.CLARIFY:
                time.sleep(0.5)
                continue
            try:
                line = input()
            except EOFError:
                break
            if line.strip():
                session.receive_user_reply(line.strip())

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Plugin commands
# ---------------------------------------------------------------------------


@cli.group("plugins")
def plugins_group() -> None:
    """Discover and test plugin imports, tools, and CLIs."""


@plugins_group.command("list")
def plugins_list() -> None:
    """List discovered plugins and tools from the plugin manager."""
    app_root = Path(__file__).resolve().parent.parent.parent
    plugins_dir = Path(app_root / "plugins")

    manager = PluginManager(plugins_dir)
    manager.discover()

    rows = []
    for plugin in manager.plugin_test_matrix():
        rows.append(
            {
                "plugin": plugin["plugin"],
                "tools": str(len(plugin["discovered_tools"])),
                "aliases": ", ".join(plugin["aliases"]) or "-",
                "cli": "yes" if plugin["cli_available"] else "no",
                "cli_path": plugin["cli_path"],
            }
        )

    if not rows:
        click.echo("No plugins loaded.")
        return

    headers = ["Plugin", "Tools", "Aliases", "CLI", "CLI Path"]
    table_rows = [
        [row["plugin"], row["tools"], row["aliases"], row["cli"], row["cli_path"]]
        for row in sorted(rows, key=lambda r: r["plugin"])
    ]
    click.echo(render_text_table(headers, table_rows))


@plugins_group.command("run")
@click.argument("tool")
@click.argument("args", nargs=-1, type=click.UNPROCESSED)
def plugins_run(tool: str, args: tuple[str, ...]) -> None:
    """Run a plugin CLI by plugin name or script alias."""
    app_root = Path(__file__).resolve().parent.parent.parent
    plugins_dir = Path(app_root / "plugins")

    manager = PluginManager(plugins_dir)
    if (plugins_dir / tool).is_dir():
        manager.discover(only_plugins={tool})
    else:
        manager.discover()

    output = manager.run_cli(tool, list(args))
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        click.echo(output)
        return

    if isinstance(parsed, dict) and "error" in parsed:
        click.echo(json.dumps(parsed, indent=2), err=True)
        sys.exit(1)

    click.echo(output)


@plugins_group.command("test")
@click.option(
    "--cli-args",
    default="--help",
    show_default=True,
    help="Arguments passed to each plugin CLI for smoke testing.",
)
def plugins_test(cli_args: str) -> None:
    """Run plugin smoke tests across imports, registry, CLIs, REST routes, and schemas."""
    app_root = Path(__file__).resolve().parent.parent.parent
    plugins_dir = Path(app_root / "plugins")

    manager = PluginManager(plugins_dir)
    manager.discover()

    registry_results = manager.smoke_test_registry()
    import_and_discovery = manager.plugin_test_matrix()
    cli_results = manager.smoke_test_clis(shlex.split(cli_args))
    alias_results = manager.smoke_test_aliases(shlex.split(cli_args))
    rest_results = manager.smoke_test_rest_routes()
    schema_results = manager.smoke_test_schemas()

    failures: list[dict[str, object]] = []
    failures.extend(result for result in registry_results if result.get("status") != "ok")
    failures.extend(
        result for result in cli_results if result.get("status") not in {"ok", "missing_cli"}
    )
    failures.extend(
        result for result in alias_results if result.get("status") not in {"ok", "missing_aliases"}
    )
    failures.extend(result for result in rest_results if result.get("status") != "ok")
    failures.extend(result for result in schema_results if result.get("status") != "ok")

    click.echo(
        json.dumps(
            {
                "imports_and_discovery": import_and_discovery,
                "registry_smoke": registry_results,
                "cli_smoke": cli_results,
                "alias_smoke": alias_results,
                "rest_routes": rest_results,
                "schema_validation": schema_results,
                "summary": {
                    "plugins_loaded": len(import_and_discovery),
                    "registry_failures": len(
                        [result for result in registry_results if result.get("status") != "ok"]
                    ),
                    "cli_failures": len(
                        [
                            result
                            for result in cli_results
                            if result.get("status") not in {"ok", "missing_cli"}
                        ]
                    ),
                    "alias_failures": len(
                        [
                            result
                            for result in alias_results
                            if result.get("status") not in {"ok", "missing_aliases"}
                        ]
                    ),
                    "rest_failures": len(
                        [result for result in rest_results if result.get("status") != "ok"]
                    ),
                    "schema_failures": len(
                        [result for result in schema_results if result.get("status") != "ok"]
                    ),
                },
            },
            indent=2,
        )
    )

    if failures:
        sys.exit(1)


# ---------------------------------------------------------------------------
# API command
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--host", default="0.0.0.0", help="Bind host")
@click.option("--port", default=8000, type=int, help="Bind port")
@click.option("--reload", is_flag=True, help="Enable auto-reload")
def serve(host: str, port: int, reload: bool) -> None:
    """Run the API server."""
    uvicorn.run("api.app:app", host=host, port=port, reload=reload)





if __name__ == "__main__":
    cli()
