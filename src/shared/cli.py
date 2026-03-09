from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

import click
import structlog
import uvicorn
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

from shared.cli_tables import render_text_table  # noqa: E402
from shared.tool_manager import ToolManager  # noqa: E402

_LOG_LEVELS = {
    "critical": 50,
    "error": 40,
    "warning": 30,
    "info": 20,
    "debug": 10,
}
_default_level = (os.getenv("AI_V2_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "info").lower()
_log_level = _LOG_LEVELS.get(_default_level, 20)

_renderer: structlog.types.Processor = (
    structlog.dev.ConsoleRenderer() if sys.stderr.isatty() else structlog.processors.JSONRenderer()
)

structlog.configure(
    logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
    wrapper_class=structlog.make_filtering_bound_logger(_log_level),
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", key="timestamp"),
        _renderer,
    ],
)
log = structlog.get_logger()


@click.group()
def cli() -> None:
    """Paradigm AI v2 — Postgres+pgvector data plane, API, and sandbox."""


# ---------------------------------------------------------------------------
# Tool commands
# ---------------------------------------------------------------------------


@cli.group("tools")
def tools_group() -> None:
    """Discover and test tool imports, tools, and CLIs."""


@tools_group.command("list")
def tools_list() -> None:
    """List discovered tools and tools from the tool manager."""
    app_root = Path(__file__).resolve().parent.parent.parent
    tools_dir = Path(app_root / "tools")

    manager = ToolManager(tools_dir)
    manager.discover()

    rows = []
    for entry in manager.tool_test_matrix():
        rows.append(
            {
                "tool": entry["tool"],
                "tools": str(len(entry["discovered_methods"])),
                "aliases": ", ".join(entry["aliases"]) or "-",
                "cli": "yes" if entry["cli_available"] else "no",
                "cli_path": entry["cli_path"],
            }
        )

    if not rows:
        click.echo("No tools loaded.")
        return

    headers = ["Tool", "Tools", "Aliases", "CLI", "CLI Path"]
    table_rows = [
        [row["tool"], row["tools"], row["aliases"], row["cli"], row["cli_path"]]
        for row in sorted(rows, key=lambda r: r["tool"])
    ]
    click.echo(render_text_table(headers, table_rows))


@tools_group.command("run")
@click.argument("tool")
@click.argument("args", nargs=-1, type=click.UNPROCESSED)
def tools_run(tool: str, args: tuple[str, ...]) -> None:
    """Run a tool CLI by tool name or script alias."""
    app_root = Path(__file__).resolve().parent.parent.parent
    tools_dir = Path(app_root / "tools")

    manager = ToolManager(tools_dir)
    if (tools_dir / tool).is_dir():
        manager.discover(only_names={tool})
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


@tools_group.command("test")
@click.option(
    "--cli-args",
    default="--help",
    show_default=True,
    help="Arguments passed to each tool CLI for smoke testing.",
)
def tools_test(cli_args: str) -> None:
    """Run tool smoke tests across imports, registry, CLIs, REST routes, and schemas."""
    app_root = Path(__file__).resolve().parent.parent.parent
    tools_dir = Path(app_root / "tools")

    manager = ToolManager(tools_dir)
    manager.discover()

    registry_results = manager.smoke_test_registry()
    import_and_discovery = manager.tool_test_matrix()
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
                    "tools_loaded": len(import_and_discovery),
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
