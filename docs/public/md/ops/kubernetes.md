---
title: Kubernetes + Iron Proxy
description: Run Centaur with sandbox pods, Helm, and Iron Proxy for API keys.
---

# Kubernetes + Iron Proxy

Centaur can run agents in Docker containers or Kubernetes pods. Docker is easiest locally. Kubernetes is the production path when you want pod isolation, resource limits, runtime classes, image pull policies, and a single proxy that handles API keys.

For provider-specific cluster setup, use [Deploy on AWS EKS](/ops/aws/eks),
[Deploy on GCP GKE](/ops/gcp/gke), or [Deploy on Bare Metal](/ops/bare-metal)
if you run all infrastructure yourself.

## Production shape

The API still saves threads, runs, and events in Postgres. The Kubernetes backend changes where agents run. Iron Proxy handles outbound requests that need credentials:

```diagram
╭─────────────╮       ╭────────────────────╮       ╭────────────────────╮
│ Centaur API │──────▶│ Kubernetes backend │──────▶│ Sandbox Pod        │
│ Postgres    │       │ create/attach/exec │       │ agent CLI          │
╰─────────────╯       ╰────────────────────╯       ╰─────────┬──────────╯
                                                            │ outbound HTTP
                                                            ▼
                                                   ╭────────────────────╮
                                                   │ Iron Proxy         │
                                                   │ secret references  │
                                                   ╰────────────────────╯
```

Each pod receives the prompt files, environment, proxy CA, proxy settings, and command it needs for one assigned thread. It should not receive raw model keys or third-party API keys.

## Helm values

The chart lives at `contrib/chart`. Select the backend, sandbox image, and Iron Proxy stack in your values file:

```yaml
api:
  sandboxBackend: kubernetes
  executionWorkerEnabled: true
  warmPoolEnabled: true
  runtimeCredentialGuardEnabled: true
  requiredRuntimeSecretKeys: AMP_API_KEY

ironProxy:
  enabled: true
  manager:
    secretSource: onepassword
    secretTtl: 10m

sandbox:
  image:
    repository: centaur-agent
    tag: latest
    pullPolicy: IfNotPresent
  runtimeClassName: gvisor
```

The chart still deploys the older firewall service for compatibility. Use Iron Proxy for new production deployments when third-party API calls need secret injection.

Install or upgrade:

```bash
helm upgrade --install centaur contrib/chart \
  --namespace centaur-system \
  --create-namespace \
  -f values.production.yaml
```

Lint chart changes before shipping:

```bash
helm lint contrib/chart
```

## Required configuration

| Setting | Why it matters |
|---------|----------------|
| `SANDBOX_BACKEND=kubernetes` | Runs agents in Kubernetes pods. |
| `KUBERNETES_NAMESPACE` | Namespace where sandbox pods are created. |
| `AGENT_API_URL` | URL injected into sandboxes so they can call back to the API. |
| `FIREWALL_HOST` | Proxy host used by outbound traffic. Point this at the active proxy service. |
| `KUBERNETES_FIREWALL_CA_SECRET_NAME` | Secret mounted so the sandbox trusts the proxy CA. |
| `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME` | Optional runtime class such as `gvisor`. |
| `KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS` | Optional comma-separated pull secret names. |
| `KUBERNETES_SANDBOX_CPU_LIMIT` / `KUBERNETES_SANDBOX_MEMORY_LIMIT` | Per-sandbox resource limits; defaults are `2` CPU and `4Gi`. |
| `IRON_MANAGEMENT_API_KEY` | Protects the Iron Proxy management API used by the firewall-manager sidecar. |
| `FIREWALL_CONTROL_TOKEN` | Protects endpoints that update key-injection maps. |

## How API keys are injected

The sandbox should carry secret names, not raw secret values. A tool can ask for `secret("ALCHEMY_API_KEY")`; the secret manager resolves it; Iron Proxy injects the key only on the outbound request to an allowlisted upstream.

The chart supports the current Centaur paths directly:

| Secret path | Helm shape | Use when |
|-------------|------------|----------|
| 1Password | `secretManager.backend=onepassword`, `ironProxy.manager.secretSource=onepassword` | Your shared deployment stores secrets in 1Password. |
| Cloud secret store bridged through Kubernetes env | `secretManager.backend=env`, `ironProxy.manager.secretSource=env`, `ironProxy.envFromSecretName=<secret>` | You store secrets in AWS Secrets Manager or Google Secret Manager, encrypted by AWS KMS or Google Cloud KMS, then sync them into Kubernetes Secrets for the Centaur secrets service and Iron Proxy. |

For harness-specific examples, including Amp, Claude Code, Codex, and
AWS/GCP KMS-backed secret stores, see [Configure Agent Harnesses](/ops/harnesses).

Before promoting a deployment, verify three things:

1. the secret exists in the configured secret-manager backend,
2. the Iron Proxy manager can render and reload the key map,
3. the sandbox trusts the proxy CA and sends outbound HTTP through the proxy.

## Smoke test

After deploy, run the sandbox smoke script against the cluster context, namespace, and release:

```bash
scripts/smoke-k8s-sandbox-backend.sh orbstack centaur-system centaur-orbstack
```

The script verifies that the API selected Kubernetes, creates a sandbox pod, runs an exec command, opens attach streams, writes stdin, and cleans up. Pair it with a real tool call that uses an API key before promoting the deployment.

## Operating notes

- Keep network policies on; sandboxes should reach only the API and the active proxy.
- Prefer a non-default runtime class where the cluster supports it.
- Use pull secrets for private images instead of baking credentials into workloads.
- Keep deployment-specific tools and prompts in overlays so the base chart can stay generic.
- Watch warm-pool behavior after deploys; first claims should use the newly deployed image and overlay.
- Rotate `IRON_MANAGEMENT_API_KEY` and `FIREWALL_CONTROL_TOKEN` as deployment secrets, not as chart literals.
