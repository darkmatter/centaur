---
title: Deploy on Bare Metal
description: Deploy Centaur on infrastructure you own using Docker Compose, Cloudflare Tunnel or host TLS, Slack webhooks, local storage, and scoped API keys.
---

# Deploy on Bare Metal

Use this guide when Centaur runs on infrastructure you own: a physical server,
colo host, private VM platform, or an internal data-center machine. This path
uses Docker Compose on one host. If you operate your own Kubernetes cluster,
use [Kubernetes + Iron Proxy](/ops/kubernetes) after adapting the provider
setup from the AWS/GCP guides.

## Step 1. Choose the host shape

| Area | Starting point |
|------|----------------|
| OS | Ubuntu Server 24.04 LTS. |
| CPU/RAM | 4 vCPU / 16 GB RAM minimum; more if many agents run concurrently. |
| Disk | 100 GB SSD minimum; prefer 250 GB+ for logs, images, Postgres, and sandboxes. |
| Network | Static public IP, NAT, or outbound-only Cloudflare Tunnel route from your edge. |
| DNS | `centaur.example.com` in Cloudflare DNS or pointed at your edge. |
| HTTPS edge | Cloudflare Tunnel for private hosts; host nginx + Certbot when the host has a public IP. |
| Secrets | 1Password for shared deployments; `.env` only for disposable/internal dev. |
| Database | Compose Postgres for first deploy; external Postgres for durable production. |

For the Cloudflare Tunnel path, the host only needs outbound HTTPS plus
locked-down SSH; do not open inbound HTTP or HTTPS. For the direct public-IP
path, expose only HTTP, HTTPS, and locked-down SSH at your network edge. Keep
Postgres, PgBouncer, Docker, Slackbot, Grafana, and the raw API container ports
private.

## Step 2. Prepare the machine

Install base packages:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq nginx snapd ufw
```

Lock down the host firewall for the Cloudflare Tunnel path:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 203.0.113.10/32 to any port 22 proto tcp
sudo ufw enable
sudo ufw status
```

If you are terminating TLS directly on the host with nginx and Certbot, also
open HTTP and HTTPS:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

Replace `203.0.113.10/32` with your office, VPN, or admin jump-host CIDR.

Install Docker Engine and the Compose plugin:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker

docker version
docker compose version
```

Reference: [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

Install Certbot if the host terminates TLS:

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
```

Reference: [Certbot instructions](https://certbot.eff.org/instructions?ws=nginx&os=snap).

## Step 3. Clone Centaur

```bash
mkdir -p ~/github/paradigmxyz
cd ~/github/paradigmxyz
git clone https://github.com/paradigmxyz/centaur.git
cd centaur
cp .env.example .env
```

Set the public edge variables in `.env`:

```bash
CENTAUR_NGINX_BIND_ADDRESS=127.0.0.1
CENTAUR_NGINX_HOST_PORT=8000
CENTAUR_NGINX_SERVER_NAME=centaur.example.com
CENTAUR_NGINX_ENABLED_SERVICES=slackbot,apps
CENTAUR_NGINX_APPS_DOMAIN=apps.example.com
```

Use `127.0.0.1` when host nginx or an internal reverse proxy terminates TLS and
forwards to Compose nginx. If your network edge terminates TLS elsewhere, point
that edge at this host's internal IP and keep the host firewall restricted to
that source.

For a Slack-only webhook edge, use:

```bash
CENTAUR_NGINX_ENABLED_SERVICES=slackbot
```

Add `apps` only when you want app subdomains through the same edge.

If external clients need the Agent, Tools, or Workflows API over the public
domain, add `api`:

```bash
CENTAUR_NGINX_ENABLED_SERVICES=slackbot,apps,api
```

Do not enable `admin` on a public internet route. Create admin keys on the host
or over a private network/VPN.

## Step 4. Configure secrets

For a shared deployment:

```bash
SECRET_MANAGER_BACKEND=onepassword
OP_SERVICE_ACCOUNT_TOKEN=ops_...
OP_VAULT=ai-agents
```

Store the baseline deployment secrets described in [Set Up Centaur](/setup):

| Secret | Required for |
|--------|--------------|
| `DATABASE_URL` | API database connection through PgBouncer. |
| `PGBOUNCER_DATABASE_URL` | PgBouncer connection to Postgres. |
| `FIREWALL_CONTROL_TOKEN` | Firewall/API/PgBouncer/Slackbot control calls. |
| `SANDBOX_SIGNING_KEY` | Stable sandbox API tokens across restarts. |
| `SLACK_BOT_TOKEN` | Slack Web API calls. |
| `SLACK_SIGNING_SECRET` | Slack webhook signature validation. |
| `SLACKBOT_API_KEY` | Slackbot calls into Centaur Agent API. |
| `GITHUB_TOKEN` | Agent repository work through `git` and `gh`. |
| `AMP_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Harness/model calls. |

For an internal disposable stack, set `SECRET_MANAGER_BACKEND=env` and place
the same values directly in `.env`.

Generate local service secrets when needed:

```bash
openssl rand -hex 32
```

## Step 5. Configure the HTTPS webhook edge

Slack requires an HTTPS Request URL. On bare metal, the simplest path is a
Cloudflare Tunnel that maps a public hostname to Centaur's local Compose nginx
without exposing the machine's inbound ports.

### Option A. Cloudflare Tunnel

Use this when the server sits behind NAT, in a colo/private network, or on
owned infrastructure where you want an outbound-only public edge.

1. In Cloudflare, move or create the `example.com` DNS zone.
2. In **Zero Trust** > **Networks** > **Tunnels**, create a tunnel named
   `centaur-prod`.
3. Choose the `cloudflared` connector.
4. Add a public hostname:

| Field | Value |
|-------|-------|
| Subdomain | `centaur` |
| Domain | `example.com` |
| Type | `HTTP` |
| URL | `http://localhost:8000` |

The public Slack webhook will be:

```text
https://centaur.example.com/api/webhooks/slack
```

Install `cloudflared` on the Centaur host and register it as a service using
the token from the Cloudflare tunnel screen:

```bash
curl -fsSL -o cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
sudo dpkg -i cloudflared.deb
read -rsp "Cloudflare tunnel token: " CLOUDFLARE_TUNNEL_TOKEN && echo
sudo cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
unset CLOUDFLARE_TUNNEL_TOKEN
sudo systemctl status cloudflared --no-pager
```

Keep `CENTAUR_NGINX_BIND_ADDRESS=127.0.0.1` and
`CENTAUR_NGINX_HOST_PORT=8000`. Cloudflare terminates HTTPS, `cloudflared`
forwards to `http://localhost:8000`, Compose nginx routes
`/api/webhooks/slack` to the Slackbot, and the Slackbot validates the request
with `SLACK_SIGNING_SECRET`.

Do not put Cloudflare Access or Centaur API-key auth in front of
`/api/webhooks/slack`; Slack must be able to POST directly. Use Slack signing
secret validation as the webhook authentication boundary. Cloudflare WAF and
rate limits are fine as long as they do not require an interactive login or
custom client credentials from Slack.

After Centaur is running, verify the tunnel:

```bash
sudo systemctl status cloudflared --no-pager
curl -sS https://centaur.example.com/api/webhooks/slack \
  -o /dev/null -w '%{http_code}\n'
```

A non-2xx response is acceptable for an unsigned GET. Slack's Event
Subscriptions verifier is the real signed webhook test.

References: [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/setup/),
[Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing/),
and [locally-managed tunnel commands](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/).

### Option B. Host nginx and Certbot

Use this when the server has a public IP and your firewall allows inbound
HTTP/HTTPS directly to the host. Create a host nginx reverse proxy:

```bash
sudo tee /etc/nginx/sites-available/centaur.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name centaur.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/centaur.conf /etc/nginx/sites-enabled/centaur.conf
sudo nginx -t
sudo systemctl reload nginx
```

Issue the certificate after DNS reaches the host:

```bash
sudo certbot --nginx -d centaur.example.com
```

If your organization has a central load balancer or TLS appliance, terminate
TLS there and forward to `http://<host-internal-ip>:8000` or to host nginx.

## Step 6. Boot Centaur

```bash
docker compose build api slackbot nginx
docker compose build sandbox
docker compose up -d postgres secrets firewall pgbouncer api slackbot nginx
docker compose ps
```

For observability on the same host:

```bash
docker compose up -d victoriametrics victorialogs grafana fluentbit
```

Check health:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS https://centaur.example.com/healthz
```

If you use Cloudflare Tunnel and want to verify the origin before testing the
public hostname, keep the local check:

```bash
curl -fsS http://127.0.0.1:8000/healthz
```

## Step 7. Configure Slack

In Slack Event Subscriptions, set the Request URL to the public HTTPS hostname
handled by Cloudflare Tunnel, host nginx, or your TLS appliance:

```text
https://centaur.example.com/api/webhooks/slack
```

Slack sends events to the webhook. The Slackbot validates
`X-Slack-Signature` and `X-Slack-Request-Timestamp` with
`SLACK_SIGNING_SECRET`, then calls Centaur with `SLACKBOT_API_KEY`.

Do not require Centaur API-key auth on `/api/webhooks/slack`; Slack does not
send `X-Api-Key` headers.

## Step 8. Create API keys

Create the Slackbot key from the host with localhost bypass:

```bash
SLACKBOT_API_KEY=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "service:slackbot",
    "scopes": ["agent"],
    "created_by": "bootstrap"
  }' | jq -r .key)

printf '%s\n' "$SLACKBOT_API_KEY"
```

Store the returned key in 1Password or `.env` as `SLACKBOT_API_KEY`, then
restart Slackbot:

```bash
docker compose up -d slackbot
```

Create user or app keys with narrower permissions through the
[Admin API](/api/admin).

## Step 9. Verify and operate

Check the API:

```bash
docker exec centaur-api-1 curl -fsS http://localhost:8000/health/ready
```

Check public routing:

```bash
curl -sS https://centaur.example.com/api/webhooks/slack \
  -o /dev/null -w '%{http_code}\n'
```

A non-2xx response is acceptable for an unsigned GET. Slack's Event
Subscriptions verifier is the real signed webhook test.

Mention the Slackbot in Slack and check logs:

```bash
docker compose logs -f slackbot api
```

Upgrade from Git:

```bash
cd ~/github/paradigmxyz/centaur
git pull --ff-only
docker compose build api slackbot nginx
docker compose build sandbox
docker compose up -d
docker compose ps
```

Back up Postgres:

```bash
mkdir -p ~/centaur-backups
docker exec centaur-postgres-1 pg_dump -U tempo ai_v2 \
  | gzip > ~/centaur-backups/centaur-$(date +%F-%H%M%S).sql.gz
```

For durable production data, use an external Postgres instance you operate,
keep PgBouncer close to the API, and test restore procedures before relying on
the deployment.
