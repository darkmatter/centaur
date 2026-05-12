# Apps API

Deploy and manage web applications on Centaur's infrastructure. Any app with a Git repo (Next.js, Python, static site, etc.) can be deployed and gets a public URL.

**Base URL:** `https://api.acme.com`

**Auth:** `X-Api-Key: $CENTAUR_API_KEY` or `Authorization: Bearer $CENTAUR_API_KEY`

---

## POST /apps

Deploy a new web app. Centaur clones the repo, builds it, and starts a container.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | URL-safe slug (lowercase, hyphens ok). Your app will be at `https://api.acme.com/apps/{name}/`. |
| `repo_url` | string | Yes | GitHub repository URL to clone and build. |
| `port` | int | Yes | Port your app listens on. |
| `build_cmd` | string | No | Custom build command. Default: `npm install && npm run build`. |
| `start_cmd` | string | No | Custom start command. Default: `npm start`. |
| `env` | object | No | Environment variables to inject into the container (JSON key-value pairs). |

:::note
All deployed apps are automatically password-protected behind Centaur's global basic auth. No per-app password configuration is needed.
:::

### Response

```json
{
  "name": "my-dashboard",
  "status": "building",
  "url": "https://api.acme.com/apps/my-dashboard/"
}
```

:::note
Apps deployed on Centaur's infrastructure are on the internal Docker network. They can reach the API at `http://api:8000` without an API key (localhost bypass).
:::

### Example

```bash
curl -s -X POST https://api.acme.com/apps \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "name": "my-dashboard",
    "repo_url": "https://github.com/myname/my-app",
    "port": 3000
  }'
```

---

## GET /apps

List all deployed apps.

### Example

```bash
curl -s https://api.acme.com/apps \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /apps/\{name\}

Get an app's current status and build logs.

### Example

```bash
curl -s https://api.acme.com/apps/my-dashboard \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /apps/\{name\}/logs

Get build and runtime logs for an app.

### Example

```bash
curl -s https://api.acme.com/apps/my-dashboard/logs \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## POST /apps/\{name\}/restart

Rebuild and restart an app from the latest commit on its repo.

### Example

```bash
curl -s -X POST https://api.acme.com/apps/my-dashboard/restart \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## DELETE /apps/\{name\}

Stop and remove a deployed app.

### Example

```bash
curl -s -X DELETE https://api.acme.com/apps/my-dashboard \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## Full Example: Deploy, Check, Restart, Delete

```bash
# 1. Deploy
curl -s -X POST https://api.acme.com/apps \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "name": "my-dashboard",
    "repo_url": "https://github.com/myname/my-app",
    "port": 3000,
    "env": {"API_URL": "http://api:8000"}
  }'

# 2. Check status
curl -s https://api.acme.com/apps/my-dashboard \
  -H "X-Api-Key: $CENTAUR_API_KEY"

# 3. Restart (rebuild from latest git)
curl -s -X POST https://api.acme.com/apps/my-dashboard/restart \
  -H "X-Api-Key: $CENTAUR_API_KEY"

# 4. Delete
curl -s -X DELETE https://api.acme.com/apps/my-dashboard \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

Your app is accessible at `https://api.acme.com/apps/my-dashboard/` once the build completes.
