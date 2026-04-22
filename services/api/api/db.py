from __future__ import annotations

import re
import subprocess
from pathlib import Path

import asyncpg
import structlog

log = structlog.get_logger()

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "db" / "migrations"

REQUIRED_SANDBOX_SESSION_STATES = frozenset(
    {
        "creating",
        "running",
        "idle",
        "error",
        "stopped",
        "gone",
        "delivering",
        "suspended",
    }
)

REQUIRED_SANDBOX_SESSION_COLUMNS = frozenset(
    {
        "agent_thread_id",
        "inflight_turn_id",
        "inflight_turn_input",
        "inflight_started_at",
        "inflight_attempts",
        "last_result",
        "last_result_at",
    }
)

REQUIRED_MIGRATIONS = frozenset(
    {
        "005",
        "006",
        "007",
        "008",
        "009",
        "010",
        "011",
        "016",
    }
)


async def create_pool(database_url: str) -> asyncpg.Pool:
    run_migrations(database_url)
    pool = await asyncpg.create_pool(
        database_url,
        min_size=2,
        max_size=10,
        command_timeout=60,
    )
    assert pool is not None
    return pool


async def close_pool(pool: asyncpg.Pool) -> None:
    await pool.close()


def run_migrations(database_url: str) -> None:
    """Run pending dbmate migrations. Idempotent — safe to call on every startup."""
    if not MIGRATIONS_DIR.exists():
        log.warning("migrations_dir_missing", path=str(MIGRATIONS_DIR))
        return
    # dbmate's Go pq driver requires explicit sslmode for non-SSL connections
    dbmate_url = database_url
    if "sslmode=" not in dbmate_url:
        sep = "&" if "?" in dbmate_url else "?"
        dbmate_url += f"{sep}sslmode=disable"
    try:
        result = subprocess.run(
            [
                "dbmate",
                "--url",
                dbmate_url,
                "--migrations-dir",
                str(MIGRATIONS_DIR),
                "--no-dump-schema",
                "up",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            log.error(
                "dbmate_failed",
                stderr=result.stderr.strip(),
                returncode=result.returncode,
            )
            raise RuntimeError(f"dbmate migration failed: {result.stderr.strip()}")
        if result.stderr.strip():
            for line in result.stderr.strip().splitlines():
                log.info("dbmate", output=line)
        log.info("migrations_applied")
    except FileNotFoundError:
        log.warning(
            "dbmate_not_found", msg="dbmate binary not in PATH, skipping migrations"
        )


async def check_schema_compatibility(pool: asyncpg.Pool) -> dict[str, object]:
    """Verify DB schema invariants required by current API runtime code."""

    report: dict[str, object] = {
        "compatible": False,
        "required_states_missing": [],
        "required_columns_missing": [],
        "required_migrations_missing": [],
        "constraint_present": False,
        "errors": [],
    }

    try:
        row = await pool.fetchrow(
            "SELECT pg_get_constraintdef(c.oid) AS definition "
            "FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = 'sandbox_sessions' "
            "AND c.conname = 'sandbox_sessions_state_check' "
            "LIMIT 1"
        )
        definition = row["definition"] if row else None
        report["constraint_present"] = bool(definition)
        if definition:
            present_states = set(re.findall(r"'([^']+)'", str(definition)))
            missing_states = sorted(REQUIRED_SANDBOX_SESSION_STATES - present_states)
        else:
            missing_states = sorted(REQUIRED_SANDBOX_SESSION_STATES)
        report["required_states_missing"] = missing_states
    except Exception as exc:
        report["required_states_missing"] = sorted(REQUIRED_SANDBOX_SESSION_STATES)
        report["errors"].append(f"state_constraint_check_failed:{exc}")

    try:
        col_rows = await pool.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'sandbox_sessions'"
        )
        present_columns = {r["column_name"] for r in col_rows}
        report["required_columns_missing"] = sorted(
            REQUIRED_SANDBOX_SESSION_COLUMNS - present_columns
        )
    except Exception as exc:
        report["required_columns_missing"] = sorted(REQUIRED_SANDBOX_SESSION_COLUMNS)
        report["errors"].append(f"column_check_failed:{exc}")

    try:
        migration_rows = await pool.fetch("SELECT version FROM schema_migrations")
        applied = {r["version"] for r in migration_rows}
        report["required_migrations_missing"] = sorted(REQUIRED_MIGRATIONS - applied)
    except Exception as exc:
        report["required_migrations_missing"] = sorted(REQUIRED_MIGRATIONS)
        report["errors"].append(f"migration_check_failed:{exc}")

    report["compatible"] = not (
        report["required_states_missing"]
        or report["required_columns_missing"]
        or report["required_migrations_missing"]
        or report["errors"]
    )

    return report
