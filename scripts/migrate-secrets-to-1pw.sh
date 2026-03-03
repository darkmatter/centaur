#!/usr/bin/env bash
# Migrate API keys from v1 .env to 1Password vault.
# Run locally: bash scripts/migrate-secrets-to-1pw.sh
#
# Prerequisites: `op` CLI installed and signed in to paradigmoperationslp account.
# Test with: op vault list --account paradigmoperationslp

set -euo pipefail

VAULT="7ycqwxmheirj5zoyqmd27fmbca"
ACCOUNT="paradigmoperationslp"
V1_ENV="$HOME/github/paradigmxyz/ai/.env"

if [[ ! -f "$V1_ENV" ]]; then
  echo "ERROR: v1 .env not found at $V1_ENV"
  exit 1
fi

# Keys to migrate (from tool-qa report missing credentials list)
KEYS=(
  # alphasense — unblocks 6 methods
  ALPHASENSE_USERNAME
  # coinmetrics — 9 methods
  COINMETRICS_API_KEY
  # crunchbase — 15 methods
  CRUNCHBASE_API_KEY
  # harmonic — 13 methods
  HARMONIC_API_KEY
  # legistorm — 10 methods
  LEGISTORM_API_KEY
  # nansen — 15 methods
  NANSEN_API_KEY
  # sensortower — 6 methods
  SENSORTOWER_AUTH_TOKEN
  # sigma — 7 methods
  SIGMA_CLIENT_ID
  SIGMA_CLIENT_SECRET
  # similarweb — 21 methods
  SIMILARWEB_API_KEY
  # standard-metrics — 8 methods
  STANDARD_METRICS_CLIENT_ID
  STANDARD_METRICS_CLIENT_SECRET
  # falconx — 7 methods (PF account)
  FALCONX_PF_API_KEY
  FALCONX_PF_PASSPHRASE
  FALCONX_PF_SECRET_KEY
  # archiver — 10 methods
  PARCHIVER_DATABASE_URL
)

echo "Migrating ${#KEYS[@]} secrets from v1 .env → 1Password"
echo "Vault: $VAULT  Account: $ACCOUNT"
echo ""

OK=0
SKIP=0
FAIL=0

for KEY in "${KEYS[@]}"; do
  VALUE=$(grep "^${KEY}=" "$V1_ENV" | head -1 | cut -d= -f2-)
  if [[ -z "$VALUE" ]]; then
    echo "⏭️  SKIP  $KEY — not found in v1 .env"
    ((SKIP++))
    continue
  fi

  # Check if item already exists
  if op item get "$KEY" --vault "$VAULT" --account "$ACCOUNT" &>/dev/null; then
    echo "⏭️  SKIP  $KEY — already in 1Password"
    ((SKIP++))
    continue
  fi

  echo -n "➕ ADD   $KEY (${#VALUE} chars)... "
  if op item create \
    --vault "$VAULT" \
    --account "$ACCOUNT" \
    --category "API Credential" \
    --title "$KEY" \
    "credential=$VALUE" &>/dev/null; then
    echo "✅"
    ((OK++))
  else
    echo "❌"
    ((FAIL++))
  fi
done

echo ""
echo "Done: $OK added, $SKIP skipped, $FAIL failed"
echo ""
echo "NOTE: DATAGOV_API_KEY is on the prod box but not in the local v1 .env."
echo "  To add it, SSH to the box and run:"
echo "  ssh ubuntu@206.223.235.69 \"grep ^DATAGOV_API_KEY= ~/github/paradigmxyz/ai/.env\""
echo "  Then: op item create --vault $VAULT --account $ACCOUNT --category 'API Credential' --title DATAGOV_API_KEY 'credential=<value>'"
echo ""
echo "The secrets service refreshes from 1Password every 5 minutes."
echo "Force refresh: curl -X POST https://svc-ai.paradigm.xyz/admin/reload-tools"
