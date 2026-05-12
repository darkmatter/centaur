---
title: Deploy on AWS EC2
description: Deploy Centaur on a single AWS EC2 VM using Docker Compose, host TLS, Slack webhooks, and scoped API keys.
---

# Deploy on AWS EC2

Use this guide to stand up Centaur on one AWS EC2 instance. For larger
multi-tenant deployments, use [Deploy on AWS EKS](/ops/aws/eks) with
[Kubernetes + Iron Proxy](/ops/kubernetes).

## Step 1. Pick the public shape

| Value | Example | Notes |
|-------|---------|-------|
| Primary domain | `centaur.example.com` | Slack webhook and API base URL. |
| Optional apps domain | `apps.example.com` | Use this if you want app subdomains later. |
| Admin CIDR | `203.0.113.10/32` | Your office, VPN, or operator IP range for SSH. |
| Region | `us-east-1` | Pick the region closest to Slack/API users. |
| Instance size | 4 vCPU / 16 GB RAM or larger | Avoid tiny/free-tier instances; sandboxes need memory. |
| Disk | 100 GB gp3 or larger | Postgres, logs, Docker images, and sandbox layers grow over time. |

Expose only HTTP, HTTPS, and locked-down SSH at the security group. Do not
expose Postgres, PgBouncer, Docker, Slackbot, Grafana, or the raw API container
ports directly.

## Step 2. Create the EC2 host

In AWS:

1. Create or choose a VPC and subnet with outbound internet access.
2. Launch an Ubuntu Server 24.04 LTS EC2 instance.
3. Select a general-purpose instance with at least 4 vCPU and 16 GB RAM.
4. Attach at least a 100 GB gp3 root volume.
5. Create a security group named `centaur-vm`.
6. Add inbound rules:

| Type | Port | Source |
|------|------|--------|
| SSH | `22` | Your admin CIDR only. |
| HTTP | `80` | `0.0.0.0/0` and `::/0` if using IPv6. |
| HTTPS | `443` | `0.0.0.0/0` and `::/0` if using IPv6. |

7. Leave outbound HTTPS enabled so sandboxes and services can call model,
Slack, GitHub, 1Password, and package registry endpoints.
8. Allocate an Elastic IP and associate it with the instance.
9. Point `centaur.example.com` at the Elastic IP in Route 53 or your DNS provider.

References: [EC2 instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Instances.html),
[EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html),
and [launching EC2 instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/LaunchingAndUsingInstances.html).

SSH into the host:

```bash
ssh ubuntu@centaur.example.com
```

## Step 3. Install the host runtime

Run these on the instance:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq nginx snapd
```

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

Install Certbot:

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
```

Reference: [Certbot instructions](https://certbot.eff.org/instructions?ws=nginx&os=snap).

## Step 4. Clone Centaur

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

Use `127.0.0.1` for the Docker Compose nginx bind address because host nginx
will terminate TLS and proxy to it.

If external clients need the Agent, Tools, or Workflows API over the public
domain, add `api`:

```bash
CENTAUR_NGINX_ENABLED_SERVICES=slackbot,apps,api
```

Do not enable `admin` on a public internet route. Create admin keys from the VM
or over a private network/VPN.

## Step 5. Configure secrets

For a shared cloud deployment, prefer 1Password:

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

For a disposable environment, set `SECRET_MANAGER_BACKEND=env` and place the
same values directly in `.env`.

## Step 6. Configure host TLS

Create a host nginx reverse proxy:

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

Issue the certificate after DNS points at the Elastic IP:

```bash
sudo certbot --nginx -d centaur.example.com
```

## Step 7. Boot Centaur

```bash
docker compose build api slackbot nginx
docker compose build sandbox
docker compose up -d postgres secrets firewall pgbouncer api slackbot nginx
docker compose ps
```

For observability on the same VM:

```bash
docker compose up -d victoriametrics victorialogs grafana fluentbit
```

Check health:

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS https://centaur.example.com/healthz
```

## Step 8. Configure Slack

In the Slack app settings:

1. Open Event Subscriptions.
2. Set the Request URL to `https://centaur.example.com/api/webhooks/slack`.
3. Confirm Slack verifies the URL.
4. Subscribe the bot events listed in [Set Up Centaur](/setup#step-5-configure-slack).
5. Install or reinstall the app to the workspace.

Slack sends events to the webhook. The Slackbot validates
`X-Slack-Signature` and `X-Slack-Request-Timestamp` with
`SLACK_SIGNING_SECRET`, then calls Centaur with `SLACKBOT_API_KEY`.

Do not require Centaur API-key auth on `/api/webhooks/slack`.

## Step 9. Create API keys

Create the Slackbot key from the VM with localhost bypass:

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

## Step 10. Verify and operate

Check the API from the VM:

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
