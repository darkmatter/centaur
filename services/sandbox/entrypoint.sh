#!/bin/bash
set -e

HOME_DIR="$(eval echo ~)"

# ── Write harness configs (no MCP — adds ~10s startup overhead) ───────────────
cat > "$HOME_DIR/.config/amp/settings.json" <<EOF
{"amp.experimental.compaction":95}
EOF

# ── Pi-mono settings ─────────────────────────────────────────────────────────
mkdir -p "$HOME_DIR/.pi/agent/extensions"
cat > "$HOME_DIR/.pi/agent/settings.json" <<EOF
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "thinkingLevel": "medium",
  "autoCompaction": true
}
EOF

# ── Per-session workspace clone (no shared worktree metadata) ────────────────
WORKSPACE_DIR="$HOME_DIR/workspace"
if [ -n "${AGENT_REPO:-}" ]; then
    REPO_PATH="$HOME_DIR/github/$AGENT_REPO"
    if ! git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1; then
        echo "AGENT_REPO is not a valid git repository: $REPO_PATH" >&2
        exit 1
    fi

    rm -rf "$WORKSPACE_DIR"
    if ! git clone --quiet --shared "$REPO_PATH" "$WORKSPACE_DIR"; then
        echo "shared clone failed for $REPO_PATH; retrying with regular clone" >&2
        rm -rf "$WORKSPACE_DIR"
        git clone --quiet "$REPO_PATH" "$WORKSPACE_DIR"
    fi

    BRANCH="agent-$(date +%s)-${RANDOM}-${RANDOM}"
    git -C "$WORKSPACE_DIR" checkout -q -b "$BRANCH" || true
else
    mkdir -p "$WORKSPACE_DIR"
fi

# ── Copy project skills into workspace (so `skill` tool discovers them) ──────
CENTAUR_SKILLS="$HOME_DIR/github/paradigmxyz/centaur/.agents/skills"
WS_SKILLS="$WORKSPACE_DIR/.agents/skills"
if [ -d "$CENTAUR_SKILLS" ] && [ ! -d "$WS_SKILLS" ]; then
    mkdir -p "$WS_SKILLS"
    cp -r "$CENTAUR_SKILLS"/. "$WS_SKILLS"/
fi

# ── Assemble system prompt from bind mounts ──────────────────────────────────
# Base prompt: bind-mounted by docker.py as AGENTS_BASE.md, fallback to baked-in AGENTS.md
# Persona overlay: bind-mounted persona dir at ~/tools/personas/<name>/PROMPT.md
TARGET_PROMPT="$HOME_DIR/workspace/AGENTS.md"
if [ -f "$HOME_DIR/AGENTS_BASE.md" ]; then
    cp "$HOME_DIR/AGENTS_BASE.md" "$TARGET_PROMPT"
elif [ -f "$HOME_DIR/AGENTS.md" ]; then
    cp "$HOME_DIR/AGENTS.md" "$TARGET_PROMPT"
fi

PERSONA="${AGENT_PERSONA:-}"
if [ -n "$PERSONA" ] && [ -f "$TARGET_PROMPT" ]; then
    OVERLAY="$HOME_DIR/tools/personas/$PERSONA/PROMPT.md"
    if [ -f "$OVERLAY" ]; then
        # Replace generic identity with persona-aware identity so the overlay wins
        sed -i 's/^|You are Paradigm'\''s AI assistant ("centaur")/|You are running the **'"$PERSONA"'** persona. See the persona overlay below for your identity and behavior./' "$TARGET_PROMPT"
        printf '\n\n---\n\n' >> "$TARGET_PROMPT"
        cat "$OVERLAY" >> "$TARGET_PROMPT"
    fi
fi

# Switch to workspace so the harness reads workspace/AGENTS.md (with persona overlay)
cd "$WORKSPACE_DIR"

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
