#!/bin/bash
set -e

HOME_DIR="$(eval echo ~)"
GITHUB_DIR="$HOME_DIR/github"
WORKSPACE_DIR="$HOME_DIR/workspace"
MCP_URL="${AI_V2_API_URL:-http://localhost:8000}/mcp/"
MCP_KEY="${AI_V2_API_KEY:-}"

# ── Git credentials ──────────────────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
    git config --global credential.helper store
    echo "https://oauth2:${GITHUB_TOKEN}@github.com" > "$HOME_DIR/.git-credentials"
    echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
    gh auth setup-git 2>/dev/null || true
fi

# ── MCP configs for all harnesses ────────────────────────────────────────────
if [ -n "$MCP_KEY" ]; then
    # Amp
    mkdir -p "$HOME_DIR/.config/amp"
    cat > "$HOME_DIR/.config/amp/settings.json" <<EOF
{"amp.experimental.compaction":95,"amp.mcpServers":{"tempo-ai":{"url":"${MCP_URL}","headers":{"Authorization":"Bearer ${MCP_KEY}"}}}}
EOF

    # Claude Code
    cat > "$HOME_DIR/.claude.json" <<EOF
{"mcpServers":{"tempo-ai":{"type":"http","url":"${MCP_URL}","headers":{"Authorization":"Bearer ${MCP_KEY}"}}}}
EOF

    # Codex
    mkdir -p "$HOME_DIR/.codex"
    cat > "$HOME_DIR/.codex/config.toml" <<EOF
[mcp_servers.tempo-ai]
url = "${MCP_URL}"
EOF
fi

# ── Codex auth ───────────────────────────────────────────────────────────────
CODEX_KEY="${CODEX_API_KEY:-${OPENAI_API_KEY:-}}"
if [ -n "$CODEX_KEY" ]; then
    if command -v codex >/dev/null 2>&1; then
        echo "$CODEX_KEY" | codex login --with-api-key 2>/dev/null || true
    fi
fi

# ── Writable worktree from mounted repos ─────────────────────────────────────
# AGENT_REPO is set by the agent client (e.g. "paradigmxyz/reth").
# Host ~/github is bind-mounted at ~/github. We create a worktree in ~/workspace
# so the agent works on a disposable branch without touching the main working tree.
if [ -n "${AGENT_REPO:-}" ] && [ -d "$GITHUB_DIR/$AGENT_REPO/.git" ]; then
    echo "Creating worktree for $AGENT_REPO..."
    BRANCH="agent-$(date +%s)"
    git -C "$GITHUB_DIR/$AGENT_REPO" worktree add "$WORKSPACE_DIR" -b "$BRANCH" HEAD --quiet
    echo "Workspace ready at $WORKSPACE_DIR (branch: $BRANCH)"
fi

# Copy system prompt into workspace
if [ -f "$HOME_DIR/AGENTS.md" ] && [ -d "$WORKSPACE_DIR" ]; then
    cp "$HOME_DIR/AGENTS.md" "$WORKSPACE_DIR/AGENTS.md" 2>/dev/null || true
fi

exec "$@"
