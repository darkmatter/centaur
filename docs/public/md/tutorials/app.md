---
title: Build a Web App
description: Ship a human interface that talks to Centaur tools, agents, and workflows.
---

# Build a Web App

Centaur apps are ordinary web services deployed from Git repositories. Use them when humans need a focused interface on top of the control plane: dashboards, chat surfaces, approval queues, ops panels, or internal tools.

## App contract

| Requirement | Value |
|-------------|-------|
| Source | A Git repository Centaur can clone. |
| Runtime | Any process that listens on a port. |
| Deploy API | `POST /apps` with `name`, `repo_url`, and `port`. |
| Public URL | `https://<deployment>/apps/{name}/` or the deployment's app host pattern. |
| Internal API URL | `http://api:8000` from inside Centaur infrastructure. |

## The safest shape

Keep the browser away from API keys. Put Centaur calls behind a server route or Worker endpoint.

```diagram
╭─────────╮       ╭──────────────╮       ╭─────────────╮
│ Browser │──────▶│ App backend  │──────▶│ Centaur API │
╰─────────╯       │ keeps keys   │       ╰─────────────╯
                  ╰──────────────╯
```

## Minimal server route

This example proxies a direct tool call. The same pattern works for agent turns and workflows.

```ts
const API_URL = process.env.API_URL ?? 'https://api.acme.com'
const CENTAUR_API_KEY = process.env.CENTAUR_API_KEY ?? ''

async function centaur(path: string, body?: unknown) {
  const response = await fetch(`${API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(CENTAUR_API_KEY ? { 'x-api-key': CENTAUR_API_KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

export async function search(query: string) {
  return centaur('/tools/websearch/search', {
    query,
    num_results: 5,
  })
}
```

When the app runs inside Centaur, set `API_URL=http://api:8000` and leave `CENTAUR_API_KEY` empty unless your deployment requires app-specific auth.

## Agent chat route

An app that chats with an agent follows the same durable lifecycle as every other client:

```ts
export async function runTurn(message: string, threadKey = `web-${Date.now()}`) {
  const spawn = await centaur('/agent/spawn', {
    thread_key: threadKey,
    harness: 'amp',
  })

  await centaur('/agent/message', {
    thread_key: threadKey,
    assignment_generation: spawn.assignment_generation,
    role: 'user',
    parts: [{ type: 'text', text: message }],
  })

  const execution = await centaur('/agent/execute', {
    thread_key: threadKey,
    assignment_generation: spawn.assignment_generation,
    harness: 'amp',
    delivery: { platform: 'dev' },
  })

  return {
    threadKey,
    executionId: execution.execution_id,
    eventsPath: `/agent/threads/${encodeURIComponent(threadKey)}/events?execution_id=${execution.execution_id}&after_event_id=0`,
  }
}
```

Stream `eventsPath` from your backend to the browser as SSE or normalize it into your UI's preferred event format.

## Deploy the app

```bash
curl -s -X POST "https://api.acme.com/apps" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "name": "research-console",
    "repo_url": "https://github.com/your-org/research-console",
    "port": 3000,
    "env": {
      "API_URL": "http://api:8000"
    }
  }' | python3 -m json.tool
```

## Iterate

Push to the app repo, then restart the app to rebuild from the latest commit:

```bash
curl -s -X POST "https://api.acme.com/apps/research-console/restart" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

## Production checklist

- [ ] Browser never receives a Centaur API key.
- [ ] Server route handles non-2xx Centaur responses explicitly.
- [ ] Long-running agent turns expose reconnect or retry behavior.
- [ ] App listens on the port passed to `POST /apps`.
- [ ] Internal deploy uses `http://api:8000`.
- [ ] Logs are enough to debug build failures and failed Centaur calls.
