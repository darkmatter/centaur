"""CLI for Discord bot operations."""

import json

from dotenv import load_dotenv

load_dotenv()

import typer  # noqa: E402
from rich.console import Console  # noqa: E402

from centaur_sdk import Table  # noqa: E402

app = typer.Typer(name="discord", help="Discord CLI for AI agents")
console = Console()


def _get_client():
    from .client import DiscordClient

    return DiscordClient()


def _emit(data, json_output: bool):
    if json_output:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return True
    return False


@app.command()
def me(json_output: bool = typer.Option(False, "--json", help="Output as JSON")):
    """Get info about the bot."""
    result = _get_client().get_me()
    if _emit(result, json_output):
        return
    console.print(f"[bold]Bot:[/] {result.get('username')}#{result.get('discriminator')}")
    console.print(f"[dim]ID: {result.get('id')}[/]")


@app.command("join-server")
def join_server(
    client_id: str = typer.Option(None, "--client-id", help="Bot application client ID"),
    guild_id: str = typer.Option(None, "--guild-id", help="Preselect a server/guild ID"),
    permissions: str = typer.Option("2147485696", "--permissions", help="Discord permissions integer"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Create a Discord OAuth invite URL for adding the bot to a server."""
    result = _get_client().join_server(
        client_id=client_id,
        guild_id=guild_id,
        permissions=permissions,
    )
    if _emit(result, json_output):
        return
    console.print("[yellow]Discord requires an admin to authorize bot server joins.[/]")
    console.print(result["invite_url"])


@app.command("servers")
def servers(
    query: str = typer.Argument("", help="Optional server name filter"),
    limit: int = typer.Option(100, "--limit", "-n", help="Max servers"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List servers/guilds the bot is in."""
    results = _get_client().list_servers(query=query, limit=limit)
    if _emit(results, json_output):
        return
    table = Table(title="Discord Servers")
    table.add_column("Name", style="cyan")
    table.add_column("ID", style="dim")
    table.add_column("Owner", style="green")
    for guild in results:
        table.add_row(guild.get("name", ""), guild.get("id", ""), str(guild.get("owner", "")))
    console.print(table)


@app.command("channels")
def channels(
    guild: str = typer.Argument(..., help="Server/guild name or ID"),
    query: str = typer.Argument("", help="Optional channel name filter"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List channels in a server/guild."""
    client = _get_client()
    guild_id = str(client.resolve_server(guild)["id"])
    results = client.list_channels(guild_id, query=query)
    if _emit(results, json_output):
        return
    table = Table(title=f"Discord Channels: {guild_id}")
    table.add_column("Name", style="cyan")
    table.add_column("ID", style="dim")
    table.add_column("Type", style="green")
    for channel in results:
        table.add_row(channel.get("name", ""), channel.get("id", ""), str(channel.get("type", "")))
    console.print(table)


@app.command("messages")
def messages(
    channel: str = typer.Argument(..., help="Channel name or ID"),
    guild_id: str = typer.Option(None, "--guild-id", "-g", help="Server/guild ID for name lookup"),
    limit: int = typer.Option(50, "--limit", "-n", help="Max messages"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Fetch recent messages from a channel."""
    client = _get_client()
    channel_id = str(client.resolve_channel(channel, guild_id=guild_id)["id"])
    results = client.get_messages(channel_id=channel_id, limit=limit)
    if _emit(results, json_output):
        return
    for message in reversed(results):
        author = message.get("author", {}).get("username", "unknown")
        content = (message.get("content") or "").replace("\n", " ")
        console.print(f"[cyan]{author}[/] [dim]{message.get('timestamp')}[/]: {content}")


@app.command("search")
def search(
    query: str = typer.Argument(..., help="Search text"),
    channel: str = typer.Option(None, "--channel", "-c", help="Search one channel by name or ID"),
    guild_id: str = typer.Option(None, "--guild-id", "-g", help="Server/guild ID for channel lookup"),
    limit: int = typer.Option(50, "--limit", "-n", help="Max results"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Search recent messages in one channel visible to the bot."""
    results = _get_client().search_messages(
        query=query,
        channel_id=channel,
        guild_id=guild_id,
        limit=limit,
    )
    if _emit(results, json_output):
        return
    for result in results:
        console.print(
            f"[cyan]#{result.get('channel_name') or result.get('channel_id')}[/] "
            f"[green]{result.get('author')}[/] [dim]{result.get('timestamp')}[/]"
        )
        console.print(result.get("content", ""))


@app.command("search-all")
def search_all(
    guild: str = typer.Argument(..., help="Server/guild name or ID"),
    query: str = typer.Argument(..., help="Search text"),
    limit: int = typer.Option(50, "--limit", "-n", help="Max results"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Search recent messages across visible text channels in a server."""
    client = _get_client()
    guild_id = str(client.resolve_server(guild)["id"])
    results = client.search_messages(query=query, guild_id=guild_id, limit=limit)
    if _emit(results, json_output):
        return
    for result in results:
        console.print(
            f"[cyan]#{result.get('channel_name') or result.get('channel_id')}[/] "
            f"[green]{result.get('author')}[/] [dim]{result.get('timestamp')}[/]"
        )
        console.print(result.get("content", ""))


@app.command("context")
def context(
    channel: str = typer.Argument(..., help="Channel name or ID"),
    message_id: str = typer.Argument(..., help="Message ID"),
    guild_id: str = typer.Option(None, "--guild-id", "-g", help="Server/guild ID for name lookup"),
    before: int = typer.Option(10, "--before", help="Messages before target"),
    after: int = typer.Option(10, "--after", help="Messages after target"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get messages around a specific message."""
    results = _get_client().get_context(
        channel=channel,
        message_id=message_id,
        guild_id=guild_id,
        before=before,
        after=after,
    )
    if _emit(results, json_output):
        return
    for message in results:
        author = message.get("author", {}).get("username", "unknown")
        content = (message.get("content") or "").replace("\n", " ")
        marker = ">" if message.get("id") == message_id else " "
        console.print(f"{marker} [cyan]{author}[/] [dim]{message.get('timestamp')}[/]: {content}")


@app.command("post")
def post(
    channel: str = typer.Argument(..., help="Channel name or ID"),
    message: str = typer.Argument(..., help="Message text"),
    guild_id: str = typer.Option(None, "--guild-id", "-g", help="Server/guild ID for name lookup"),
    reply_to: str = typer.Option(None, "--reply-to", "-r", help="Message ID to reply to"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Post a message to a channel."""
    result = _get_client().post_message(
        channel_id=channel,
        content=message,
        guild_id=guild_id,
        reply_to_message_id=reply_to,
    )
    if _emit(result, json_output):
        return
    console.print(f"[green]Sent[/] message {result.get('id')} to channel {result.get('channel_id')}")


if __name__ == "__main__":
    app()
