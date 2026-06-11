"""Discord API client."""

from typing import Any
from urllib.parse import quote

import httpx

from centaur_sdk import secret

BASE_URL = "https://discord.com/api/v10"
DEFAULT_PERMISSIONS = "2147485696"


class DiscordClient:
    """High-level Discord Bot API client for AI agents."""

    def __init__(self, token: str | None = None, timeout: float = 30.0):
        self._token = token
        self.timeout = timeout

    def _get_token(self) -> str:
        token = self._token or secret("DISCORD_BOT_TOKEN", "")
        if not token:
            raise RuntimeError(
                "DISCORD_BOT_TOKEN not set.\n"
                "Create a Discord bot and add DISCORD_BOT_TOKEN to the environment or 1Password."
            )
        return token

    def _request(self, method: str, endpoint: str, **kwargs) -> dict[str, Any] | list[Any]:
        headers = {
            "Authorization": f"Bot {self._get_token()}",
            "Content-Type": "application/json",
            "User-Agent": "Centaur Discord Tool",
        }
        with httpx.Client(timeout=self.timeout) as client:
            response = client.request(method, f"{BASE_URL}{endpoint}", headers=headers, **kwargs)

        if response.status_code == 204:
            return {}
        if response.status_code >= 400:
            try:
                error = response.json()
                message = error.get("message", response.text)
            except Exception:
                message = response.text
            raise RuntimeError(f"Discord API error ({response.status_code}): {message}")
        return response.json()

    def get_me(self) -> dict[str, Any]:
        """Get the current bot user."""
        return dict(self._request("GET", "/users/@me"))

    def join_server(
        self,
        client_id: str | None = None,
        permissions: str = DEFAULT_PERMISSIONS,
        guild_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        """Create an OAuth invite URL so an admin can add the bot to a server.

        Discord bots cannot join servers directly with only a bot token. A server admin must
        authorize the bot through this URL.
        """
        if not client_id:
            client_id = str(self.get_me()["id"])
        url = (
            "https://discord.com/oauth2/authorize"
            f"?client_id={quote(client_id)}"
            "&scope=bot%20applications.commands"
            f"&permissions={quote(permissions)}"
        )
        if guild_id:
            url += f"&guild_id={quote(guild_id)}&disable_guild_select=true"
        if redirect_uri:
            url += f"&redirect_uri={quote(redirect_uri)}&response_type=code"
        return {
            "invite_url": url,
            "client_id": client_id,
            "permissions": permissions,
            "requires_admin_authorization": True,
        }

    def list_servers(
        self,
        query: str = "",
        limit: int = 100,
        before: str | None = None,
        after: str | None = None,
    ) -> list[dict[str, Any]]:
        """List servers/guilds the bot is currently in."""
        params: dict[str, Any] = {"limit": limit}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        guilds = list(self._request("GET", "/users/@me/guilds", params=params))
        if query:
            needle = query.lower()
            guilds = [guild for guild in guilds if needle in guild.get("name", "").lower()]
        return guilds

    def get_server(self, guild_id: str) -> dict[str, Any]:
        """Get details for a server/guild by ID."""
        return dict(self._request("GET", f"/guilds/{guild_id}"))

    def resolve_server(self, guild: str) -> dict[str, Any]:
        """Resolve a server/guild by ID, exact name, or partial name."""
        if guild.isdigit():
            return self.get_server(guild)
        servers = self.list_servers(limit=200)
        for server in servers:
            if server.get("name", "").lower() == guild.lower():
                return server
        for server in servers:
            if guild.lower() in server.get("name", "").lower():
                return server
        raise RuntimeError(f"Discord server not found: {guild}")

    def list_channels(self, guild_id: str, query: str = "") -> list[dict[str, Any]]:
        """List channels in a server/guild."""
        channels = list(self._request("GET", f"/guilds/{guild_id}/channels"))
        if query:
            needle = query.lower().lstrip("#")
            channels = [channel for channel in channels if needle in channel.get("name", "").lower()]
        return channels

    def get_channel(self, channel_id: str) -> dict[str, Any]:
        """Get details for a channel by ID."""
        return dict(self._request("GET", f"/channels/{channel_id}"))

    def resolve_channel(self, channel: str, guild_id: str | None = None) -> dict[str, Any]:
        """Resolve a channel by ID, exact name, or partial name."""
        if channel.isdigit():
            return self.get_channel(channel)
        needle = channel.lower().lstrip("#")
        guild_ids = (
            [guild_id] if guild_id else [guild["id"] for guild in self.list_servers(limit=200)]
        )
        candidates: list[dict[str, Any]] = []
        for gid in guild_ids:
            candidates.extend(self.list_channels(str(gid)))
        text_channels = [
            candidate for candidate in candidates if candidate.get("type") in {0, 5, 10, 11, 12, 15}
        ]
        for candidate in text_channels:
            if candidate.get("name", "").lower() == needle:
                return candidate
        for candidate in text_channels:
            if needle in candidate.get("name", "").lower():
                return candidate
        raise RuntimeError(f"Discord channel not found: {channel}")

    def get_messages(
        self,
        channel_id: str,
        limit: int = 50,
        before: str | None = None,
        after: str | None = None,
        around: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get recent messages from a channel."""
        params: dict[str, Any] = {"limit": max(1, min(limit, 100))}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        if around:
            params["around"] = around
        return list(self._request("GET", f"/channels/{channel_id}/messages", params=params))

    def get_context(
        self,
        channel: str,
        message_id: str,
        before: int = 10,
        after: int = 10,
        guild_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get messages around a specific message."""
        resolved = self.resolve_channel(channel, guild_id=guild_id)
        channel_id = str(resolved["id"])
        messages = self.get_messages(
            channel_id=channel_id,
            around=message_id,
            limit=max(1, min(before + after + 1, 100)),
        )
        messages.sort(key=lambda message: int(message["id"]))
        return messages

    def search_messages(
        self,
        query: str,
        channel_id: str | None = None,
        guild_id: str | None = None,
        limit: int = 50,
        per_channel: int = 100,
    ) -> list[dict[str, Any]]:
        """Search recent messages visible to the bot in one channel or across a server."""
        if not channel_id and not guild_id:
            raise ValueError("Provide channel_id or guild_id.")

        channels: list[dict[str, Any]]
        if channel_id:
            channels = [self.resolve_channel(channel_id, guild_id=guild_id)]
        else:
            channels = [
                channel
                for channel in self.list_channels(str(guild_id))
                if channel.get("type") in {0, 5, 10, 11, 12, 15}
            ]

        needle = query.lower()
        results: list[dict[str, Any]] = []
        for channel in channels:
            cid = str(channel["id"])
            try:
                messages = self.get_messages(cid, limit=per_channel)
            except RuntimeError:
                continue
            for message in messages:
                content = message.get("content") or ""
                if needle in content.lower():
                    results.append(
                        {
                            "channel_id": cid,
                            "channel_name": channel.get("name"),
                            "message_id": message.get("id"),
                            "author": message.get("author", {}).get("username"),
                            "author_id": message.get("author", {}).get("id"),
                            "timestamp": message.get("timestamp"),
                            "content": content,
                        }
                    )
                    if len(results) >= limit:
                        return results
        return results

    def post_message(
        self,
        channel_id: str,
        content: str,
        reply_to_message_id: str | None = None,
        tts: bool = False,
        guild_id: str | None = None,
    ) -> dict[str, Any]:
        """Post a message to a channel."""
        channel_id = str(self.resolve_channel(channel_id, guild_id=guild_id)["id"])
        payload: dict[str, Any] = {"content": content, "tts": tts}
        if reply_to_message_id:
            payload["message_reference"] = {"message_id": reply_to_message_id}
        return dict(self._request("POST", f"/channels/{channel_id}/messages", json=payload))


def _client() -> DiscordClient:
    return DiscordClient()
