#!/usr/bin/env bash
set -euo pipefail

values=$(mktemp)
trap 'rm -f "$values"' EXIT
cat >"$values" <<'YAML'
secretManager:
  existingSecretName: test-infra
firewall:
  existingCaSecretName: test-ca
  existingCaKeySecretName: test-ca-key
agentSandbox:
  enabled: false
slackbotv2:
  enabled: true
  databaseUrlSecretKey: SLACKBOTV2_DATABASE_URL
overlays:
  sources:
    - repo: darkmatter/centaur
      visibility: public
YAML

rendered=$(helm template test "$(dirname "$0")" --namespace test --values "$values")
printf '%s\n' "$rendered" | yq -e '
  select(.kind == "Deployment" and .metadata.name == "test-centaur-slackbotv2") |
  .spec.template.spec.containers[0].env[] |
  select(.name == "SLACKBOTV2_DATABASE_URL") |
  .valueFrom.secretKeyRef.key == "SLACKBOTV2_DATABASE_URL"
' >/dev/null
