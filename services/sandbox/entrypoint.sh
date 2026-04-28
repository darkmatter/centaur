#!/bin/bash
set -e

HOME_DIR="$(eval echo ~)"
FIREWALL_HOSTNAME="${FIREWALL_HOST:-firewall}"

# ── Write harness configs (no MCP — adds ~10s startup overhead) ───────────────
cat > "$HOME_DIR/.config/amp/settings.json" <<EOF
{
  "amp.experimental.compaction": 95,
  "amp.proxy": "http://${FIREWALL_HOSTNAME}:8080"
}
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

# ── Ensure uploads directory exists ──────────────────────────────────────────
mkdir -p "$HOME_DIR/uploads"

# ── Copy project skills into workspace (so `skill` tool discovers them) ──────
BAKED_IN_CENTAUR_SKILLS="$HOME_DIR/.agents/skills"
MOUNTED_CENTAUR_SKILLS="$HOME_DIR/centaur-skills"
MOUNTED_ORG_SKILLS="$HOME_DIR/centaur-overlay-skills"
OVERLAY_TREE_SKILLS=""
if [ -n "${CENTAUR_OVERLAY_DIR:-}" ] && [ -d "${CENTAUR_OVERLAY_DIR}/.agents/skills" ]; then
    OVERLAY_TREE_SKILLS="${CENTAUR_OVERLAY_DIR}/.agents/skills"
fi
CENTAUR_SKILLS=""
if [ -d "$HOME_DIR/github" ]; then
    CENTAUR_SKILLS="$(find "$HOME_DIR/github" -path '*/centaur/.agents/skills' -type d -print -quit 2>/dev/null || true)"
fi
WS_SKILLS="$WORKSPACE_DIR/.agents/skills"
for SKILLS_SRC in "$BAKED_IN_CENTAUR_SKILLS" "$MOUNTED_CENTAUR_SKILLS" "$CENTAUR_SKILLS" "$MOUNTED_ORG_SKILLS" "$OVERLAY_TREE_SKILLS"; do
    if [ -d "$SKILLS_SRC" ]; then
        mkdir -p "$WS_SKILLS"
        cp -r "$SKILLS_SRC"/. "$WS_SKILLS"/
    fi
done

# ── Assemble system prompt from bind mounts ──────────────────────────────────
# Base prompt: bind-mounted by docker.py as AGENTS_BASE.md, fallback to baked-in AGENTS.md
# Org/persona overlays are bind-mounted alongside the base prompt when present.
TARGET_PROMPT="$HOME_DIR/workspace/AGENTS.md"
if [ -f "$HOME_DIR/AGENTS_BASE.md" ]; then
    cp "$HOME_DIR/AGENTS_BASE.md" "$TARGET_PROMPT"
elif [ -f "$HOME_DIR/AGENTS.md" ]; then
    cp "$HOME_DIR/AGENTS.md" "$TARGET_PROMPT"
fi

if [ -f "$HOME_DIR/AGENTS_OVERLAY.md" ] && [ -f "$TARGET_PROMPT" ]; then
    printf '\n\n---\n\n' >> "$TARGET_PROMPT"
    cat "$HOME_DIR/AGENTS_OVERLAY.md" >> "$TARGET_PROMPT"
fi

PERSONA="${AGENT_PERSONA:-}"
if [ -n "$PERSONA" ] && [ -f "$TARGET_PROMPT" ]; then
    OVERLAY="$HOME_DIR/tools/personas/$PERSONA/PROMPT.md"
    if [ -f "$OVERLAY" ]; then
        # Replace the base identity line so the persona overlay wins.
        sed -i 's/^|You are .*assistant.*$/|You are running the **'"$PERSONA"'** persona. See the persona overlay below for your identity and behavior./' "$TARGET_PROMPT"
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
