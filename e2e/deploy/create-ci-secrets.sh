#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
SLACKBOT_API_KEY="${SLACKBOT_API_KEY:-aiv2_e2e_slackbot_key_do_not_use_outside_tests}"
LOCAL_DEV_API_KEY="${LOCAL_DEV_API_KEY:-aiv2_e2e_local_dev_key_do_not_use_outside_tests}"

rand_hex() {
  openssl rand -hex 32
}

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

EXISTING_POSTGRES_PASSWORD="$(kubectl -n "$NAMESPACE" get secret centaur-infra-env \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)"
DEFAULT_POSTGRES_PASSWORD="tempo_dev"
POSTGRES_PASSWORD="${CENTAUR_E2E_POSTGRES_PASSWORD:-${EXISTING_POSTGRES_PASSWORD:-$DEFAULT_POSTGRES_PASSWORD}}"
DATABASE_URL="${CENTAUR_E2E_DATABASE_URL:-postgresql://tempo:${POSTGRES_PASSWORD}@centaur-centaur-postgres:5432/ai_v2}"

kubectl -n "$NAMESPACE" delete secret centaur-infra-env --ignore-not-found >/dev/null
kubectl -n "$NAMESPACE" create secret generic centaur-infra-env \
  --from-literal=FIREWALL_CONTROL_TOKEN="${FIREWALL_CONTROL_TOKEN:-$(rand_hex)}" \
  --from-literal=IRON_MANAGEMENT_API_KEY="${IRON_MANAGEMENT_API_KEY:-$(rand_hex)}" \
  --from-literal=SANDBOX_SIGNING_KEY="${SANDBOX_SIGNING_KEY:-$(rand_hex)}" \
  --from-literal=SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-e2e-unused-slack-bot-token}" \
  --from-literal=SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-e2e-unused-slack-signing-secret}" \
  --from-literal=SLACKBOT_API_KEY="$SLACKBOT_API_KEY" \
  --from-literal=LOCAL_DEV_API_KEY="$LOCAL_DEV_API_KEY" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=AMP_API_KEY="${AMP_API_KEY:-}" >/dev/null

kubectl -n "$NAMESPACE" delete secret centaur-firewall-ca centaur-firewall-ca-key --ignore-not-found >/dev/null
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
CA_KEY="$TMPDIR/ca-key.pem"
CA_CERT="$TMPDIR/ca-cert.pem"

openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
openssl req -x509 -new -nodes \
  -key "$CA_KEY" -sha256 -days 3650 \
  -subj "/CN=centaur e2e iron-proxy CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign" \
  -out "$CA_CERT" >/dev/null 2>&1

kubectl -n "$NAMESPACE" create secret generic centaur-firewall-ca \
  --from-file=ca-cert.pem="$CA_CERT" >/dev/null
kubectl -n "$NAMESPACE" create secret generic centaur-firewall-ca-key \
  --from-file=ca-cert.pem="$CA_CERT" \
  --from-file=ca-key.pem="$CA_KEY" >/dev/null

echo "Created E2E secrets in namespace $NAMESPACE"
