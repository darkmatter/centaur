"""1Password secret manager backend.

Fetches all items from a 1Password vault using the official SDK.
Requires ``OP_SERVICE_ACCOUNT_TOKEN`` in the environment.

Items are expected to follow a uniform schema: each item's title is the
canonical ENV_VAR name and the secret value lives on the ``credential``
field.  Items lacking a non-empty ``credential`` field are skipped.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from onepassword.client import Client

from secret_manager.backend import SecretEntry, SecretManagerBackend

log = logging.getLogger("secret_manager")

_CREDENTIAL_FIELD = "credential"

# items.get_all() supports up to 50 items per call.
_GET_ALL_BATCH = 50


def _extract_credential(item: Any) -> str | None:
    """Return the value of the ``credential`` field on an item, if any."""
    fields = getattr(item, "fields", []) or []
    for f in fields:
        if getattr(f, "id", "") == _CREDENTIAL_FIELD or getattr(
            f, "title", ""
        ).lower() == _CREDENTIAL_FIELD:
            value = getattr(f, "value", "")
            if value:
                return value
    return None


async def _list_vaults(client: Client) -> list[Any]:
    list_all = getattr(client.vaults, "list_all", None)
    if callable(list_all):
        vault_iter = await list_all()
        return [v async for v in vault_iter]
    return list(await client.vaults.list())


async def _list_items(client: Client, vault_id: str) -> list[Any]:
    list_all = getattr(client.items, "list_all", None)
    if callable(list_all):
        item_iter = await list_all(vault_id)
        return [item async for item in item_iter]
    return list(await client.items.list(vault_id))


async def _find_vault_id(client: Client, name: str) -> str:
    """Find a vault ID by name."""
    vaults = await _list_vaults(client)
    for v in vaults:
        title = getattr(v, "title", "")
        vid = getattr(v, "id", "")
        if title == name or vid == name:
            return v.id

    # If the service account only has access to one vault, prefer it.
    if len(vaults) == 1:
        only = vaults[0]
        log.warning(
            "vault '%s' not found; using only accessible vault '%s'",
            name,
            getattr(only, "title", getattr(only, "id", "<unknown>")),
        )
        return only.id

    available = ", ".join(str(getattr(v, "title", getattr(v, "id", "<unknown>"))) for v in vaults)
    raise RuntimeError(f"Vault '{name}' not found (available: {available})")


class OnePasswordBackend(SecretManagerBackend):
    """Load secrets from a 1Password vault via the SDK."""

    def __init__(self, vault_name: str | None = None) -> None:
        self._vault_name = vault_name or os.environ.get("OP_VAULT") or "ai-agents"
        self._client: Client | None = None

    async def _init_client(self) -> Client:
        token = os.environ.get("OP_SERVICE_ACCOUNT_TOKEN", "")
        if not token:
            raise RuntimeError("OP_SERVICE_ACCOUNT_TOKEN is not set")
        return await Client.authenticate(
            auth=token,
            integration_name="ai-v2-secret-manager",
            integration_version="1.0.0",
        )

    async def load_all(self) -> dict[str, SecretEntry]:
        if self._client is None:
            self._client = await self._init_client()

        vault_id = await _find_vault_id(self._client, self._vault_name)
        items = await _list_items(self._client, vault_id)

        overviews: list[str] = [
            getattr(o, "id", "") for o in items if getattr(o, "id", "")
        ]

        full_items: list[Any] = []
        for i in range(0, len(overviews), _GET_ALL_BATCH):
            batch_ids = overviews[i : i + _GET_ALL_BATCH]
            resp = await self._client.items.get_all(vault_id, batch_ids)
            for r in resp.individual_responses:
                if r.content is not None:
                    full_items.append(r.content)

        new_cache: dict[str, SecretEntry] = {}
        for item in full_items:
            title = getattr(item, "title", "")
            if not title:
                continue
            value = _extract_credential(item)
            if not value:
                log.debug("skipping item %s — no credential field", title)
                continue
            new_cache[title] = SecretEntry(value=value)

        log.info(
            "loaded %d keys from vault '%s': %s",
            len(new_cache),
            self._vault_name,
            ", ".join(sorted(new_cache.keys())),
        )
        return new_cache
