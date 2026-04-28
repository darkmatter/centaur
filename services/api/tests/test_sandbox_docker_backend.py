from __future__ import annotations

from pathlib import Path

import pytest

from api.sandbox.docker import (
    DockerSandboxBackend,
    _repo_host_dir,
    _resolve_host_bind_path,
)


class FakeContainer:
    def __init__(self, name: str, config: dict):
        self.name = name
        self.config = config
        self.id = f"{name}-id"

    async def start(self) -> None:
        return None

    async def delete(self, force: bool = False) -> None:  # noqa: ARG002
        return None

    async def show(self) -> dict:
        return {
            "Name": f"/{self.name}",
            "State": {"Status": "running"},
            "Config": {"Labels": self.config.get("Labels", {})},
        }


class FakeContainers:
    def __init__(self) -> None:
        self.by_name: dict[str, FakeContainer] = {}

    async def create_or_replace(self, name: str, config: dict) -> FakeContainer:
        container = FakeContainer(name, config)
        self.by_name[name] = container
        return container

    async def get(self, name: str) -> FakeContainer:
        if name not in self.by_name:
            raise RuntimeError(name)
        return self.by_name[name]


class FakeNetwork:
    def __init__(self) -> None:
        self.connections: list[dict[str, str]] = []

    async def connect(self, payload: dict[str, str]) -> None:
        self.connections.append(payload)


class FakeNetworks:
    def __init__(self) -> None:
        self.by_name: dict[str, FakeNetwork] = {}

    async def get(self, name: str) -> FakeNetwork:
        network = self.by_name.get(name)
        if network is None:
            network = FakeNetwork()
            self.by_name[name] = network
        return network


class FakeDockerClient:
    def __init__(self) -> None:
        self.containers = FakeContainers()
        self.networks = FakeNetworks()


def test_repo_host_dir_defaults_to_repo_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("REPO_HOST_DIR", raising=False)

    assert _repo_host_dir() == str(Path(__file__).resolve().parents[3])


@pytest.mark.asyncio
async def test_create_connects_dind_and_sandbox_to_egress(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = FakeDockerClient()
    backend = DockerSandboxBackend()
    backend._client = fake_client

    monkeypatch.setenv("AGENT_NETWORK", "centaur_agent_net")
    monkeypatch.setenv("AGENT_EGRESS_NETWORK", "centaur_agent_egress")
    monkeypatch.setenv("SANDBOX_DIND_ENABLED", "1")
    monkeypatch.setattr("api.sandbox.docker.mint_sandbox_token", lambda *_args, **_kwargs: "sandbox-token")

    async def fake_wait_ready(*_args, **_kwargs) -> float:
        return 0.01

    monkeypatch.setattr("api.sandbox.docker._wait_ready", fake_wait_ready)

    session = await backend.create("C123:1.2", "amp", "amp")

    egress = fake_client.networks.by_name["centaur_agent_egress"]
    connected_ids = {call["Container"] for call in egress.connections}
    assert session.sandbox_id in connected_ids
    assert any(container_id.startswith("centaur-dind-") for container_id in connected_ids)


@pytest.mark.asyncio
async def test_create_skips_dind_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = FakeDockerClient()
    backend = DockerSandboxBackend()
    backend._client = fake_client

    monkeypatch.setattr("api.sandbox.docker.mint_sandbox_token", lambda *_args, **_kwargs: "sandbox-token")

    async def fake_wait_ready(*_args, **_kwargs) -> float:
        return 0.01

    monkeypatch.setattr("api.sandbox.docker._wait_ready", fake_wait_ready)

    await backend.create("C123:1.2", "amp", "amp")

    assert not any(name.startswith("centaur-dind-") for name in fake_client.containers.by_name)


@pytest.mark.asyncio
async def test_create_mounts_centaur_skills_when_present(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    fake_client = FakeDockerClient()
    backend = DockerSandboxBackend()
    backend._client = fake_client

    repo_root = tmp_path / "centaur"
    skills_dir = repo_root / ".agents" / "skills"
    skills_dir.mkdir(parents=True)
    (repo_root / "services" / "sandbox").mkdir(parents=True)
    (repo_root / "services" / "sandbox" / "SYSTEM_PROMPT.md").write_text("prompt")

    monkeypatch.setenv("REPO_HOST_DIR", str(repo_root))
    monkeypatch.setattr("api.sandbox.docker.mint_sandbox_token", lambda *_args, **_kwargs: "sandbox-token")

    async def fake_wait_ready(*_args, **_kwargs) -> float:
        return 0.01

    monkeypatch.setattr("api.sandbox.docker._wait_ready", fake_wait_ready)

    await backend.create("C123:1.2", "amp", "amp")

    sandbox = next(
        container
        for name, container in fake_client.containers.by_name.items()
        if name.startswith("centaur-sandbox-")
    )
    binds = sandbox.config["HostConfig"]["Binds"]
    assert f"{skills_dir}:/home/agent/centaur-skills:ro" in binds


@pytest.mark.asyncio
async def test_create_hardens_sandbox_container(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = FakeDockerClient()
    backend = DockerSandboxBackend()
    backend._client = fake_client

    monkeypatch.setattr("api.sandbox.docker.mint_sandbox_token", lambda *_args, **_kwargs: "sandbox-token")

    async def fake_wait_ready(*_args, **_kwargs) -> float:
        return 0.01

    monkeypatch.setattr("api.sandbox.docker._wait_ready", fake_wait_ready)

    await backend.create("C123:1.2", "amp", "amp")

    sandbox = next(
        container
        for name, container in fake_client.containers.by_name.items()
        if name.startswith("centaur-sandbox-")
    )
    env = dict(item.split("=", 1) for item in sandbox.config["Env"])

    assert env["AMP_API_KEY"] == "AMP_API_KEY"
    assert sandbox.config["User"] == "1001:1001"
    assert sandbox.config["HostConfig"]["CapDrop"] == ["ALL"]
    assert sandbox.config["HostConfig"]["SecurityOpt"] == ["no-new-privileges"]


def test_resolve_host_bind_path_prefers_overlay_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    repo_root = tmp_path / "centaur"
    overlay_root = tmp_path / "centaur-overlay"

    monkeypatch.setenv("REPO_HOST_DIR", str(repo_root))
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", "/app/overlay/org")
    monkeypatch.setenv("CENTAUR_OVERLAY_HOST_DIR", str(overlay_root))

    resolved = _resolve_host_bind_path(Path("/app/overlay/org/tools/personas/legal"))

    assert resolved == str(overlay_root / "tools" / "personas" / "legal")


@pytest.mark.asyncio
async def test_create_mounts_overlay_skills_and_prompt_when_present(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    fake_client = FakeDockerClient()
    backend = DockerSandboxBackend()
    backend._client = fake_client

    repo_root = tmp_path / "centaur"
    skills_dir = repo_root / ".agents" / "skills"
    skills_dir.mkdir(parents=True)
    (repo_root / "services" / "sandbox").mkdir(parents=True)
    (repo_root / "services" / "sandbox" / "SYSTEM_PROMPT.md").write_text("prompt")

    overlay_root = tmp_path / "centaur-overlay"
    overlay_skills_dir = overlay_root / ".agents" / "skills"
    overlay_skills_dir.mkdir(parents=True)
    overlay_prompt = overlay_root / "services" / "sandbox" / "SYSTEM_PROMPT.md"
    overlay_prompt.parent.mkdir(parents=True)
    overlay_prompt.write_text("overlay prompt")

    monkeypatch.setenv("REPO_HOST_DIR", str(repo_root))
    monkeypatch.setenv("CENTAUR_OVERLAY_HOST_DIR", str(overlay_root))
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", "/app/overlay/org")
    monkeypatch.setattr("api.sandbox.docker.mint_sandbox_token", lambda *_args, **_kwargs: "sandbox-token")

    async def fake_wait_ready(*_args, **_kwargs) -> float:
        return 0.01

    monkeypatch.setattr("api.sandbox.docker._wait_ready", fake_wait_ready)

    await backend.create("C123:1.2", "amp", "amp")

    sandbox = next(
        container
        for name, container in fake_client.containers.by_name.items()
        if name.startswith("centaur-sandbox-")
    )
    binds = sandbox.config["HostConfig"]["Binds"]
    env = dict(item.split("=", 1) for item in sandbox.config["Env"])
    assert f"{overlay_root}:/home/agent/overlay/org:ro" in binds
    assert f"{overlay_skills_dir}:/home/agent/centaur-overlay-skills:ro" in binds
    assert f"{overlay_prompt}:/home/agent/AGENTS_OVERLAY.md:ro" in binds
    assert env["CENTAUR_OVERLAY_DIR"] == "/home/agent/overlay/org"
