---
title: Configure Agent Harnesses
description: Set up Amp, Claude Code, Codex, and other sandbox harness credentials through the secrets service and Iron Proxy.
---

# Configure Agent Harnesses

Use this guide when a deployment operator needs to make Amp, Claude Code,
Codex, or another CLI harness work inside Centaur sandboxes.

Centaur does not put raw model or harness credentials in sandbox containers.
The sandbox receives placeholder values such as
`AMP_API_KEY=AMP_API_KEY`. The harness sends those placeholders in outbound
HTTP headers, and Iron Proxy replaces them with the real values from the
configured secrets backend only for allowed upstream hosts.

The examples below use 1Password because that is the current shared Centaur
deployment path. The same model also works with cloud secret stores such as AWS
Secrets Manager encrypted by AWS KMS, or Google Secret Manager protected with
Cloud KMS CMEK, as long as the Centaur secrets service can expose either the
secret value or a provider-native secret reference to Iron Proxy.

## Step 1. Choose the harnesses to enable

| Harness | API value | Slack selector | Credential to store | Upstream |
|---------|-----------|----------------|---------------------|----------|
| Amp | `amp` | `--amp` | `AMP_API_KEY` | `ampcode.com` |
| Claude Code | `claude-code` | `--claude` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| Codex | `codex` | `--codex` | `OPENAI_API_KEY` | `api.openai.com` |
| pi-mono | `pi-mono` | `--pi` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |

Amp is the default harness. Claude Code and Codex are already installed in the
sandbox image. The API accepts the harness on `POST /agent/spawn` and
`POST /agent/execute`.

```json
{
  "thread_key": "harness-test-codex",
  "harness": "codex"
}
```

Slack users can route a single prompt by prefixing the message with one of the
selectors above. For example:

```text
--claude explain this failing test
--codex inspect the migration
--amp deploy this workflow
```

## Step 2. Store harness credentials

Create one secret per credential with the exact name shown in the table.

| Secret name | Value to store |
|-------------|----------------|
| `AMP_API_KEY` | The Amp auth token used by the Amp CLI. |
| `ANTHROPIC_API_KEY` | The Anthropic API key used by Claude Code and Anthropic-backed harnesses. |
| `OPENAI_API_KEY` | The OpenAI API key used by Codex and OpenAI-backed tools. |

### 1Password path

For shared deployments that use 1Password, use the vault configured by
`OP_VAULT`. Create one item per credential with the exact item title above.

The current Amp setup is intentionally simple:

1. Get the Amp auth token from the operator account or existing Amp CLI auth
   state.
2. Create a 1Password item named exactly `AMP_API_KEY`.
3. Put the raw Amp token value in the password or credential field.
4. Save the item in the vault referenced by `OP_VAULT`.
5. Restart or refresh the secrets service if you want the value available
   immediately.

Do not run an interactive `amp login`, `claude login`, or `codex login` flow
inside long-lived production sandboxes. The sandbox image is built for
token-based operation behind Iron Proxy.

### AWS/GCP secret-store path

For cloud deployments, store the same named secrets in the cloud provider's
secret store and use the provider KMS layer for encryption at rest:

| Provider | Secret store | KMS layer |
|----------|--------------|-----------|
| AWS | AWS Secrets Manager or SSM Parameter Store | AWS KMS customer managed key. |
| GCP | Google Secret Manager | Google Cloud KMS CMEK when you need customer-managed keys. |

AWS KMS and Google Cloud KMS are key-management systems. They are usually not
the place where you store the raw Amp/OpenAI/Anthropic token directly. Store
the token in the provider's secret manager, encrypt it with the provider KMS
key, and grant only the Centaur secrets service or sync controller permission
to read it.

The secret names should still be `AMP_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENAI_API_KEY`. That keeps the sandbox placeholders, runtime credential
checks, tool manifests, and Iron Proxy injection map unchanged.

## Step 3. Configure the secret backend

For production and shared staging deployments:

```bash
SECRET_MANAGER_BACKEND=onepassword
OP_SERVICE_ACCOUNT_TOKEN=ops_...
OP_VAULT=ai-agents
```

The secrets service reads the vault, normalizes item names to env-var style,
and exposes values to Iron Proxy through the control plane.

For AWS or GCP today, use the env-backed bridge:

1. Store the harness secrets in AWS Secrets Manager or Google Secret Manager.
2. Use your cluster's secret sync mechanism to project those values into a
   Kubernetes Secret for the Centaur secrets service.
3. Run the Centaur secrets service with `SECRET_MANAGER_BACKEND=env`.
4. Set `SECRET_ENV_PREFIX=CENTAUR_SECRET_`.
5. Set `ironProxy.manager.secretSource=env`.

Example Helm values:

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

The Centaur secrets-service Kubernetes Secret should contain prefixed keys:

```text
CENTAUR_SECRET_AMP_API_KEY
CENTAUR_SECRET_ANTHROPIC_API_KEY
CENTAUR_SECRET_OPENAI_API_KEY
```

The Iron Proxy env-source Kubernetes Secret should contain the same runtime
credentials with unprefixed names:

```text
AMP_API_KEY
ANTHROPIC_API_KEY
OPENAI_API_KEY
```

That is because the Centaur secrets service strips `SECRET_ENV_PREFIX`, while
Iron Proxy's `env` source resolves the env var name rendered by
firewall-manager, such as `AMP_API_KEY`.

The env-backed bridge still preserves Centaur's important boundary: the
sandbox receives only placeholder values. The raw cloud secret is available to
the secrets service and Iron Proxy path, not to the sandbox process.

For local development only:

```bash
SECRET_MANAGER_BACKEND=env
AMP_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

Use local env mode only for disposable or single-user stacks. In production,
keep raw tokens in 1Password or the deployment's secret manager.

## Step 4. Use provider-native refs when available

Iron Proxy's secret transform can use different secret source schemas. In this
repo, `firewall-manager` currently renders two concrete source shapes:

| `ironProxy.manager.secretSource` | Rendered Iron Proxy source | Works with |
|----------------------------------|----------------------------|------------|
| `onepassword` | `type: 1password` with `secret_ref` from `/secrets/{key}/ref` | 1Password-backed secrets service. |
| `env` | `type: env` with `var: <KEY>` | Env-backed secrets service, including cloud-secret sync into Kubernetes env. |

To make AWS or GCP a first-class provider-native source, add a secrets-service
backend that returns both:

| Endpoint | Required behavior |
|----------|-------------------|
| `GET /secrets/AMP_API_KEY` | Returns the current secret value for readiness checks and API-side consumers. |
| `GET /secrets/AMP_API_KEY/ref` | Returns the provider-native reference Iron Proxy should use, such as an AWS secret ARN or a GCP Secret Manager resource name. |

Then extend `services/firewall-manager/manager.py` so
`FIREWALL_MANAGER_SECRET_SOURCE=aws` or `gcp` renders the source schema
expected by your Iron Proxy version.

The provider-native path is useful when you want Iron Proxy to resolve secrets
directly from AWS or GCP instead of receiving synced env vars. The env-backed
bridge is simpler and works with the current Centaur chart.

## Step 5. Confirm Iron Proxy can inject the keys

Centaur builds an injection map from infrastructure defaults and tool
manifests. The harness-related defaults are:

| Host pattern | Allowed key |
|--------------|-------------|
| `ampcode.com` | `AMP_API_KEY` |
| `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `api.openai.com` | `OPENAI_API_KEY` |
| `github.com` / `api.github.com` | `GITHUB_TOKEN` |

In Kubernetes, the firewall-manager sidecar pushes that map into Iron Proxy.
In Docker Compose, the firewall service handles the same placeholder
replacement path.

The sandbox environment should contain placeholders, not raw values:

```bash
AMP_API_KEY=AMP_API_KEY
ANTHROPIC_API_KEY=ANTHROPIC_API_KEY
OPENAI_API_KEY=OPENAI_API_KEY
HTTPS_PROXY=http://firewall:8080
```

If you see the real token value inside a sandbox environment, stop and fix the
deployment before running user traffic.

## Step 6. Set readiness requirements

Production deployments should fail readiness when the required harness tokens
are missing. For an Amp-only deployment:

```yaml
api:
  runtimeCredentialGuardEnabled: true
  requiredRuntimeSecretKeys: AMP_API_KEY
```

For Amp, Claude Code, and Codex:

```yaml
api:
  runtimeCredentialGuardEnabled: true
  requiredRuntimeSecretKeys: AMP_API_KEY,ANTHROPIC_API_KEY,OPENAI_API_KEY
```

`AMP_API_KEY` is checked for presence. `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` can also be probed against their provider model endpoints, so
invalid keys are caught before agents start taking work.

## Step 7. Verify each harness

First verify the secret path from the API:

```bash
curl -s "$CENTAUR_API_URL/health/runtime-credentials?refresh=true" \
  -H "X-Api-Key: $ADMIN_KEY" | jq
```

Then run a minimal turn for each enabled harness:

```bash
THREAD_KEY="harness-test-amp"

SPAWN=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/spawn \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | jq -r '.assignment_generation')

docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/message \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG.\"}]}"

EXECUTE=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')

docker exec centaur-api-1 curl -s \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq
```

Repeat with `harness` set to `claude-code` or `codex`.

For Slack, mention the bot with a selector:

```text
--amp reply with exactly PONG
--claude reply with exactly PONG
--codex reply with exactly PONG
```

Check the Slackbot and API logs if a harness fails:

```bash
docker compose logs -f slackbot api firewall
```

For Kubernetes with Iron Proxy, also inspect the firewall-manager health detail
and the rendered proxy config:

```bash
RELEASE_NAME=centaur

kubectl -n centaur-system exec "deploy/${RELEASE_NAME}-centaur-iron-proxy" \
  -c firewall-manager -- \
  wget -qO- --header="Authorization: Bearer $FIREWALL_CONTROL_TOKEN" \
  http://127.0.0.1:8081/health/detail
```

The detail response should show that the injection map has loaded. The map
must include the provider host for each enabled harness.

References: [AWS Secrets Manager encryption with AWS KMS](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html),
[AWS Secrets Manager on EKS](https://docs.aws.amazon.com/eks/latest/userguide/manage-secrets.html),
[Google Secret Manager CMEK](https://cloud.google.com/secret-manager/docs/cmek),
and [GKE Workload Identity Federation](https://cloud.google.com/kubernetes-engine/docs/concepts/workload-identity).

## Step 8. Add another harness

When adding a new CLI harness, update all of these pieces together:

1. Install the CLI in `services/sandbox/Dockerfile`.
2. Add the engine name to the API harness allowlist.
3. Add a command in `_build_harness_cmd`.
4. Add any placeholder credential names to the sandbox env builder.
5. Add the upstream host and secret name to the Iron Proxy injection map.
6. Add the credential to the configured secret backend with the exact env-var name.
7. Add a smoke test that runs a real turn through the new harness.

Do not rely on a per-user browser login state in the sandbox. Use a named
credential in the secret manager and inject it through Iron Proxy.
