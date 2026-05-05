#!/bin/sh
set -eu

CONFIG_DIR="/etc/iron-proxy"
CONFIG_FILE="$CONFIG_DIR/proxy.yaml"
DEFAULT_CONFIG="/usr/local/share/iron-proxy/proxy.yaml.default"
CA_CERT="$CONFIG_DIR/ca.crt"
CA_KEY="$CONFIG_DIR/ca.key"
CERT_SHARE="/certs"
SECRET_MANAGER_URL="${SECRET_MANAGER_URL:-http://secrets:8100}"

log_json() {
    printf '{"timestamp":"%s","level":"%s","service":"iron-proxy","event":"%s","msg":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3"
}

mkdir -p "$CONFIG_DIR" "$CERT_SHARE"

# `set -C` + `>` opens the file with O_EXCL — atomic create-only, no TOCTOU
# race with a concurrent writer (cp -n / mv -n are check-then-write).
if (set -C; cat "$DEFAULT_CONFIG" > "$CONFIG_FILE") 2>/dev/null; then
    log_json "info" "config_seeded" "seeded $CONFIG_FILE from default"
fi

# ── Load persistent CA if available (fast, non-blocking) ──────────────────
SECRET_CA_CERT=$(curl -sf --max-time 2 "${SECRET_MANAGER_URL}/secrets/FIREWALL_CA_CERT" | jq -r '.value // empty' 2>/dev/null || true)
SECRET_CA_KEY=$(curl -sf --max-time 2 "${SECRET_MANAGER_URL}/secrets/FIREWALL_CA_KEY" | jq -r '.value // empty' 2>/dev/null || true)

if [ -n "$SECRET_CA_CERT" ] && [ -n "$SECRET_CA_KEY" ]; then
    printf '%s\n' "$SECRET_CA_CERT" > "$CA_CERT"
    printf '%s\n' "$SECRET_CA_KEY" > "$CA_KEY"
    chmod 600 "$CA_KEY"
    log_json "info" "ca_loaded" "loaded CA from secrets service"
elif [ ! -f "$CA_CERT" ] || [ ! -f "$CA_KEY" ]; then
    log_json "info" "ca_autogen" "no CA in secrets — generating locally"
    openssl genrsa -out "$CA_KEY" 4096
    openssl req -x509 -new -nodes \
        -key "$CA_KEY" -sha256 -days 3650 \
        -subj "/CN=centaur iron-proxy CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign" \
        -out "$CA_CERT"
fi
unset SECRET_CA_CERT SECRET_CA_KEY

# ── Share CA cert with sandboxes ──────────────────────────────────────────
cp "$CA_CERT" "$CERT_SHARE/ca-cert.pem"
log_json "info" "ca_shared" "CA cert shared at /certs/ca-cert.pem"

exec iron-proxy -config "$CONFIG_FILE"
