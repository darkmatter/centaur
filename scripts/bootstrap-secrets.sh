#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Shared secret bootstrap — sources into any entrypoint.
#
# Usage:
#   source /path/to/bootstrap-secrets.sh
#   bootstrap_required_secrets KEY1 KEY2 KEY3
#
# Requires SECRET_MANAGER_URL to be set. Fails hard if secrets cannot be
# resolved after MAX_RETRIES attempts. This is intentional — services that
# cannot get their secrets should crash, not run in a broken state.
# ---------------------------------------------------------------------------

BOOTSTRAP_MAX_RETRIES="${BOOTSTRAP_MAX_RETRIES:-30}"
BOOTSTRAP_RETRY_DELAY="${BOOTSTRAP_RETRY_DELAY:-2}"

_fetch_secret() {
  local key="$1"
  curl -fsS --max-time 5 "${SECRET_MANAGER_URL}/secrets/${key}" \
    | jq -er '.value | select(type == "string" and length > 0)'
}

bootstrap_required_secrets() {
  local missing=()
  local key val attempt

  for key in "$@"; do
    [[ -n "${!key:-}" ]] || missing+=("$key")
  done

  (( ${#missing[@]} == 0 )) && return 0

  if [[ -z "${SECRET_MANAGER_URL:-}" ]]; then
    echo "FATAL: SECRET_MANAGER_URL is not set — cannot resolve: ${missing[*]}" >&2
    exit 1
  fi

  for attempt in $(seq 1 "$BOOTSTRAP_MAX_RETRIES"); do
    local next_missing=()

    for key in "${missing[@]}"; do
      [[ -n "${!key:-}" ]] && continue

      if val="$(_fetch_secret "$key")"; then
        printf -v "$key" '%s' "$val"
        export "$key"
      else
        next_missing+=("$key")
      fi
    done

    if (( ${#next_missing[@]} == 0 )); then
      echo "All secrets resolved." >&2
      return 0
    fi

    echo "Waiting for secrets (${attempt}/${BOOTSTRAP_MAX_RETRIES}): ${next_missing[*]}" >&2
    sleep "$BOOTSTRAP_RETRY_DELAY"
    missing=("${next_missing[@]}")
  done

  echo "FATAL: could not resolve secrets after ${BOOTSTRAP_MAX_RETRIES} attempts: ${missing[*]}" >&2
  exit 1
}
