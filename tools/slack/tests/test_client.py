from slack.client import SlackClient


class _FakeWebClient:
    def __init__(self) -> None:
        self.last_kwargs = None

    def chat_postMessage(self, **kwargs):  # noqa: N802
        self.last_kwargs = kwargs
        return {"ts": "123.456"}


def _make_client() -> tuple[SlackClient, _FakeWebClient]:
    client = SlackClient.__new__(SlackClient)
    fake_web_client = _FakeWebClient()
    client._client = fake_web_client
    client._resolve_channel = lambda channel: "C123"  # type: ignore[method-assign]
    client._format_requester_attribution = lambda: ""  # type: ignore[method-assign]
    return client, fake_web_client


def test_send_message_forwards_unfurl_flags() -> None:
    client, fake_web_client = _make_client()

    client.send_message(
        "paradigm-pulse",
        "hello",
        unfurl_links=False,
        unfurl_media=False,
    )

    assert fake_web_client.last_kwargs is not None
    assert fake_web_client.last_kwargs["unfurl_links"] is False
    assert fake_web_client.last_kwargs["unfurl_media"] is False


def test_send_message_omits_unfurl_flags_by_default() -> None:
    client, fake_web_client = _make_client()

    client.send_message("paradigm-pulse", "hello")

    assert fake_web_client.last_kwargs is not None
    assert "unfurl_links" not in fake_web_client.last_kwargs
    assert "unfurl_media" not in fake_web_client.last_kwargs
