#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ENV_FILE="${CENTAUR_E2E_ENV_FILE:-$ROOT/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -n "${CI:-}" ]]; then
  DEFAULT_KEEP_CLUSTER=0
  DEFAULT_RECREATE_CLUSTER=1
  DEFAULT_BUILD_IMAGES=1
  DEFAULT_LOAD_IMAGES=1
  DEFAULT_WARM_POOL_TARGET=2
  DEFAULT_WARM_POOL_TIMEOUT_SECONDS=120
else
  DEFAULT_KEEP_CLUSTER=1
  DEFAULT_RECREATE_CLUSTER=0
  DEFAULT_BUILD_IMAGES=0
  DEFAULT_LOAD_IMAGES=auto
  DEFAULT_WARM_POOL_TARGET=1
  DEFAULT_WARM_POOL_TIMEOUT_SECONDS=60
fi

CLUSTER_NAME="${CENTAUR_E2E_KIND_CLUSTER:-centaur-e2e}"
NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
RELEASE="${CENTAUR_RELEASE:-centaur}"
API_PORT="${CENTAUR_E2E_API_PORT:-8000}"
SLACKBOT_API_KEY="${SLACKBOT_API_KEY:-aiv2_e2e_slackbot_key_do_not_use_outside_tests}"
LOCAL_DEV_API_KEY="${LOCAL_DEV_API_KEY:-aiv2_e2e_local_dev_key_do_not_use_outside_tests}"
WARM_POOL_TARGET="${CENTAUR_E2E_WARM_POOL_TARGET:-$DEFAULT_WARM_POOL_TARGET}"
KEEP_CLUSTER="${CENTAUR_E2E_KEEP_CLUSTER:-$DEFAULT_KEEP_CLUSTER}"
RECREATE_CLUSTER="${CENTAUR_E2E_RECREATE_CLUSTER:-$DEFAULT_RECREATE_CLUSTER}"
BUILD_IMAGES="${E2E_BUILD:-$DEFAULT_BUILD_IMAGES}"
LOAD_IMAGES="${CENTAUR_E2E_LOAD_IMAGES:-$DEFAULT_LOAD_IMAGES}"
DEPLOY_STACK="${CENTAUR_E2E_DEPLOY:-auto}"
WARM_POOL_TIMEOUT_SECONDS="${CENTAUR_E2E_WARM_POOL_TIMEOUT_SECONDS:-$DEFAULT_WARM_POOL_TIMEOUT_SECONDS}"
API_DEPLOYMENT="deploy/${RELEASE}-centaur-api"
API_SELECTOR="app.kubernetes.io/name=centaur,app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=api"
pf_pid=""
cluster_created=0
IMAGES=(
  centaur-api
  centaur-iron-proxy
  centaur-firewall-manager
  centaur-agent
)

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FATAL: required command not found: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [[ -n "$pf_pid" ]]; then
    kill "$pf_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_CLUSTER" =~ ^(1|true|yes)$ ]]; then
    echo "Keeping kind cluster $CLUSTER_NAME for debugging"
    return
  fi
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
}

require_cmd kind
require_cmd kubectl
require_cmd helm
require_cmd curl
require_cmd node
require_cmd pnpm

if [[ "$BUILD_IMAGES" =~ ^(1|true|yes)$ ]]; then
  require_cmd just
fi

if [[ "$BUILD_IMAGES" =~ ^(1|true|yes)$ ]] || [[ "$LOAD_IMAGES" =~ ^(1|true|yes|auto)$ ]]; then
  require_cmd docker
fi

wait_for_api_rollout() {
  if kubectl rollout status -n "$NAMESPACE" "$API_DEPLOYMENT" --timeout=5m; then
    return 0
  fi

  echo "API rollout did not finish within 5m; dumping API pod state" >&2
  kubectl get pods -n "$NAMESPACE" -l "$API_SELECTOR" -o wide >&2 || true

  terminating_pods=()
  while IFS= read -r pod; do
    [[ -n "$pod" ]] && terminating_pods+=("$pod")
  done < <(
    kubectl get pods -n "$NAMESPACE" -l "$API_SELECTOR" --no-headers 2>/dev/null \
      | awk '$3 == "Terminating" {print $1}'
  )
  if [[ "${#terminating_pods[@]}" -gt 0 ]]; then
    echo "Force-deleting stuck terminating API pod(s): ${terminating_pods[*]}" >&2
    kubectl delete pod -n "$NAMESPACE" "${terminating_pods[@]}" --force --grace-period=0 >&2 || true
  fi

  kubectl rollout status -n "$NAMESPACE" "$API_DEPLOYMENT" --timeout=5m
}

wait_for_warm_pool() {
  if [[ "$WARM_POOL_TARGET" == "0" ]]; then
    echo "Skipping warm pool wait (CENTAUR_E2E_WARM_POOL_TARGET=0)"
    return 0
  fi

  local api_url="http://localhost:${API_PORT}"
  local deadline=$((SECONDS + WARM_POOL_TIMEOUT_SECONDS))
  local current_size="0"
  local body=""

  echo "Waiting for warm pool to reach ${WARM_POOL_TARGET} ready sandbox(es)..."
  while (( SECONDS < deadline )); do
    body="$(curl -fsS -X POST \
      -H "Authorization: Bearer ${LOCAL_DEV_API_KEY}" \
      "${api_url}/agent/pool/replenish" 2>/dev/null || true)"
    current_size="$(BODY="$body" node -e '
      try {
        const data = JSON.parse(process.env.BODY || "{}");
        process.stdout.write(String(data.current_size || 0));
      } catch {
        process.stdout.write("0");
      }
    ')"
    if [[ "$current_size" =~ ^[0-9]+$ ]] && (( current_size >= WARM_POOL_TARGET )); then
      echo "Warm pool ready: ${body}"
      return 0
    fi
    sleep 2
  done

  echo "Warm pool did not reach target ${WARM_POOL_TARGET}; last response: ${body}" >&2
  return 1
}

load_images_into_kind() {
  echo "Loading ${#IMAGES[@]} image(s) into kind cluster ${CLUSTER_NAME}..."
  local parallelism="${CENTAUR_E2E_IMAGE_LOAD_PARALLELISM:-6}"
  if ! printf '%s\0' "${IMAGES[@]}" | xargs -0 -I '{}' -P "$parallelism" sh -c '
    image="$1"
    cluster="$2"
    echo "Loading ${image}:latest"
    kind load docker-image "${image}:latest" --name "$cluster"
  ' sh '{}' "$CLUSTER_NAME"; then
    echo "One or more image loads failed" >&2
    return 1
  fi
}

cluster_exists() {
  kind get clusters | grep -Fxq "$CLUSTER_NAME"
}

should_deploy_stack() {
  case "$DEPLOY_STACK" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
  esac
  if (( cluster_created )); then
    return 0
  fi
  ! kubectl get deployment -n "$NAMESPACE" "${RELEASE}-centaur-api" >/dev/null 2>&1
}

should_load_images() {
  case "$LOAD_IMAGES" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
  esac
  [[ "$BUILD_IMAGES" =~ ^(1|true|yes)$ ]] || (( cluster_created ))
}

trap cleanup EXIT

if [[ "$RECREATE_CLUSTER" =~ ^(1|true|yes)$ ]]; then
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
fi

if ! cluster_exists; then
  kind create cluster --name "$CLUSTER_NAME"
  cluster_created=1
fi

kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

if [[ "$BUILD_IMAGES" =~ ^(1|true|yes)$ ]]; then
  (cd "$ROOT" && just build)
fi

if should_load_images; then
  load_images_into_kind
else
  echo "Skipping kind image load (CENTAUR_E2E_LOAD_IMAGES=${LOAD_IMAGES}, E2E_BUILD=${BUILD_IMAGES}, cluster_created=${cluster_created})"
fi

if should_deploy_stack; then
  CENTAUR_NAMESPACE="$NAMESPACE" \
  CENTAUR_RELEASE="$RELEASE" \
  SLACKBOT_API_KEY="$SLACKBOT_API_KEY" \
  LOCAL_DEV_API_KEY="$LOCAL_DEV_API_KEY" \
  "$ROOT/e2e/deploy/create-ci-secrets.sh"

  helm upgrade --install "$RELEASE" "$ROOT/contrib/chart" \
    -n "$NAMESPACE" --create-namespace \
    -f "$ROOT/e2e/deploy/values.ci.yaml" \
    --set "api.extraEnv.WARM_POOL_SIZE=${WARM_POOL_TARGET}"

  wait_for_api_rollout
else
  echo "Skipping Helm deploy; using existing ${RELEASE} release in namespace ${NAMESPACE}"
fi

wait_for_api_rollout

kubectl port-forward -n "$NAMESPACE" "$API_DEPLOYMENT" "${API_PORT}:8000" >/tmp/centaur-e2e-api-port-forward.log 2>&1 &
pf_pid="$!"
sleep 2

wait_for_warm_pool

cd "$ROOT"
if [[ "$#" -gt 0 ]]; then
  CENTAUR_API_URL="http://localhost:${API_PORT}" \
  SLACKBOT_API_KEY="$SLACKBOT_API_KEY" \
  pnpm --filter @centaur/e2e exec vitest run "$@"
else
  CENTAUR_API_URL="http://localhost:${API_PORT}" \
  SLACKBOT_API_KEY="$SLACKBOT_API_KEY" \
  pnpm run e2e:test
fi
