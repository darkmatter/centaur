"""Tests for firewall addon security hardening."""

from __future__ import annotations

import importlib
import importlib.util
import sys
from types import ModuleType
from unittest.mock import MagicMock, patch

# Track loaded addon for cleanup
_loaded_addon: ModuleType | None = None


def _load_addon() -> ModuleType:
    """Import the addon module with mitmproxy mocked out."""
    global _loaded_addon

    class FakeResponse:
        def __init__(self, status_code: int, content: bytes, headers: dict):
            self.status_code = status_code
            self.content = content
            self.headers = headers

        @classmethod
        def make(cls, status: int, body: bytes = b"", headers: dict | None = None):
            return cls(status, body, headers or {})

    mock_http_module = MagicMock()
    mock_http_module.Response = FakeResponse
    mock_http_module.HTTPFlow = MagicMock

    # The addon does `from mitmproxy import http`, so mitmproxy.http must
    # resolve to our mock_http_module both as a submodule and as an attribute.
    mock_mitmproxy = MagicMock()
    mock_mitmproxy.http = mock_http_module

    sys.modules["mitmproxy"] = mock_mitmproxy
    sys.modules["mitmproxy.http"] = mock_http_module

    # Use a random high port to avoid conflicts
    import random
    port = random.randint(19000, 29000)

    env = {
        "SECRET_MANAGER_URL": "http://localhost:9999",
        "FIREWALL_UNRESTRICTED_METHOD_HOSTS": "",
        "HEALTH_PORT": str(port),
    }
    with patch.dict("os.environ", env), patch("urllib.request.urlopen"):
            if "addon" in sys.modules:
                del sys.modules["addon"]
            spec = importlib.util.spec_from_file_location(
                "addon",
                "services/firewall/addon.py",
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)

    _loaded_addon = mod
    return mod


def _make_flow(
    method: str = "GET",
    host: str = "example.com",
    path: str = "/",
    headers: dict | None = None,
) -> MagicMock:
    """Build a mock mitmproxy flow."""
    flow = MagicMock()
    flow.request.method = method
    flow.request.pretty_host = host
    flow.request.host = host
    flow.request.path = path
    flow.request.port = 443
    flow.request.scheme = "https"
    flow.request.content = b""
    flow.response = None

    h = _HeadersDict()
    if headers:
        h.update(headers)
    flow.request.headers = h
    return flow


class _HeadersDict(dict):
    """Case-insensitive-ish dict mimicking mitmproxy Headers."""

    def keys(self):
        return list(super().keys())


# ── Tests ────────────────────────────────────────────────────────────────────


class TestMethodFiltering:
    def setup_method(self):
        self.addon = _load_addon()
        self.injector = self.addon.addons[0]
        self.injector._known_keys = set()

    def test_get_allowed_for_any_host(self):
        flow = _make_flow(method="GET", host="github.com")
        self.injector.request(flow)
        assert flow.response is None

    def test_head_allowed_for_any_host(self):
        flow = _make_flow(method="HEAD", host="github.com")
        self.injector.request(flow)
        assert flow.response is None

    def test_post_blocked_for_non_llm_host(self):
        flow = _make_flow(method="POST", host="github.com")
        self.injector.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403

    def test_put_blocked_for_non_llm_host(self):
        flow = _make_flow(method="PUT", host="github.com")
        self.injector.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403

    def test_delete_blocked_for_non_llm_host(self):
        flow = _make_flow(method="DELETE", host="npmjs.com")
        self.injector.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403

    def test_post_allowed_for_llm_host(self):
        flow = _make_flow(method="POST", host="api.anthropic.com")
        self.injector.request(flow)
        assert flow.response is None

    def test_post_allowed_for_openai(self):
        flow = _make_flow(method="POST", host="api.openai.com")
        self.injector.request(flow)
        assert flow.response is None

    def test_post_allowed_for_unrestricted_host(self):
        self.addon.UNRESTRICTED_METHOD_HOSTS = frozenset({"custom-api.example.com"})
        flow = _make_flow(method="POST", host="custom-api.example.com")
        self.injector.request(flow)
        assert flow.response is None


class TestHeaderStripping:
    def setup_method(self):
        self.addon = _load_addon()
        self.injector = self.addon.addons[0]
        self.injector._known_keys = set()

    def test_user_agent_forced(self):
        flow = _make_flow(headers={"user-agent": "exfiltrated-data-here"})
        self.injector.request(flow)
        assert flow.request.headers["user-agent"] == "ai-v2-sandbox/1.0"

    def test_allowed_headers_preserved(self):
        flow = _make_flow(headers={
            "content-type": "application/json",
            "accept": "application/json",
            "host": "example.com",
        })
        self.injector.request(flow)
        assert "content-type" in flow.request.headers
        assert "accept" in flow.request.headers

    def test_custom_headers_stripped(self):
        flow = _make_flow(headers={
            "content-type": "application/json",
            "x-custom-exfil": "secret-data",
            "x-evil-header": "more-data",
        })
        self.injector.request(flow)
        assert "x-custom-exfil" not in flow.request.headers
        assert "x-evil-header" not in flow.request.headers
        assert "content-type" in flow.request.headers

    def test_anthropic_sdk_headers_preserved(self):
        flow = _make_flow(headers={
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "messages-2024-01-01",
            "x-stainless-lang": "python",
        })
        self.injector.request(flow)
        assert "anthropic-version" in flow.request.headers
        assert "anthropic-beta" in flow.request.headers
        assert "x-stainless-lang" in flow.request.headers


class TestAuditLogging:
    def setup_method(self):
        self.addon = _load_addon()
        self.injector = self.addon.addons[0]

    def test_response_logs_audit(self):
        flow = _make_flow(method="GET", host="example.com", path="/test")
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.content = b"hello"
        flow.response.headers = {}

        with patch.object(self.addon.log, "info") as mock_log:
            self.injector.response(flow)
            audit_calls = [
                c for c in mock_log.call_args_list if "proxy_audit" in str(c)
            ]
            assert len(audit_calls) == 1

    def test_audit_log_includes_method_and_host(self):
        flow = _make_flow(method="POST", host="api.anthropic.com", path="/v1/messages")
        flow.response = MagicMock()
        flow.response.status_code = 200
        flow.response.content = b"response"
        flow.response.headers = {}

        with patch.object(self.addon.log, "info") as mock_log:
            self.injector.response(flow)
            audit_calls = [
                c for c in mock_log.call_args_list if "proxy_audit" in str(c)
            ]
            assert len(audit_calls) == 1
            call_str = str(audit_calls[0])
            assert "POST" in call_str
            assert "api.anthropic.com" in call_str
