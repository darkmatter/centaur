import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from tools.comms.discord.client import DiscordClient


def test_join_server_builds_invite_url_without_token():
    client = DiscordClient(token="unused")
    result = client.join_server(client_id="123", guild_id="456", permissions="8")

    assert result["requires_admin_authorization"] is True
    assert "client_id=123" in result["invite_url"]
    assert "guild_id=456" in result["invite_url"]
    assert "permissions=8" in result["invite_url"]


def test_search_messages_requires_scope():
    client = DiscordClient(token="unused")

    try:
        client.search_messages("hello")
    except ValueError as exc:
        assert "channel_id or guild_id" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_list_servers_filters_query(monkeypatch):
    client = DiscordClient(token="unused")

    def fake_request(method, endpoint, **kwargs):
        assert method == "GET"
        assert endpoint == "/users/@me/guilds"
        return [{"id": "1", "name": "Eth R&D"}, {"id": "2", "name": "General"}]

    monkeypatch.setattr(client, "_request", fake_request)

    assert client.list_servers(query="eth") == [{"id": "1", "name": "Eth R&D"}]
