from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


MANAGER_PATH = Path(__file__).resolve().parents[2] / "firewall-manager" / "manager.py"


def load_manager(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FIREWALL_CONTROL_TOKEN", "control-token")
    monkeypatch.setenv("IRON_MANAGEMENT_API_KEY", "iron-token")
    monkeypatch.delenv(
        "FIREWALL_MANAGER_STARTUP_BACKOFF_INITIAL_SECONDS", raising=False
    )
    monkeypatch.delenv("FIREWALL_MANAGER_STARTUP_BACKOFF_MAX_SECONDS", raising=False)
    spec = importlib.util.spec_from_file_location(
        "firewall_manager_under_test", MANAGER_PATH
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    module.state = module.State()
    module._stop_event = module.threading.Event()
    return module


def test_firewall_manager_apply_skips_unchanged_map(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    calls: list[dict[str, list[str]]] = []

    monkeypatch.setattr(manager, "_render_config", lambda injection_map: "rendered")
    monkeypatch.setattr(manager, "_atomic_write", lambda _path, _content: None)
    monkeypatch.setattr(manager, "_trigger_iron_proxy_reload", lambda: calls.append({}))

    injection_map = {"api.openai.com": ["OPENAI_API_KEY"]}

    assert manager._apply_injection_map(injection_map) is True
    assert manager._apply_injection_map(injection_map) is False
    assert len(calls) == 1
    assert manager.state.ever_pushed is True
    assert manager.state.consecutive_failures == 0


def test_firewall_manager_force_apply_reloads_unchanged_map(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    reloads = 0

    monkeypatch.setattr(manager, "_render_config", lambda injection_map: "rendered")
    monkeypatch.setattr(manager, "_atomic_write", lambda _path, _content: None)

    def reload_proxy() -> None:
        nonlocal reloads
        reloads += 1

    monkeypatch.setattr(manager, "_trigger_iron_proxy_reload", reload_proxy)

    injection_map = {"api.openai.com": ["OPENAI_API_KEY"]}

    assert manager._apply_injection_map(injection_map) is True
    assert manager._apply_injection_map(injection_map, force=True) is True
    assert reloads == 2


def test_firewall_manager_fetches_and_normalizes_injection_map(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, list[str]]:
            return {
                "api.openai.com": ["OPENAI_API_KEY", "OPENAI_API_KEY"],
                "bad": [1, "KEY"],
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, *_args) -> None:
            return None

        def get(self, url: str) -> FakeResponse:
            assert url == manager.INJECTION_MAP_URL
            return FakeResponse()

    monkeypatch.setattr(manager.httpx, "Client", FakeClient)

    assert manager._fetch_injection_map() == {
        "api.openai.com": ["OPENAI_API_KEY"],
        "bad": ["KEY"],
    }


def test_firewall_manager_poll_failure_keeps_last_good_map(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    manager.state.last_map = {"api.openai.com": ["OPENAI_API_KEY"]}
    manager.state.ever_pushed = True

    def fail_render(_injection_map: dict[str, list[str]]) -> str:
        raise FileNotFoundError("missing config")

    monkeypatch.setattr(manager, "_render_config", fail_render)

    with pytest.raises(FileNotFoundError):
        manager._apply_injection_map({"api.anthropic.com": ["ANTHROPIC_API_KEY"]})

    assert manager.state.last_map == {"api.openai.com": ["OPENAI_API_KEY"]}
    assert manager.state.ever_pushed is True


def test_firewall_manager_startup_retry_delay_uses_capped_exponential_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    manager.STARTUP_BACKOFF_INITIAL_S = 0.5
    manager.STARTUP_BACKOFF_MAX_S = 5

    monkeypatch.setattr(manager.random, "uniform", lambda _low, _high: 0)

    assert manager._startup_retry_delay(1) == 0.5
    assert manager._startup_retry_delay(2) == 1
    assert manager._startup_retry_delay(3) == 2
    assert manager._startup_retry_delay(4) == 4
    assert manager._startup_retry_delay(5) == 5
    assert manager._startup_retry_delay(10) == 5


def test_firewall_manager_poll_loop_fetches_before_first_sleep(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    events: list[tuple[str, float | None]] = []

    class FakeStopEvent:
        def is_set(self) -> bool:
            return False

        def wait(self, delay: float) -> bool:
            events.append(("wait", delay))
            raise KeyboardInterrupt

    def fail_fetch() -> dict[str, list[str]]:
        events.append(("fetch", None))
        raise RuntimeError("api unavailable")

    monkeypatch.setattr(manager, "_fetch_injection_map", fail_fetch)
    monkeypatch.setattr(manager, "_stop_event", FakeStopEvent())
    monkeypatch.setattr(manager.random, "uniform", lambda _low, _high: 0)

    with pytest.raises(KeyboardInterrupt):
        manager._poll_loop()

    assert events == [("fetch", None), ("wait", 0.5)]


def test_firewall_manager_poll_loop_stops_without_fetching_when_stop_event_is_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    manager._stop_event.set()

    def unexpected_fetch() -> dict[str, list[str]]:
        raise AssertionError("poll loop should not fetch after stop event")

    monkeypatch.setattr(manager, "_fetch_injection_map", unexpected_fetch)

    manager._poll_loop()


def test_firewall_manager_routes_gcp_credential_to_gcp_auth_transform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)

    injection_map = {
        "api.openai.com": ["OPENAI_API_KEY"],
        "storage.googleapis.com": ["GCP_GCLOUD_CREDENTIAL"],
        "compute.googleapis.com": ["GCP_GCLOUD_CREDENTIAL"],
    }

    secrets = manager._build_secret_transform(injection_map)
    assert secrets is not None
    secret_keys = [s["proxy_value"] for s in secrets["config"]["secrets"]]
    assert secret_keys == ["OPENAI_API_KEY"]

    gcp_auth = manager._build_gcp_auth_transform(injection_map)
    assert gcp_auth == {
        "name": "gcp_auth",
        "config": {
            "keyfile": {"type": "env", "var": "GCP_GCLOUD_CREDENTIAL"},
            "scopes": list(manager.GCP_AUTH_SCOPES),
            "rules": [{"host": h} for h in manager.GCP_AUTH_HOSTS],
        },
    }


def test_firewall_manager_omits_gcp_auth_when_no_gcp_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = load_manager(monkeypatch)
    assert (
        manager._build_gcp_auth_transform({"api.openai.com": ["OPENAI_API_KEY"]})
        is None
    )


def test_firewall_manager_gcp_auth_keyfile_uses_onepassword_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FIREWALL_MANAGER_SECRET_SOURCE", "onepassword-connect")
    monkeypatch.setenv("OP_VAULT", "engineering")
    manager = load_manager(monkeypatch)

    gcp_auth = manager._build_gcp_auth_transform(
        {"storage.googleapis.com": ["GCP_GCLOUD_CREDENTIAL"]}
    )
    assert gcp_auth is not None
    assert gcp_auth["config"]["keyfile"] == {
        "type": "1password_connect",
        "secret_ref": "op://engineering/GCP_GCLOUD_CREDENTIAL/credential",
        "ttl": manager.SECRET_TTL,
    }


def test_firewall_manager_render_config_splices_both_transforms(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    manager = load_manager(monkeypatch)
    config_path = tmp_path / "proxy.yaml"
    config_path.write_text(
        "transforms:\n"
        "  - name: allowlist\n"
        "    config:\n"
        "      domains:\n"
        "        - '*'\n"
        "  - name: header_allowlist\n"
        "    config:\n"
        "      headers:\n"
        "        - host\n"
    )
    manager.IRON_PROXY_CONFIG_PATH = config_path

    rendered = manager._render_config(
        {
            "api.openai.com": ["OPENAI_API_KEY"],
            "storage.googleapis.com": ["GCP_GCLOUD_CREDENTIAL"],
        }
    )
    import yaml as _yaml

    cfg = _yaml.safe_load(rendered)
    names = [t["name"] for t in cfg["transforms"]]
    assert names == ["allowlist", "secrets", "gcp_auth", "header_allowlist"]

    # Re-rendering must replace, not duplicate, the managed transforms.
    config_path.write_text(rendered)
    rerendered = manager._render_config(
        {"storage.googleapis.com": ["GCP_GCLOUD_CREDENTIAL"]}
    )
    cfg2 = _yaml.safe_load(rerendered)
    names2 = [t["name"] for t in cfg2["transforms"]]
    assert names2 == ["allowlist", "gcp_auth", "header_allowlist"]
