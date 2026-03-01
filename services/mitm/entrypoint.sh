#!/usr/bin/env bash
set -euo pipefail

# ── MITM Proxy Entrypoint ─────────────────────────────────────────────────
# 1. Fetch CA cert+key from secrets service (for stateless scaling)
# 2. Share public CA cert via Docker volume (for sandbox trust)
# 3. Start mitmdump with the credential-injection addon

CONFDIR="/home/mitmproxy/.mitmproxy"
CERT_SHARE="/certs"
SECRET_MANAGER_URL="${SECRET_MANAGER_URL:-http://secrets:8100}"

mkdir -p "$CONFDIR" "$CERT_SHARE"

# ── Load CA from secrets service ──────────────────────────────────────────
# Stored as two separate 1PW items: MITM_CA_CERT and MITM_CA_KEY
echo "[mitm] fetching CA from secrets service..."

CA_CERT=""
CA_KEY=""

# Wait for secrets service (with retry)
for i in $(seq 1 30); do
    if curl -sf "${SECRET_MANAGER_URL}/health" > /dev/null 2>&1; then
        CA_CERT=$(curl -sf "${SECRET_MANAGER_URL}/secrets/MITM_CA_CERT" | jq -r '.value // empty' 2>/dev/null || true)
        CA_KEY=$(curl -sf "${SECRET_MANAGER_URL}/secrets/MITM_CA_KEY" | jq -r '.value // empty' 2>/dev/null || true)
        break
    fi
    echo "[mitm] waiting for secrets service... ($i/30)"
    sleep 2
done

if [ -n "$CA_CERT" ] && [ -n "$CA_KEY" ]; then
    # mitmproxy expects key + cert combined in mitmproxy-ca.pem
    printf '%s\n%s\n' "$CA_KEY" "$CA_CERT" > "$CONFDIR/mitmproxy-ca.pem"
    echo "[mitm] loaded CA from secrets service"
else
    echo "[mitm] no CA in secrets service — mitmproxy will auto-generate"
    echo "[mitm] run: scripts/generate-mitm-ca.sh to create a persistent CA"
fi

# ── Share public cert with sandboxes (via Docker volume) ──────────────────
# mitmproxy creates mitmproxy-ca-cert.pem on first start from mitmproxy-ca.pem
(
    # Wait for mitmproxy to generate/load the cert
    for _ in $(seq 1 60); do
        [ -f "$CONFDIR/mitmproxy-ca-cert.pem" ] && break
        sleep 0.5
    done
    if [ -f "$CONFDIR/mitmproxy-ca-cert.pem" ]; then
        cp "$CONFDIR/mitmproxy-ca-cert.pem" "$CERT_SHARE/ca-cert.pem"
        echo "[mitm] CA cert shared at /certs/ca-cert.pem"
    else
        echo "[mitm] WARNING: CA cert not found after timeout"
    fi
) &

# ── Wipe secret material from env/shell ───────────────────────────────────
unset CA_CERT CA_KEY

# ── Start mitmdump ────────────────────────────────────────────────────────
exec mitmdump \
    --listen-port 8080 \
    --set confdir="$CONFDIR" \
    --set connection_strategy=lazy \
    -s /app/addon.py \
    "$@"
