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
apps:
  - name: omp-stats
    image: example.invalid/omp-stats:test
    podSecurityContext:
      fsGroup: 1001
      fsGroupChangePolicy: OnRootMismatch
    persistence:
      enabled: true
overlays:
  sources:
    - repo: example/centaur
      visibility: public
YAML

rendered=$(helm template test "$(dirname "$0")" --namespace test --values "$values")
printf '%s\n' "$rendered" | yq -e '
  select(.kind == "Deployment" and .metadata.name == "test-centaur-app-omp-stats") |
  .spec.template.spec.securityContext.fsGroup == 1001 and
  .spec.template.spec.securityContext.fsGroupChangePolicy == "OnRootMismatch"
' >/dev/null

printf '%s\n' "$rendered" | yq -e '
  select(.kind == "NetworkPolicy" and .metadata.name == "test-centaur-api-rs-egress") |
  .spec.egress[] |
  select(.to[].podSelector.matchLabels."app.kubernetes.io/component" == "app-omp-stats") |
  select(.ports[].protocol == "TCP" and .ports[].port == 8080)
' >/dev/null
