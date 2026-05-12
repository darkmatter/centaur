---
title: Build a Tool
description: Add a Python API client that becomes discoverable REST methods for agents and apps.
---

# Build a Tool

Use a tool when Centaur needs a new capability: fetch data, write to an external system, query an internal service, or wrap a workflow-specific API. Once deployed, every public method becomes callable at `/tools/{name}/{method}`.

## File structure

```text
tools/hackernews/
├── __init__.py
├── client.py
└── pyproject.toml
```

## Minimal public API tool

`client.py`:

```python
"""Hacker News API client."""

from __future__ import annotations

import httpx


class HackerNewsClient:
    """Read Hacker News stories and items."""

    def top_stories(self, limit: int = 10) -> list[dict]:
        """Return the current top Hacker News stories."""
        limit = max(1, min(limit, 30))
        with httpx.Client(timeout=15) as client:
            ids_response = client.get("https://hacker-news.firebaseio.com/v0/topstories.json")
            ids_response.raise_for_status()
            story_ids = ids_response.json()[:limit]

            stories = []
            for story_id in story_ids:
                response = client.get(
                    f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json"
                )
                response.raise_for_status()
                story = response.json() or {}
                stories.append(
                    {
                        "id": story_id,
                        "title": story.get("title"),
                        "url": story.get("url"),
                        "score": story.get("score"),
                    }
                )
            return stories

    def item(self, item_id: int) -> dict:
        """Return one Hacker News item by ID."""
        with httpx.Client(timeout=15) as client:
            response = client.get(f"https://hacker-news.firebaseio.com/v0/item/{item_id}.json")
            response.raise_for_status()
            return response.json() or {}


def _client() -> HackerNewsClient:
    return HackerNewsClient()
```

`pyproject.toml`:

```toml
[project]
name = "hackernews"
description = "Hacker News API client for stories and items"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27.0"]

[tool.ai-v2]
module = "client.py"
```

## Tool rules

- `_client()` must return an instance of your client.
- Public methods become endpoints; methods beginning with `_` stay private.
- Method docstrings become discovery text for agents.
- Keep method parameters JSON-serializable and explicit.
- Raise or return clear errors; do not silently swallow upstream failures.
- Use `secret("NAME")` for credentials.

## Credentials

```python
from __future__ import annotations

import httpx
from centaur_sdk.tool_sdk import secret


class CrmClient:
    """Internal CRM lookup client."""

    def company(self, domain: str) -> dict:
        """Return CRM data for a company domain."""
        token = secret("CRM_API_TOKEN")
        response = httpx.get(
            "https://crm.example.com/company",
            params={"domain": domain},
            headers={"authorization": f"Bearer {token}"},
            timeout=15,
        )
        response.raise_for_status()
        return response.json()
```

Local development can set the same value as an environment variable. Production reads it from the configured secret-manager backend.

## Test locally

Run the client directly before involving Centaur:

```bash
python3 - <<'PY'
from tools.hackernews.client import _client

client = _client()
for story in client.top_stories(limit=3):
    print(story["score"], story["title"])
PY
```

Then verify the deployed surface:

```bash
curl -s "https://api.acme.com/tools/hackernews" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool

curl -s -X POST "https://api.acme.com/tools/hackernews/top_stories" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"limit":3}' | python3 -m json.tool
```

## Checklist

- [ ] `client.py` has top-level imports and `_client()`.
- [ ] Every public method has a docstring.
- [ ] Dependencies are declared in `pyproject.toml`.
- [ ] Secrets use `secret("NAME")` and are documented for deployment.
- [ ] Local method call succeeds with representative input.
- [ ] Deployed discovery and method call work through `/tools`.
