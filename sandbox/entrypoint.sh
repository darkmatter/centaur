#!/bin/bash
set -e

HOME_DIR="$(eval echo ~)"
MCP_URL="${AI_V2_API_URL:-http://localhost:8000}/mcp/"
MCP_KEY="${AI_V2_API_KEY:-}"

# ── Trust firewall proxy CA (if proxy mode is active) ────────────────────────
if [ -f /firewall-certs/ca-cert.pem ]; then
    sudo cp /firewall-certs/ca-cert.pem /usr/local/share/ca-certificates/firewall-ca.crt
    sudo update-ca-certificates --fresh > /dev/null 2>&1
fi

# ── Write harness configs (no MCP — adds ~10s startup overhead) ───────────────
cat > "$HOME_DIR/.config/amp/settings.json" <<EOF
{"amp.experimental.compaction":95}
EOF

# ── Pi-mono settings ─────────────────────────────────────────────────────────
mkdir -p "$HOME_DIR/.pi/agent/extensions"
cat > "$HOME_DIR/.pi/agent/settings.json" <<EOF
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "thinkingLevel": "medium",
  "autoCompaction": true
}
EOF

# ── Writable worktree ────────────────────────────────────────────────────────
if [ -n "${AGENT_REPO:-}" ] && [ -d "$HOME_DIR/github/$AGENT_REPO/.git" ]; then
    BRANCH="agent-$(date +%s)"
    git -C "$HOME_DIR/github/$AGENT_REPO" worktree add "$HOME_DIR/workspace" -b "$BRANCH" HEAD --quiet
fi

# ── Select system prompt based on persona ────────────────────────────────────
PERSONA_UPPER="$(echo "${AGENT_PERSONA:-}" | tr '[:lower:]' '[:upper:]')"
BASE_PROMPT="$HOME_DIR/AGENTS.md"
PERSONA_PROMPT="$HOME_DIR/AGENTS_${PERSONA_UPPER}.md"
TARGET_PROMPT="$HOME_DIR/workspace/AGENTS.md"
if [ -d "$HOME_DIR/workspace" ] && [ -f "$BASE_PROMPT" ]; then
    if [ -n "$PERSONA_UPPER" ] && [ -f "$PERSONA_PROMPT" ]; then
        {
            echo "# Persona Overlay: ${PERSONA_UPPER}"
            echo
            cat "$PERSONA_PROMPT"
            echo
            echo "---"
            echo
            cat "$BASE_PROMPT"
        } > "$TARGET_PROMPT" 2>/dev/null || true
    else
        cp "$BASE_PROMPT" "$TARGET_PROMPT" 2>/dev/null || true
    fi
fi

# Signal readiness
touch "$HOME_DIR/.ready"

# ── Background: slow auth tasks ─────────────────────────────────────────────
{
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        git config --global credential.helper store
        printf 'https://oauth2:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME_DIR/.git-credentials"
        echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
        gh auth setup-git 2>/dev/null || true
    fi
    CODEX_KEY="${CODEX_API_KEY:-${OPENAI_API_KEY:-}}"
    if [ -n "$CODEX_KEY" ]; then
        echo "$CODEX_KEY" | codex login --with-api-key 2>/dev/null || true
    fi
} &

exec "$@"
