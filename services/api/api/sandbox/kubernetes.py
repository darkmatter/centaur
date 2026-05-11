"""Kubernetes sandbox backend — runs agent sandboxes as Pods."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from aiohttp import WSMsgType
from kubernetes_asyncio import client, config
from kubernetes_asyncio.config.config_exception import ConfigException
from kubernetes_asyncio.stream import WsApiClient
from kubernetes_asyncio.stream.ws_client import (
    ERROR_CHANNEL,
    STDERR_CHANNEL,
    STDIN_CHANNEL,
    STDOUT_CHANNEL,
)
import structlog

from api.firewall import secrets_headers, secrets_url
from api.sandbox.base import SandboxBackend, SandboxSession
from api.sandbox.config import (
    agent_local_dev_enabled,
    build_harness_cmd,
    container_env,
    image,
    runtime_for_session,
)

log = structlog.get_logger()

_READY_TIMEOUT_S = int(os.getenv("KUBERNETES_SANDBOX_READY_TIMEOUT_S", "60"))
_ATTACH_LOG_TAIL_LINES = int(os.getenv("KUBERNETES_ATTACH_LOG_TAIL_LINES", "200"))
_CONTAINER_NAME = "sandbox"
_AGENT_UID = 1001
_SANDBOX_OVERLAY_ROOT = "/home/agent/overlay"
_SANDBOX_OVERLAY_DIR = f"{_SANDBOX_OVERLAY_ROOT}/org"
_PROXY_LABEL = "centaur.ai/iron-proxy"


def _get_rt(session: SandboxSession):
    return runtime_for_session(session)


def _repo_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "services" / "sandbox" / "SYSTEM_PROMPT.md").is_file():
            return candidate
    raise FileNotFoundError("could not locate services/sandbox/SYSTEM_PROMPT.md")


def _overlay_root() -> Path | None:
    value = (os.getenv("CENTAUR_OVERLAY_DIR") or "").strip()
    if not value:
        return None
    path = Path(value)
    return path if path.exists() else None


def _namespace() -> str:
    configured = (
        os.getenv("KUBERNETES_NAMESPACE") or os.getenv("POD_NAMESPACE") or ""
    ).strip()
    if configured:
        return configured
    namespace_path = Path("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
    if namespace_path.is_file():
        return namespace_path.read_text().strip()
    return "default"


def _image_pull_policy() -> str:
    return (os.getenv("KUBERNETES_AGENT_IMAGE_PULL_POLICY") or "IfNotPresent").strip()


def _runtime_class_name() -> str | None:
    value = (os.getenv("KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME") or "").strip()
    return value or None


def _service_account_name() -> str | None:
    value = (os.getenv("KUBERNETES_SANDBOX_SERVICE_ACCOUNT_NAME") or "").strip()
    return value or None


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    return int(raw) if raw else default


def _proxy_port() -> int:
    return _env_int("KUBERNETES_IRON_PROXY_PORT", 8080)


def _proxy_management_port() -> int:
    return _env_int("KUBERNETES_IRON_PROXY_MANAGEMENT_PORT", 9092)


def _proxy_health_port() -> int:
    return _env_int("KUBERNETES_IRON_PROXY_HEALTH_PORT", 9090)


def _proxy_manager_port() -> int:
    return _env_int("KUBERNETES_FIREWALL_MANAGER_PORT", 8081)


def _proxy_image() -> str:
    return os.getenv("KUBERNETES_IRON_PROXY_IMAGE", "centaur-iron-proxy:latest")


def _proxy_image_pull_policy() -> str:
    return (
        os.getenv("KUBERNETES_IRON_PROXY_IMAGE_PULL_POLICY") or _image_pull_policy()
    ).strip()


def _proxy_manager_image() -> str:
    return os.getenv(
        "KUBERNETES_FIREWALL_MANAGER_IMAGE", "centaur-firewall-manager:latest"
    )


def _proxy_manager_image_pull_policy() -> str:
    return (
        os.getenv("KUBERNETES_FIREWALL_MANAGER_IMAGE_PULL_POLICY")
        or _image_pull_policy()
    ).strip()


def _secret_env_name() -> str:
    value = (os.getenv("KUBERNETES_SECRET_ENV_NAME") or "").strip()
    if not value:
        raise ValueError("KUBERNETES_SECRET_ENV_NAME is required for per-sandbox proxy")
    return value


def _bootstrap_secret_name() -> str:
    return (os.getenv("KUBERNETES_BOOTSTRAP_SECRET_NAME") or "").strip()


def _secret_env_key(name: str) -> str:
    return f"{os.getenv('KUBERNETES_SECRET_ENV_PREFIX', '')}{name}"


def _api_pod_match_labels() -> dict[str, str]:
    return _parse_match_labels(
        os.getenv(
            "KUBERNETES_API_POD_LABEL_SELECTOR", "app.kubernetes.io/component=api"
        )
    )


def _secrets_pod_match_labels() -> dict[str, str]:
    return _parse_match_labels(
        os.getenv(
            "KUBERNETES_SECRETS_POD_LABEL_SELECTOR",
            "app.kubernetes.io/component=secrets",
        )
    )


def _parse_match_labels(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        key, sep, value = item.partition("=")
        if not sep:
            raise ValueError(
                f"invalid label selector item {item!r}; expected key=value"
            )
        result[key.strip()] = value.strip()
    return result


def _repos_path() -> str | None:
    value = (os.getenv("REPOS_PATH") or "").strip()
    return value or None


def _overlay_image() -> str | None:
    value = (os.getenv("CENTAUR_OVERLAY_IMAGE") or "").strip()
    return value or None


def _overlay_image_pull_policy() -> str:
    value = (os.getenv("CENTAUR_OVERLAY_IMAGE_PULL_POLICY") or "").strip()
    return value or _image_pull_policy()


def _overlay_image_source_path() -> str:
    value = (os.getenv("CENTAUR_OVERLAY_IMAGE_SOURCE_PATH") or "/overlay").strip()
    return value or "/overlay"


def _image_pull_secrets() -> list[dict[str, str]]:
    raw = (os.getenv("KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS") or "").strip()
    if not raw:
        return []
    return [{"name": item.strip()} for item in raw.split(",") if item.strip()]


def _firewall_ca_secret_name() -> str:
    value = (os.getenv("KUBERNETES_FIREWALL_CA_SECRET_NAME") or "").strip()
    if not value:
        raise ValueError(
            "KUBERNETES_FIREWALL_CA_SECRET_NAME is required for kubernetes backend"
        )
    return value


def _firewall_ca_key_secret_name() -> str:
    value = (os.getenv("KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME") or "").strip()
    if not value:
        raise ValueError(
            "KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME is required for per-sandbox proxy"
        )
    return value


def _required_runtime_secret_keys() -> list[str]:
    raw = os.getenv("REQUIRED_RUNTIME_SECRET_KEYS", "AMP_API_KEY")
    keys: list[str] = []
    for token in raw.split(","):
        key = token.strip()
        if key and key not in keys:
            keys.append(key)
    return keys


async def _fetch_runtime_secret_values(keys: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    if not keys:
        return values
    async with httpx.AsyncClient(timeout=5.0) as client:
        for key in keys:
            url = f"{secrets_url()}/secrets/{quote(key, safe='')}"
            response = await client.get(url, headers=secrets_headers())
            if response.status_code != 200:
                continue
            try:
                payload = response.json()
            except Exception:
                continue
            value = payload.get("value")
            if isinstance(value, str) and value:
                values[key] = value
    return values


async def _runtime_secret_values_for_sandbox() -> dict[str, str]:
    if agent_local_dev_enabled():
        return {}

    required_keys = _required_runtime_secret_keys()
    if not required_keys:
        return {}

    values = await _fetch_runtime_secret_values(required_keys)
    missing = [key for key in required_keys if not values.get(key)]
    if missing:
        raise RuntimeError(
            "runtime credentials unavailable for sandbox: "
            f"missing_keys={','.join(missing)}"
        )
    return values


def _resource_name(prefix: str, raw: str, *, max_length: int = 63) -> str:
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    normalized = re.sub(r"[^a-z0-9-]+", "-", raw.lower()).strip("-") or "session"
    budget = max_length - len(prefix) - len(digest) - 2
    trimmed = normalized[: max(budget, 1)].strip("-") or "session"
    return f"{prefix}-{trimmed}-{digest}"


def _prompt_secret_name(pod_name: str) -> str:
    base = pod_name[: 63 - len("-cfg")].rstrip("-") or "centaur-centaur-sandbox"
    return f"{base}-cfg"


def _proxy_pod_name(sandbox_id: str) -> str:
    return _resource_name("centaur-centaur-proxy", sandbox_id)


def _proxy_service_name(sandbox_id: str) -> str:
    return _resource_name("centaur-centaur-proxy", sandbox_id)


def _sandbox_egress_policy_name(sandbox_id: str) -> str:
    return _resource_name("centaur-centaur-sbx-egress", sandbox_id)


def _proxy_policy_name(sandbox_id: str) -> str:
    return _resource_name("centaur-centaur-proxy-net", sandbox_id)


def _local_dev_mode() -> bool:
    return os.getenv("AGENT_LOCAL_DEV", "").strip().lower() in {"1", "true"}


def _ensure_kubernetes_env() -> None:
    if _local_dev_mode():
        return
    if not (os.getenv("AGENT_API_URL") or "").strip():
        raise ValueError("AGENT_API_URL is required for kubernetes backend")


def _pod_resources() -> dict[str, Any]:
    limits: dict[str, str] = {}
    cpu_limit = os.environ.get("KUBERNETES_SANDBOX_CPU_LIMIT")
    memory_limit = os.environ.get("KUBERNETES_SANDBOX_MEMORY_LIMIT")
    if cpu_limit is None:
        limits["cpu"] = "2"
    elif cpu_limit.strip():
        limits["cpu"] = cpu_limit.strip()
    if memory_limit is None:
        limits["memory"] = "4Gi"
    elif memory_limit.strip():
        limits["memory"] = memory_limit.strip()

    requests: dict[str, str] = {}
    cpu_request = (os.getenv("KUBERNETES_SANDBOX_CPU_REQUEST") or "").strip()
    memory_request = (os.getenv("KUBERNETES_SANDBOX_MEMORY_REQUEST") or "").strip()
    if cpu_request:
        requests["cpu"] = cpu_request
    if memory_request:
        requests["memory"] = memory_request

    resources: dict[str, Any] = {}
    if limits:
        resources["limits"] = limits
    if requests:
        resources["requests"] = requests
    return resources


def _prompt_bundle(persona: str | None) -> str:
    prompt = (_repo_root() / "services" / "sandbox" / "SYSTEM_PROMPT.md").read_text()

    overlay_root = _overlay_root()
    if overlay_root is not None:
        overlay_prompt = overlay_root / "services" / "sandbox" / "SYSTEM_PROMPT.md"
        if overlay_prompt.is_file():
            prompt += f"\n\n---\n\n{overlay_prompt.read_text()}"

    if persona:
        from api.app import get_tool_manager

        persona_info = get_tool_manager().get_persona(persona)
        if persona_info is not None:
            persona_prompt = persona_info.tool_dir / "PROMPT.md"
            if persona_prompt.is_file():
                prompt = re.sub(
                    r"^\|You are .*assistant.*$",
                    (
                        f"|You are running the **{persona}** persona. "
                        "See the persona overlay below for your identity and behavior."
                    ),
                    prompt,
                    count=1,
                    flags=re.MULTILINE,
                )
                prompt += f"\n\n---\n\n{persona_prompt.read_text()}"
            else:
                log.warning(
                    "persona_prompt_missing", persona=persona, path=str(persona_prompt)
                )
        else:
            log.warning("persona_not_found_for_kubernetes_backend", persona=persona)

    return prompt


def _parse_ws_frame(data: bytes | str) -> tuple[int, str]:
    if isinstance(data, bytes):
        return data[0], data[1:].decode("utf-8", errors="replace")
    return ord(data[0]), data[1:]


def _disable_proxy_env(api_client: client.ApiClient | WsApiClient) -> None:
    # The API process routes outbound HTTPS through the firewall, but the
    # in-cluster Kubernetes client must talk directly to the apiserver.
    api_client.rest_client.pool_manager._trust_env = False


class KubernetesExecutorBackend(SandboxBackend):
    """Runs agent sandboxes as Kubernetes Pods."""

    def __init__(self) -> None:
        self._core: client.CoreV1Api | None = None
        self._networking: client.NetworkingV1Api | None = None
        self._ws_api_client: WsApiClient | None = None
        self._ws_core: client.CoreV1Api | None = None
        self._lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "kubernetes"

    @property
    def supports_warm_pool(self) -> bool:
        return True

    async def _ensure_clients(self) -> None:
        ready = (
            self._core is not None
            and self._networking is not None
            and self._ws_api_client is not None
            and self._ws_core is not None
        )
        if ready:
            return
        async with self._lock:
            ready = (
                self._core is not None
                and self._networking is not None
                and self._ws_api_client is not None
                and self._ws_core is not None
            )
            if ready:
                return
            kubeconfig = (os.getenv("KUBERNETES_KUBECONFIG") or "").strip()
            if kubeconfig:
                await config.load_kube_config(config_file=kubeconfig)
            else:
                try:
                    config.load_incluster_config()
                except ConfigException:
                    await config.load_kube_config()
            core_api_client = client.ApiClient(
                configuration=client.Configuration.get_default_copy()
            )
            _disable_proxy_env(core_api_client)
            self._core = client.CoreV1Api(api_client=core_api_client)
            self._networking = client.NetworkingV1Api(api_client=core_api_client)

            self._ws_api_client = WsApiClient(
                configuration=client.Configuration.get_default_copy(),
                heartbeat=30,
            )
            _disable_proxy_env(self._ws_api_client)
            self._ws_core = client.CoreV1Api(api_client=self._ws_api_client)

    def _core_api(self) -> client.CoreV1Api:
        if self._core is None:
            raise RuntimeError("kubernetes client not initialized")
        return self._core

    def _networking_api(self) -> client.NetworkingV1Api:
        if self._networking is None:
            raise RuntimeError("kubernetes client not initialized")
        return self._networking

    def _ws_core_api(self) -> client.CoreV1Api:
        if self._ws_core is None:
            raise RuntimeError("kubernetes websocket client not initialized")
        return self._ws_core

    def _ws_api(self) -> WsApiClient:
        if self._ws_api_client is None:
            raise RuntimeError("kubernetes websocket client not initialized")
        return self._ws_api_client

    @staticmethod
    def _is_not_found(exc: Exception) -> bool:
        return getattr(exc, "status", None) == 404

    async def _delete_prompt_secret(self, secret_name: str) -> None:
        try:
            await self._core_api().delete_namespaced_secret(secret_name, _namespace())
        except Exception as exc:
            if not self._is_not_found(exc):
                raise

    async def _delete_pod(self, pod_name: str) -> None:
        try:
            await self._core_api().delete_namespaced_pod(
                pod_name,
                _namespace(),
                grace_period_seconds=5,
            )
        except Exception as exc:
            if not self._is_not_found(exc):
                raise

    async def _delete_service(self, service_name: str) -> None:
        try:
            await self._core_api().delete_namespaced_service(service_name, _namespace())
        except Exception as exc:
            if not self._is_not_found(exc):
                raise

    async def _delete_network_policy(self, policy_name: str) -> None:
        try:
            await self._networking_api().delete_namespaced_network_policy(
                policy_name,
                _namespace(),
            )
        except Exception as exc:
            if not self._is_not_found(exc):
                raise

    async def _delete_proxy_resources(self, sandbox_id: str) -> None:
        await self._delete_pod(_proxy_pod_name(sandbox_id))
        await self._delete_service(_proxy_service_name(sandbox_id))
        await self._delete_network_policy(_sandbox_egress_policy_name(sandbox_id))
        await self._delete_network_policy(_proxy_policy_name(sandbox_id))

    async def _create_prompt_secret(
        self, secret_name: str, persona: str | None
    ) -> None:
        await self._delete_prompt_secret(secret_name)
        await self._core_api().create_namespaced_secret(
            _namespace(),
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {
                    "name": secret_name,
                    "labels": {
                        "centaur.ai/managed": "true",
                    },
                },
                "type": "Opaque",
                "stringData": {
                    "AGENTS_BASE.md": _prompt_bundle(persona),
                },
            },
        )

    async def _create_proxy_service(self, sandbox_id: str) -> None:
        service_name = _proxy_service_name(sandbox_id)
        await self._delete_service(service_name)
        await self._core_api().create_namespaced_service(
            _namespace(),
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {
                    "name": service_name,
                    "labels": {
                        _PROXY_LABEL: "true",
                        "centaur.ai/sandbox-id": sandbox_id,
                    },
                },
                "spec": {
                    "selector": {
                        _PROXY_LABEL: "true",
                        "centaur.ai/sandbox-id": sandbox_id,
                    },
                    "ports": [
                        {
                            "name": "proxy",
                            "port": _proxy_port(),
                            "targetPort": _proxy_port(),
                            "protocol": "TCP",
                        }
                    ],
                },
            },
        )

    async def _create_proxy_network_policies(self, sandbox_id: str) -> None:
        await self._delete_network_policy(_sandbox_egress_policy_name(sandbox_id))
        await self._delete_network_policy(_proxy_policy_name(sandbox_id))

        await self._networking_api().create_namespaced_network_policy(
            _namespace(),
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {
                    "name": _sandbox_egress_policy_name(sandbox_id),
                    "labels": {
                        "centaur.ai/sandbox-id": sandbox_id,
                    },
                },
                "spec": {
                    "podSelector": {
                        "matchLabels": {
                            "centaur.ai/managed": "true",
                            "centaur.ai/sandbox-id": sandbox_id,
                        }
                    },
                    "policyTypes": ["Egress"],
                    "egress": [
                        {
                            "to": [
                                {
                                    "podSelector": {
                                        "matchLabels": _api_pod_match_labels()
                                    }
                                }
                            ],
                            "ports": [{"protocol": "TCP", "port": 8000}],
                        },
                        {
                            "to": [
                                {
                                    "podSelector": {
                                        "matchLabels": {
                                            _PROXY_LABEL: "true",
                                            "centaur.ai/sandbox-id": sandbox_id,
                                        }
                                    }
                                }
                            ],
                            "ports": [{"protocol": "TCP", "port": _proxy_port()}],
                        },
                    ],
                },
            },
        )
        await self._networking_api().create_namespaced_network_policy(
            _namespace(),
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "NetworkPolicy",
                "metadata": {
                    "name": _proxy_policy_name(sandbox_id),
                    "labels": {
                        "centaur.ai/sandbox-id": sandbox_id,
                    },
                },
                "spec": {
                    "podSelector": {
                        "matchLabels": {
                            _PROXY_LABEL: "true",
                            "centaur.ai/sandbox-id": sandbox_id,
                        }
                    },
                    "policyTypes": ["Ingress", "Egress"],
                    "ingress": [
                        {
                            "from": [
                                {
                                    "podSelector": {
                                        "matchLabels": {
                                            "centaur.ai/managed": "true",
                                            "centaur.ai/sandbox-id": sandbox_id,
                                        }
                                    }
                                }
                            ],
                            "ports": [{"protocol": "TCP", "port": _proxy_port()}],
                        }
                    ],
                    "egress": [
                        {
                            "to": [
                                {
                                    "podSelector": {
                                        "matchLabels": _api_pod_match_labels()
                                    }
                                }
                            ],
                            "ports": [{"protocol": "TCP", "port": 8000}],
                        },
                        {
                            "to": [
                                {
                                    "podSelector": {
                                        "matchLabels": _secrets_pod_match_labels()
                                    }
                                }
                            ],
                            "ports": [{"protocol": "TCP", "port": 8100}],
                        },
                        {
                            "ports": [{"protocol": "TCP", "port": 443}],
                        },
                    ],
                },
            },
        )

    async def _create_proxy_pod(self, sandbox_id: str) -> None:
        proxy_pod_name = _proxy_pod_name(sandbox_id)
        secret_name = _secret_env_name()
        env_secret_ref = {"secretRef": {"name": secret_name}}
        env_from = [env_secret_ref]
        bootstrap_secret_name = _bootstrap_secret_name()
        if (
            os.getenv("KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE", "onepassword")
            == "onepassword"
            and bootstrap_secret_name
        ):
            env_from.append({"secretRef": {"name": bootstrap_secret_name}})
        secret_key_refs = {
            "FIREWALL_CONTROL_TOKEN": _secret_env_key("FIREWALL_CONTROL_TOKEN"),
            "SECRETS_AUTH_TOKEN": _secret_env_key("SECRETS_AUTH_TOKEN"),
            "IRON_MANAGEMENT_API_KEY": _secret_env_key("IRON_MANAGEMENT_API_KEY"),
        }
        manager_env = [
            {
                "name": env_name,
                "valueFrom": {
                    "secretKeyRef": {
                        "name": secret_name,
                        "key": secret_key,
                    }
                },
            }
            for env_name, secret_key in secret_key_refs.items()
        ]
        manager_env.extend(
            [
                {
                    "name": "SECRET_MANAGER_URL",
                    "value": os.getenv("SECRET_MANAGER_URL", "http://secrets:8100"),
                },
                {
                    "name": "IRON_PROXY_CONFIG_PATH",
                    "value": "/etc/iron-proxy/proxy.yaml",
                },
                {
                    "name": "IRON_PROXY_MANAGEMENT_URL",
                    "value": f"http://127.0.0.1:{_proxy_management_port()}",
                },
                {"name": "FIREWALL_MANAGER_PORT", "value": str(_proxy_manager_port())},
                {
                    "name": "FIREWALL_MANAGER_INJECTION_MAP_URL",
                    "value": (
                        os.getenv("KUBERNETES_FIREWALL_MANAGER_INJECTION_MAP_URL")
                        or f"{os.getenv('AGENT_API_URL', 'http://api:8000').rstrip('/')}/internal/injection-map"
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_POLL_INTERVAL_SECONDS",
                    "value": os.getenv(
                        "KUBERNETES_FIREWALL_MANAGER_POLL_INTERVAL_SECONDS", "30"
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_POLL_JITTER_SECONDS",
                    "value": os.getenv(
                        "KUBERNETES_FIREWALL_MANAGER_POLL_JITTER_SECONDS", "10"
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_STARTUP_BACKOFF_INITIAL_SECONDS",
                    "value": os.getenv(
                        "KUBERNETES_FIREWALL_MANAGER_STARTUP_BACKOFF_INITIAL_SECONDS",
                        "0.5",
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_STARTUP_BACKOFF_MAX_SECONDS",
                    "value": os.getenv(
                        "KUBERNETES_FIREWALL_MANAGER_STARTUP_BACKOFF_MAX_SECONDS", "5"
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_SECRET_SOURCE",
                    "value": os.getenv(
                        "KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE", "onepassword"
                    ),
                },
                {
                    "name": "FIREWALL_MANAGER_SECRET_TTL",
                    "value": os.getenv("KUBERNETES_FIREWALL_MANAGER_SECRET_TTL", "10m"),
                },
            ]
        )
        await self._delete_pod(proxy_pod_name)
        await self._core_api().create_namespaced_pod(
            _namespace(),
            {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {
                    "name": proxy_pod_name,
                    "labels": {
                        _PROXY_LABEL: "true",
                        "centaur.ai/sandbox-id": sandbox_id,
                    },
                },
                "spec": {
                    "automountServiceAccountToken": False,
                    "restartPolicy": "Never",
                    "imagePullSecrets": _image_pull_secrets(),
                    "containers": [
                        {
                            "name": "iron-proxy",
                            "image": _proxy_image(),
                            "imagePullPolicy": _proxy_image_pull_policy(),
                            "env": [
                                {
                                    "name": "IRON_MANAGEMENT_API_KEY",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": secret_name,
                                            "key": _secret_env_key(
                                                "IRON_MANAGEMENT_API_KEY"
                                            ),
                                        }
                                    },
                                }
                            ],
                            "envFrom": env_from,
                            "ports": [
                                {"containerPort": _proxy_port(), "name": "proxy"},
                                {
                                    "containerPort": _proxy_management_port(),
                                    "name": "management",
                                },
                                {
                                    "containerPort": _proxy_health_port(),
                                    "name": "health",
                                },
                            ],
                            "readinessProbe": {
                                "httpGet": {
                                    "path": "/healthz",
                                    "port": _proxy_health_port(),
                                },
                                "periodSeconds": 5,
                                "failureThreshold": 30,
                            },
                            "livenessProbe": {
                                "httpGet": {
                                    "path": "/healthz",
                                    "port": _proxy_health_port(),
                                }
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                                "seccompProfile": {"type": "RuntimeDefault"},
                            },
                            "volumeMounts": [
                                {
                                    "name": "iron-proxy-config",
                                    "mountPath": "/etc/iron-proxy",
                                },
                                {"name": "iron-proxy-certs", "mountPath": "/certs"},
                                {
                                    "name": "iron-proxy-ca",
                                    "mountPath": "/etc/iron-proxy-ca",
                                    "readOnly": True,
                                },
                            ],
                        },
                        {
                            "name": "firewall-manager",
                            "image": _proxy_manager_image(),
                            "imagePullPolicy": _proxy_manager_image_pull_policy(),
                            "env": manager_env,
                            "envFrom": env_from,
                            "ports": [
                                {
                                    "containerPort": _proxy_manager_port(),
                                    "name": "control",
                                }
                            ],
                            "readinessProbe": {
                                "httpGet": {
                                    "path": "/health/ready",
                                    "port": _proxy_manager_port(),
                                },
                                "periodSeconds": 5,
                                "failureThreshold": 30,
                            },
                            "livenessProbe": {
                                "httpGet": {
                                    "path": "/health",
                                    "port": _proxy_manager_port(),
                                }
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                                "seccompProfile": {"type": "RuntimeDefault"},
                            },
                            "volumeMounts": [
                                {
                                    "name": "iron-proxy-config",
                                    "mountPath": "/etc/iron-proxy",
                                },
                            ],
                        },
                    ],
                    "volumes": [
                        {"name": "iron-proxy-config", "emptyDir": {}},
                        {"name": "iron-proxy-certs", "emptyDir": {}},
                        {
                            "name": "iron-proxy-ca",
                            "secret": {"secretName": _firewall_ca_key_secret_name()},
                        },
                    ],
                },
            },
        )

    async def _wait_pod_ready(self, pod_name: str) -> float:
        deadline = time.monotonic() + _READY_TIMEOUT_S
        while time.monotonic() < deadline:
            pod = await self._core_api().read_namespaced_pod(pod_name, _namespace())
            phase = (pod.status.phase or "").lower()
            if phase in {"failed", "succeeded"}:
                raise RuntimeError(
                    f"pod exited before ready (pod={pod_name}, phase={phase})"
                )
            if phase == "running":
                conditions = pod.status.conditions or []
                if any(
                    (condition.type or "").lower() == "ready"
                    and (condition.status or "").lower() == "true"
                    for condition in conditions
                ):
                    return round(_READY_TIMEOUT_S - (deadline - time.monotonic()), 3)
            await asyncio.sleep(0.5)
        raise TimeoutError(
            f"pod readiness timed out after {_READY_TIMEOUT_S}s: {pod_name}"
        )

    async def _wait_ready(self, pod_name: str) -> float:
        deadline = time.monotonic() + _READY_TIMEOUT_S
        while time.monotonic() < deadline:
            pod = await self._core_api().read_namespaced_pod(pod_name, _namespace())
            phase = (pod.status.phase or "").lower()
            if phase in {"failed", "succeeded"}:
                raise RuntimeError(f"sandbox pod exited before ready (phase={phase})")
            if phase == "running":
                conditions = pod.status.conditions or []
                if any(
                    (condition.type or "").lower() == "ready"
                    and (condition.status or "").lower() == "true"
                    for condition in conditions
                ):
                    return round(_READY_TIMEOUT_S - (deadline - time.monotonic()), 3)
                try:
                    exit_code, _ = await self.exec_run(
                        pod_name,
                        ["test", "-f", "/home/agent/.ready"],
                    )
                    if exit_code == 0:
                        return round(
                            _READY_TIMEOUT_S - (deadline - time.monotonic()), 3
                        )
                except Exception:
                    pass
            await asyncio.sleep(0.5)
        raise TimeoutError(f"sandbox readiness timed out after {_READY_TIMEOUT_S}s")

    async def create(
        self,
        thread_key: str,
        harness: str,
        engine: str,
        *,
        persona: str | None = None,
        repo: str | None = None,
        warm: bool = False,
        model: str | None = None,
        resume_thread_id: str | None = None,
    ) -> SandboxSession:
        _ensure_kubernetes_env()
        await self._ensure_clients()

        repos_path = _repos_path()
        if repo and not repos_path:
            raise ValueError("REPOS_PATH is required when AGENT_REPO is set")

        pod_name = _resource_name("centaur-centaur-sandbox", thread_key)
        secret_name = _prompt_secret_name(pod_name)
        firewall_host = _proxy_service_name(pod_name)
        runtime_secret_values = await _runtime_secret_values_for_sandbox()
        env = container_env(
            thread_key,
            pod_name,
            resume_thread_id=resume_thread_id,
            firewall_host=firewall_host,
            runtime_secret_values=runtime_secret_values,
        )
        overlay_image = _overlay_image()
        if overlay_image:
            env.append(f"CENTAUR_OVERLAY_DIR={_SANDBOX_OVERLAY_DIR}")
        if persona:
            env.append(f"AGENT_PERSONA={persona}")
        if repo:
            env.append(f"AGENT_REPO={repo}")

        labels = {
            "centaur.ai/sandbox-id": pod_name,
            "centaur.ai/managed": "true",
            "centaur.ai/harness": re.sub(r"[^a-z0-9-]+", "-", harness.lower()),
            "centaur.ai/engine": re.sub(r"[^a-z0-9-]+", "-", engine.lower()),
        }
        if warm:
            labels["centaur.ai/warm"] = "true"

        volume_mounts = [
            {
                "name": "firewall-ca",
                "mountPath": "/firewall-certs",
                "readOnly": True,
            },
            {
                "name": "prompt-bundle",
                "mountPath": "/home/agent/AGENTS_BASE.md",
                "subPath": "AGENTS_BASE.md",
                "readOnly": True,
            },
        ]
        volumes = [
            {
                "name": "firewall-ca",
                "secret": {"secretName": _firewall_ca_secret_name()},
            },
            {
                "name": "prompt-bundle",
                "secret": {"secretName": secret_name},
            },
        ]
        init_containers: list[dict[str, Any]] = []

        if overlay_image:
            volume_mounts.append(
                {
                    "name": "overlay-root",
                    "mountPath": _SANDBOX_OVERLAY_ROOT,
                    "readOnly": True,
                }
            )
            volumes.append(
                {
                    "name": "overlay-root",
                    "emptyDir": {},
                }
            )
            init_containers.append(
                {
                    "name": "overlay-bootstrap",
                    "image": overlay_image,
                    "imagePullPolicy": _overlay_image_pull_policy(),
                    "command": [
                        "/bin/sh",
                        "-ec",
                        (
                            f'src="{_overlay_image_source_path()}"\n'
                            f'target="{_SANDBOX_OVERLAY_DIR}"\n'
                            'mkdir -p "$target"\n'
                            'cp -R "$src"/. "$target"/'
                        ),
                    ],
                    "volumeMounts": [
                        {
                            "name": "overlay-root",
                            "mountPath": _SANDBOX_OVERLAY_ROOT,
                        }
                    ],
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                        "runAsGroup": _AGENT_UID,
                        "runAsNonRoot": True,
                        "runAsUser": _AGENT_UID,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                }
            )

        if repos_path:
            volume_mounts.append(
                {
                    "name": "repos",
                    "mountPath": "/home/agent/github",
                    "readOnly": True,
                }
            )
            volumes.append(
                {
                    "name": "repos",
                    "hostPath": {
                        "path": repos_path,
                        "type": "Directory",
                    },
                }
            )

        cmd = build_harness_cmd(engine, model)

        pod_spec: dict[str, Any] = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": pod_name,
                "labels": labels,
                "annotations": {
                    "centaur.ai/thread-key": thread_key,
                    "centaur.ai/harness": harness,
                    "centaur.ai/engine": engine,
                },
            },
            "spec": {
                "automountServiceAccountToken": False,
                "restartPolicy": "Never",
                "initContainers": init_containers,
                "containers": [
                    {
                        "name": _CONTAINER_NAME,
                        "image": image(),
                        "imagePullPolicy": _image_pull_policy(),
                        "args": cmd,
                        "stdin": True,
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "capabilities": {"drop": ["ALL"]},
                            "runAsGroup": _AGENT_UID,
                            "runAsNonRoot": True,
                            "runAsUser": _AGENT_UID,
                            "seccompProfile": {"type": "RuntimeDefault"},
                        },
                        "tty": False,
                        "workingDir": "/home/agent",
                        "env": [
                            {
                                "name": item.split("=", 1)[0],
                                "value": item.split("=", 1)[1],
                            }
                            for item in env
                        ],
                        "resources": _pod_resources(),
                        "volumeMounts": volume_mounts,
                    }
                ],
                "volumes": volumes,
            },
        }

        runtime_class_name = _runtime_class_name()
        if runtime_class_name:
            pod_spec["spec"]["runtimeClassName"] = runtime_class_name
        image_pull_secrets = _image_pull_secrets()
        if image_pull_secrets:
            pod_spec["spec"]["imagePullSecrets"] = image_pull_secrets
        service_account_name = _service_account_name()
        if service_account_name:
            pod_spec["spec"]["serviceAccountName"] = service_account_name

        await self._delete_pod(pod_name)
        await self._delete_proxy_resources(pod_name)
        try:
            await self._create_prompt_secret(secret_name, persona)
            await self._create_proxy_service(pod_name)
            await self._create_proxy_network_policies(pod_name)
            await self._create_proxy_pod(pod_name)
            await self._wait_pod_ready(_proxy_pod_name(pod_name))
            await self._core_api().create_namespaced_pod(_namespace(), pod_spec)
            await self._wait_ready(pod_name)
        except BaseException:
            # Catch BaseException so asyncio.CancelledError (e.g. from
            # wait_for timing out around create()) still triggers cleanup;
            # otherwise the partially created pod, proxy pod, service,
            # network policies, and prompt secret leak.
            with contextlib.suppress(Exception):
                await self._delete_pod(pod_name)
            with contextlib.suppress(Exception):
                await self._delete_proxy_resources(pod_name)
            with contextlib.suppress(Exception):
                await self._delete_prompt_secret(secret_name)
            raise

        session = SandboxSession(
            sandbox_id=pod_name,
            thread_key=thread_key,
            harness=harness,
            engine=engine,
            started_at=time.time(),
            backend_name=self.name,
        )
        log.info(
            "sandbox_spawned",
            thread_key=thread_key,
            sandbox=pod_name,
            harness=harness,
            engine=engine,
            warm=warm,
            backend=self.name,
            per_sandbox_proxy=True,
        )
        return session

    async def attach(self, session: SandboxSession, *, logs: bool = False) -> None:
        await self._ensure_clients()
        rt = _get_rt(session)
        if rt.prefetched_stdout is None:
            rt.prefetched_stdout = []
        if logs:
            with contextlib.suppress(Exception):
                history = await self._core_api().read_namespaced_pod_log(
                    session.sandbox_id,
                    _namespace(),
                    container=_CONTAINER_NAME,
                    tail_lines=_ATTACH_LOG_TAIL_LINES,
                )
                rt.prefetched_stdout = [
                    line for line in history.splitlines() if line.strip()
                ]
        if (
            rt.stdout_stream is not None
            and rt.stdin_stream is not None
            and rt.attach_context is not None
        ):
            return
        attach_ctx = await self._ws_core_api().connect_get_namespaced_pod_attach(
            session.sandbox_id,
            _namespace(),
            container=_CONTAINER_NAME,
            stdin=True,
            stdout=True,
            stderr=False,
            tty=False,
            _preload_content=False,
        )
        websocket = await attach_ctx.__aenter__()
        rt.attach_context = attach_ctx
        rt.stdout_stream = websocket
        rt.stdin_stream = websocket
        log.info(
            "sandbox_attached",
            thread_key=session.thread_key,
            sandbox=session.sandbox_id,
            harness=session.harness,
            engine=session.engine,
            logs=logs,
            backend=self.name,
        )

    async def write_stdin(self, session: SandboxSession, obj: dict) -> None:
        rt = _get_rt(session)
        if rt.stdin_stream is None:
            raise RuntimeError("not attached (stdin)")
        payload = json.dumps(obj, separators=(",", ":")) + "\n"
        await rt.stdin_stream.send_bytes(
            bytes([STDIN_CHANNEL]) + payload.encode("utf-8")
        )
        log.info(
            "sandbox_stdin_write",
            thread_key=session.thread_key,
            sandbox=session.sandbox_id,
            harness=session.harness,
            engine=session.engine,
            payload_size_bytes=len(payload.encode("utf-8")),
            backend=self.name,
        )

    async def stream_stdout(self, session: SandboxSession) -> AsyncIterator[str]:
        rt = _get_rt(session)
        if rt.stdout_read_lock.locked():
            log.warning(
                "sandbox_stdout_stream_already_active",
                thread_key=session.thread_key,
                sandbox=session.sandbox_id,
                harness=session.harness,
                engine=session.engine,
                backend=self.name,
            )

        async with rt.stdout_read_lock:
            async for line in self._stream_stdout_unlocked(session):
                yield line

    async def _stream_stdout_unlocked(self, session: SandboxSession) -> AsyncIterator[str]:
        rt = _get_rt(session)
        if rt.stdout_stream is None:
            raise RuntimeError("not attached (stdout)")

        if rt.prefetched_stdout:
            prefetched = list(rt.prefetched_stdout)
            rt.prefetched_stdout.clear()
            for line in prefetched:
                yield line

        buf = ""
        while True:
            msg = await rt.stdout_stream.receive()
            if msg.type in {WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED}:
                break
            if msg.type not in {WSMsgType.BINARY, WSMsgType.TEXT}:
                continue
            channel, payload = _parse_ws_frame(msg.data)
            if channel == ERROR_CHANNEL:
                if payload.strip():
                    log.warning(
                        "kubernetes_attach_error_frame",
                        thread_key=session.thread_key,
                        sandbox=session.sandbox_id,
                        payload=payload[:200],
                    )
                continue
            if channel != STDOUT_CHANNEL:
                continue
            buf += payload
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                stripped = line.strip()
                if stripped:
                    yield stripped

    async def stop(self, session: SandboxSession) -> None:
        await self.close_streams(session)
        await self.stop_by_id(session.sandbox_id)
        log.info(
            "sandbox_stopped",
            thread_key=session.thread_key,
            sandbox=session.sandbox_id,
            reason="explicit_stop",
            backend=self.name,
        )

    async def status(self, session: SandboxSession) -> str:
        return await self.status_by_id(session.sandbox_id)

    async def status_by_id(self, sandbox_id: str) -> str:
        await self._ensure_clients()
        try:
            pod = await self._core_api().read_namespaced_pod(sandbox_id, _namespace())
        except Exception as exc:
            if self._is_not_found(exc):
                return "gone"
            raise
        if (
            getattr(getattr(pod, "metadata", None), "deletion_timestamp", None)
            is not None
        ):
            return "stopped"
        phase = (pod.status.phase or "").lower()
        if phase == "running":
            return "running"
        if phase == "pending":
            return "created"
        if phase in {"succeeded", "failed"}:
            return "stopped"
        return phase or "unknown"

    async def stop_by_id(self, sandbox_id: str) -> None:
        await self._ensure_clients()
        await self._delete_pod(sandbox_id)
        await self._delete_prompt_secret(_prompt_secret_name(sandbox_id))
        await self._delete_proxy_resources(sandbox_id)

    async def interrupt_by_id(self, sandbox_id: str) -> None:
        with contextlib.suppress(Exception):
            await self.exec_run(sandbox_id, ["kill", "-USR1", "1"])

    async def close_streams(self, session: SandboxSession) -> None:
        rt = _get_rt(session)
        if rt.attach_context is not None:
            with contextlib.suppress(Exception):
                await rt.attach_context.__aexit__(None, None, None)
            rt.attach_context = None
        rt.stdout_stream = None
        rt.stdin_stream = None

    async def exec_run(
        self,
        sandbox_id: str,
        cmd: list[str],
        *,
        environment: dict | None = None,
        user: str = "",
    ) -> tuple[int, bytes]:
        await self._ensure_clients()
        if user and user != "agent":
            raise NotImplementedError(
                "kubernetes backend only supports execs as the default agent user"
            )

        command = list(cmd)
        if environment:
            command = [
                "env",
                *[f"{key}={value}" for key, value in environment.items()],
                *command,
            ]

        websocket_ctx = await self._ws_core_api().connect_get_namespaced_pod_exec(
            sandbox_id,
            _namespace(),
            command=command,
            container=_CONTAINER_NAME,
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
            _preload_content=False,
        )
        output_parts: list[str] = []
        error_data = ""
        async with websocket_ctx as websocket:
            while True:
                msg = await websocket.receive()
                if msg.type in {WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED}:
                    break
                if msg.type not in {WSMsgType.BINARY, WSMsgType.TEXT}:
                    continue
                channel, payload = _parse_ws_frame(msg.data)
                if channel in {STDOUT_CHANNEL, STDERR_CHANNEL}:
                    output_parts.append(payload)
                elif channel == ERROR_CHANNEL:
                    error_data += payload
        exit_code = self._ws_api().parse_error_data(error_data) if error_data else 0
        return exit_code, "".join(output_parts).encode("utf-8")

    async def refresh_token_by_id(self, sandbox_id: str, new_token: str) -> None:
        exit_code, _ = await self.exec_run(
            sandbox_id,
            ["sh", "-c", 'printf "%s" "$TOKEN" > /home/agent/.api_key'],
            environment={"TOKEN": new_token},
            user="agent",
        )
        if exit_code != 0:
            log.warning(
                "sandbox_token_refresh_failed", sandbox=sandbox_id, exit_code=exit_code
            )

    async def recover_warm(self, pool_harness: str) -> list[SandboxSession]:
        await self._ensure_clients()
        sessions: list[SandboxSession] = []
        try:
            pod_list = await self._core_api().list_namespaced_pod(
                _namespace(),
                label_selector="centaur.ai/warm=true",
            )
        except Exception:
            return sessions

        for pod in getattr(pod_list, "items", []) or []:
            metadata = getattr(pod, "metadata", None)
            status = getattr(pod, "status", None)
            annotations = getattr(metadata, "annotations", None) or {}
            labels = getattr(metadata, "labels", None) or {}
            pod_name = getattr(metadata, "name", "") or ""
            thread_key = annotations.get("centaur.ai/thread-key", "")

            if not pod_name or not thread_key.startswith("warm-"):
                continue

            if getattr(metadata, "deletion_timestamp", None) is not None:
                with contextlib.suppress(Exception):
                    await self.stop_by_id(pod_name)
                continue

            phase = (getattr(status, "phase", "") or "").lower()
            if phase != "running":
                with contextlib.suppress(Exception):
                    await self.stop_by_id(pod_name)
                continue

            sessions.append(
                SandboxSession(
                    sandbox_id=pod_name,
                    thread_key="",
                    harness=annotations.get("centaur.ai/harness", pool_harness),
                    engine=annotations.get(
                        "centaur.ai/engine", labels.get("centaur.ai/engine", "amp")
                    ),
                    started_at=time.time(),
                    backend_name=self.name,
                )
            )
        return sessions

    async def rename_by_id(self, sandbox_id: str, new_name: str) -> None:
        raise NotImplementedError(
            f"{self.name} backend does not support renaming sandboxes ({sandbox_id} -> {new_name})"
        )


KubernetesSandboxBackend = KubernetesExecutorBackend
