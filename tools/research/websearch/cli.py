"""CLI for websearch tool."""

from __future__ import annotations

import asyncio
import json

import typer
from dotenv import load_dotenv
from rich.console import Console

from .client import _client

load_dotenv()

app = typer.Typer(name="websearch", help="Web search and deep research via Exa + Claude")
console = Console(stderr=True)


def _print_json(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


@app.command()
def search(
    query: str = typer.Argument(..., help="Search query"),
    num_results: int = typer.Option(10, "--num-results", "-n", help="Maximum results"),
    search_type: str = typer.Option("auto", "--search-type", help="Exa search type"),
    timeout_seconds: float = typer.Option(30.0, "--timeout-seconds", help="Request timeout"),
    synthesize: bool = typer.Option(
        True, "--synthesize/--no-synthesize", help="Generate synthesized cited answer"
    ),
    max_report_chars: int = typer.Option(
        12000, "--max-report-chars", help="Maximum synthesis length in characters"
    ),
    pretty: bool = typer.Option(False, "--pretty", help="Print concise human-readable output"),
):
    """Search the web via Exa."""
    client = _client()
    try:
        payload = asyncio.run(
            client.search(
                query=query,
                num_results=num_results,
                search_type=search_type,
                timeout_seconds=timeout_seconds,
                synthesize=synthesize,
                max_report_chars=max_report_chars,
            )
        )
    except Exception as exc:  # pragma: no cover - CLI surface
        console.print(f"[red]search failed:[/] {exc}")
        raise typer.Exit(1) from exc

    if pretty:
        out_console = Console()
        out_console.print(f"[bold]Query:[/] {payload['query']}")
        if payload.get("answer_markdown"):
            out_console.print(payload["answer_markdown"])
        out_console.print(f"\n[bold]Results:[/] {len(payload['results'])}")
        for row in payload["results"][:10]:
            out_console.print(f"- {row['title']} ({row['url']})")
        return
    _print_json(payload)


@app.command("deep-research")
def deep_research_command(
    question: str = typer.Argument(..., help="Research question"),
    max_iterations: int = typer.Option(1, "--max-iterations", help="Maximum research iterations"),
    num_queries_per_iteration: int = typer.Option(
        4, "--num-queries-per-iteration", help="Parallel searches per iteration"
    ),
    num_results_per_query: int = typer.Option(
        5, "--num-results-per-query", help="Results per query"
    ),
    timeout_seconds: float = typer.Option(
        300.0, "--timeout-seconds", help="Overall timeout budget"
    ),
    pretty: bool = typer.Option(False, "--pretty", help="Print markdown report only"),
):
    """Run deep research with iterative search and synthesis."""
    client = _client()

    def _progress(stage: str) -> None:
        console.print(f"[dim]{stage}...[/]")

    client._set_progress_callback(_progress)
    try:
        payload = asyncio.run(
            client.deep_research(
                question=question,
                max_iterations=max_iterations,
                num_queries_per_iteration=num_queries_per_iteration,
                num_results_per_query=num_results_per_query,
                timeout_seconds=timeout_seconds,
            )
        )
    except Exception as exc:  # pragma: no cover - CLI surface
        console.print(f"[red]deep research failed:[/] {exc}")
        raise typer.Exit(1) from exc

    if pretty:
        print(payload["answer_markdown"])
        return
    _print_json(payload)


if __name__ == "__main__":
    app()
