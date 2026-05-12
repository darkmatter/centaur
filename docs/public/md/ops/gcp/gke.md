---
title: Deploy on GCP GKE
description: Deploy Centaur on Google Kubernetes Engine with public GHCR images, Helm, ingress-nginx, cert-manager, Slack webhooks, sandbox pods, and scoped API keys.
---

# Deploy on GCP GKE

Use this guide to run Centaur on Google Kubernetes Engine. It assumes Centaur
core images are public and pulled from GitHub Container Registry. You only need
to publish your own image if you maintain an optional org overlay.

## Step 1. Choose the GCP shape

| Area | Starting point |
|------|----------------|
| Region | `us-central1` or the GCP region closest to users. |
| Cluster | GKE Standard regional cluster. |
| Nodes | Autoscaling pool with at least 2 to 3 nodes, 4 vCPU / 16 GB RAM each. |
| Public edge | `ingress-nginx` Service `LoadBalancer`. |
| TLS | `cert-manager` with Let's Encrypt. |
| DNS | Cloud DNS or your existing DNS provider. |
| Database | In-cluster Postgres for first deploy; Cloud SQL Postgres for durable production. |
| Secrets | 1Password-backed secrets service. |
| Sandbox backend | Kubernetes pods. |

Keep Admin API access private. Use `kubectl port-forward`, VPN, or a private
ingress for operators.

## Step 2. Create the GKE cluster

Install `gcloud`, `kubectl`, and `helm`.

Enable APIs:

```bash
PROJECT_ID="your-project"
REGION="us-central1"
CLUSTER="centaur"

gcloud config set project "$PROJECT_ID"
gcloud services enable container.googleapis.com dns.googleapis.com compute.googleapis.com
```

Create a GKE Standard regional cluster:

```bash
gcloud container clusters create "$CLUSTER" \
  --region "$REGION" \
  --release-channel regular \
  --machine-type e2-standard-4 \
  --num-nodes 1 \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 6 \
  --disk-size 100 \
  --enable-ip-alias \
  --enable-network-policy

gcloud container clusters get-credentials "$CLUSTER" --region "$REGION"
kubectl get nodes
kubectl get storageclass
```

GKE Autopilot can work for some deployments, but start with GKE Standard until
you have validated sandbox pod creation, warm-pool behavior, storage, and any
runtime-class needs.

Useful references:
[GKE cluster creation](https://cloud.google.com/sdk/gcloud/reference/container/clusters/create),
[GKE Autopilot](https://cloud.google.com/kubernetes-engine/docs/how-to/creating-an-autopilot-cluster),
[GKE Ingress](https://cloud.google.com/kubernetes-engine/docs/concepts/ingress),
and [Cloud DNS](https://cloud.google.com/dns/docs/).

## Step 3. Install the public edge

Install `ingress-nginx`:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

kubectl -n ingress-nginx get svc ingress-nginx-controller
```

Point `centaur.example.com` at the external IP shown on the
`ingress-nginx-controller` service.

Install `cert-manager`:

```bash
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

Create the Let's Encrypt issuer:

```bash
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    email: ops@example.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
EOF
```

References:
[ingress-nginx installation](https://kubernetes.github.io/ingress-nginx/deploy/),
[Kubernetes Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/),
and [cert-manager Helm install](https://cert-manager.io/docs/installation/helm/).

## Step 4. Configure secrets

Create the namespace:

```bash
kubectl create namespace centaur-system --dry-run=client -o yaml | kubectl apply -f -
```

Create the 1Password bootstrap secret:

```bash
kubectl -n centaur-system create secret generic centaur-secrets-bootstrap \
  --from-literal=OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN" \
  --from-literal=OP_VAULT="ai-agents" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Store baseline values in 1Password using the names from
[Set Up Centaur](/setup): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
`SLACKBOT_API_KEY`, `GITHUB_TOKEN`, model keys, and tool-specific keys.

Generate the firewall CA and service secrets locally or in CI:

```bash
mkdir -p .secrets

openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -subj "/CN=centaur-firewall-ca" \
  -keyout .secrets/firewall-ca.key \
  -out .secrets/firewall-ca.crt

FIREWALL_CONTROL_TOKEN="$(openssl rand -hex 32)"
SANDBOX_SIGNING_KEY="$(openssl rand -hex 32)"
IRON_MANAGEMENT_API_KEY="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
SLACKBOT_API_KEY="$(python3 - <<'PY'
import secrets
print("aiv2_" + secrets.token_urlsafe(32))
PY
)"
```

Create `values.secrets.local.yaml` and do not commit it:

```yaml
postgres:
  auth:
    password: "replace-me"

secretManager:
  secrets:
    firewallControlToken: "replace-me"
    sandboxSigningKey: "replace-me"
    ironManagementApiKey: "replace-me"
    slackBotToken: "xoxb-..."
    slackSigningSecret: "replace-me"
    slackbotApiKey: "aiv2_..."
```

`SLACKBOT_API_KEY` can be pre-generated for Kubernetes. The API bootstraps that
static service key into Postgres on startup with `agent` scope.

## Step 5. Create Centaur Helm values

Core Centaur images are public on GHCR:

| Component | Image |
|-----------|-------|
| API | `ghcr.io/paradigmxyz/centaur-api` |
| Slackbot | `ghcr.io/paradigmxyz/centaur-slackbot` |
| Secrets | `ghcr.io/paradigmxyz/centaur-secrets` |
| Firewall | `ghcr.io/paradigmxyz/centaur-firewall` |
| PgBouncer | `ghcr.io/paradigmxyz/centaur-pgbouncer` |
| Sandbox | `ghcr.io/paradigmxyz/centaur-agent` |
| Iron Proxy | `ghcr.io/paradigmxyz/centaur-iron-proxy` |
| Firewall manager | `ghcr.io/paradigmxyz/centaur-firewall-manager` |

Create `values.gcp-gke.yaml`:

```yaml
secretManager:
  backend: onepassword
  generatedSecret:
    enabled: true

secrets:
  bootstrapSecretName: centaur-secrets-bootstrap
  image:
    repository: ghcr.io/paradigmxyz/centaur-secrets
    tag: latest

firewall:
  image:
    repository: ghcr.io/paradigmxyz/centaur-firewall
    tag: latest

ironProxy:
  enabled: true
  image:
    repository: ghcr.io/paradigmxyz/centaur-iron-proxy
    tag: latest
  manager:
    image:
      repository: ghcr.io/paradigmxyz/centaur-firewall-manager
      tag: latest
    secretSource: onepassword
    secretTtl: 10m

api:
  image:
    repository: ghcr.io/paradigmxyz/centaur-api
    tag: latest
  sandboxBackend: kubernetes
  executionWorkerEnabled: true
  workflowWorkerEnabled: true
  warmPoolEnabled: true
  runtimeCredentialGuardEnabled: true
  requiredRuntimeSecretKeys: AMP_API_KEY

sandbox:
  image:
    repository: ghcr.io/paradigmxyz/centaur-agent
    tag: latest
    pullPolicy: IfNotPresent
  runtimeClassName: ""

slackbot:
  enabled: true
  image:
    repository: ghcr.io/paradigmxyz/centaur-slackbot
    tag: latest

pgbouncer:
  image:
    repository: ghcr.io/paradigmxyz/centaur-pgbouncer
    tag: latest

postgres:
  enabled: true
  persistence:
    enabled: true
    size: 100Gi

ingress:
  enabled: true
  className: nginx
  host: centaur.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    - hosts:
        - centaur.example.com
      secretName: centaur-example-com-tls

networkPolicy:
  enabled: true
  ingressSourceNamespaces:
    - ingress-nginx
```

This example uses 1Password. If you want Google Secret Manager protected by
Cloud KMS CMEK, sync the Google secrets into a Kubernetes Secret and use the
env-backed bridge instead:

```yaml
secretManager:
  backend: env
  envPrefix: CENTAUR_SECRET_
  existingSecretName: centaur-runtime-secrets
  generatedSecret:
    enabled: false

ironProxy:
  enabled: true
  envFromSecretName: centaur-iron-proxy-runtime-secrets
  manager:
    secretSource: env
```

The Centaur secrets-service Kubernetes Secret should contain keys such as
`CENTAUR_SECRET_AMP_API_KEY`, `CENTAUR_SECRET_ANTHROPIC_API_KEY`, and
`CENTAUR_SECRET_OPENAI_API_KEY`. The Iron Proxy runtime secret should contain
the same credentials as unprefixed `AMP_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENAI_API_KEY`. See [Configure Agent Harnesses](/ops/harnesses) for the Iron
Proxy and KMS details.

For Cloud SQL Postgres, set `postgres.enabled=false` and configure
`database.appUrl` and `database.pgbouncerUrl` for your Cloud SQL connection
path.

Use a pinned GHCR release or SHA tag when you want deterministic rollouts;
`latest` is acceptable for a first bootstrap.

## Step 6. Render and deploy

```bash
helm lint contrib/chart

helm template centaur contrib/chart \
  --namespace centaur-system \
  -f values.gcp-gke.yaml \
  -f values.secrets.local.yaml \
  --set-file firewall.ca.certPem=.secrets/firewall-ca.crt \
  --set-file firewall.ca.keyPem=.secrets/firewall-ca.key \
  >/tmp/centaur-rendered.yaml

helm upgrade --install centaur contrib/chart \
  --namespace centaur-system \
  --create-namespace \
  -f values.gcp-gke.yaml \
  -f values.secrets.local.yaml \
  --set-file firewall.ca.certPem=.secrets/firewall-ca.crt \
  --set-file firewall.ca.keyPem=.secrets/firewall-ca.key
```

Wait for rollout:

```bash
kubectl -n centaur-system get pods
kubectl -n centaur-system rollout status deploy/centaur-api
kubectl -n centaur-system rollout status deploy/centaur-slackbot
kubectl -n centaur-system get ingress
```

## Step 7. Configure Slack

Set the Slack Event Subscriptions Request URL:

```text
https://centaur.example.com/api/webhooks/slack
```

Slack sends events over HTTPS to the Slackbot. The Slackbot validates
`X-Slack-Signature` and `X-Slack-Request-Timestamp` with
`SLACK_SIGNING_SECRET`, then calls the Centaur Agent API with
`SLACKBOT_API_KEY`.

Do not require Centaur API-key auth on `/api/webhooks/slack`.

## Step 8. Create API keys

Create keys through a private path:

```bash
kubectl -n centaur-system port-forward svc/centaur-api 8000:8000
```

In another terminal:

```bash
ADMIN_KEY=$(curl -s -X POST http://localhost:8000/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "operator:platform",
    "scopes": ["admin"],
    "created_by": "bootstrap"
  }' | jq -r .key)
```

Create narrower app keys with the Admin API after that.

## Step 9. Smoke test

```bash
curl -fsS http://localhost:8000/health/ready

curl -sS https://centaur.example.com/api/webhooks/slack \
  -o /dev/null -w '%{http_code}\n'

scripts/smoke-k8s-sandbox-backend.sh "$(kubectl config current-context)" centaur-system centaur
```

Run a real agent turn through the port-forward and verify chart rendering with
the examples in [Deploy on Your Infrastructure](/tutorials/deploy).

## Step 10. Operate the GKE release

```bash
kubectl -n centaur-system get pods,svc,ingress
kubectl -n centaur-system logs deploy/centaur-api --tail=200
kubectl -n centaur-system logs deploy/centaur-slackbot --tail=200
kubectl -n centaur-system get pods -l centaur-agent=true
```

For production data durability, move Postgres to Cloud SQL, keep PgBouncer
in-cluster, and test restore procedures before depending on the deployment.
