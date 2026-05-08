"""Shared sandbox configuration helpers."""

from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

from api.deps import mint_sandbox_token
from api.sandbox.base import SandboxSession


def image() -> str:
    return os.getenv("AGENT_IMAGE", "centaur-agent:latest")


_HARNESS_STUB_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AMP_API_KEY", "GITHUB_TOKEN")


def agent_local_dev_enabled() -> bool:
    return os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")


def amp_mode() -> str:
    return (os.getenv("AMP_MODE") or "deep").strip() or "deep"


def amp_thread_visibility() -> str | None:
    value = (os.getenv("AMP_THREAD_VISIBILITY") or "").strip()
    return value or None


def build_harness_cmd(engine: str, model: str | None = None) -> list[str]:
    """Build the container CMD for a given harness engine."""
    if engine == "amp":
        return ["amp-wrapper"]
    if engine == "claude-code":
        cmd = [
            "claude",
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ]
        if model:
            cmd.extend(["--model", model])
        return cmd
    return ["sleep", "infinity"]


def container_env(
    thread_key: str,
    container_name: str,
    *,
    resume_thread_id: str | None = None,
) -> list[str]:
    """Build env vars for sandbox pods."""
    local_dev = agent_local_dev_enabled()

    api_key = mint_sandbox_token(thread_key, container_name)
    api_url = os.getenv("AGENT_API_URL", "http://api:8000")

    env = [
        f"CENTAUR_API_URL={api_url}",
        f"CENTAUR_API_KEY={api_key}",
        f"CENTAUR_THREAD_KEY={thread_key}",
        f"AMP_MODE={amp_mode()}",
    ]
    visibility = amp_thread_visibility()
    if visibility:
        env.append(f"AMP_THREAD_VISIBILITY={visibility}")
    if resume_thread_id:
        env.append(f"AMP_CONTINUE_THREAD_ID={resume_thread_id}")

    if local_dev:
        for key in _HARNESS_STUB_KEYS:
            real = os.getenv(key, "").strip()
            if real:
                env.append(f"{key}={real}")
    else:
        firewall_host = os.getenv("FIREWALL_HOST", "iron-proxy")
        no_proxy_hosts = ["localhost", "127.0.0.1", firewall_host]
        api_host = urlsplit(api_url).hostname
        if api_host:
            no_proxy_hosts.append(api_host)
        no_proxy = ",".join(dict.fromkeys(no_proxy_hosts))
        for key in _HARNESS_STUB_KEYS:
            env.append(f"{key}={key}")
        env.extend(
            [
                f"FIREWALL_HOST={firewall_host}",
                f"HTTPS_PROXY=http://{firewall_host}:8080",
                f"HTTP_PROXY=http://{firewall_host}:8080",
                f"https_proxy=http://{firewall_host}:8080",
                f"http_proxy=http://{firewall_host}:8080",
                f"NO_PROXY={no_proxy}",
                f"no_proxy={no_proxy}",
                "NODE_EXTRA_CA_CERTS=/firewall-certs/ca-cert.pem",
                "REQUESTS_CA_BUNDLE=/firewall-certs/ca-cert.pem",
                "SSL_CERT_FILE=/firewall-certs/ca-cert.pem",
                "GIT_SSL_CAINFO=/firewall-certs/ca-cert.pem",
            ]
        )

    raw_extra = (os.getenv("KUBERNETES_SANDBOX_EXTRA_ENV") or "").strip()
    if raw_extra:
        for item in json.loads(raw_extra):
            env.append(f"{item['name']}={item['value']}")

    return env


def runtime_for_session(session: SandboxSession):
    from api.agent import _get_runtime

    return _get_runtime(session.sandbox_id)
