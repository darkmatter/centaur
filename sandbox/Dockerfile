FROM ubuntu:24.04

# ── System packages (cached unless base image changes) ───────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    git curl wget ca-certificates gnupg lsb-release sudo \
    build-essential pkg-config cmake ninja-build \
    libssl-dev libclang-dev protobuf-compiler \
    ripgrep fd-find jq tree tmux unzip xz-utils gettext-base \
    python3 python3-pip python3-venv python3-dev \
    procps htop \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ── GitHub CLI + Node.js 22 (single layer, cached) ──────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update && apt-get install -y gh nodejs

# ── Non-root agent user ─────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent
USER agent
WORKDIR /home/agent

# ── Rust (agent user only) ───────────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/agent/.cargo/bin:${PATH}"

# ── uv (agent user only) ────────────────────────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/agent/.local/bin:${PATH}"

# ── Foundry (agent user only) ───────────────────────────────────────────────
RUN curl -L https://foundry.paradigm.xyz | bash \
    && /home/agent/.foundry/bin/foundryup
ENV PATH="/home/agent/.foundry/bin:${PATH}"

# ── Harness CLIs (amp, claude-code, codex, pi-mono) ──────────────────────────
RUN curl -fsSL https://ampcode.com/install.sh | bash
USER root
RUN npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent
USER agent

# ── Agent workspace setup (rarely changes) ──────────────────────────────────
RUN mkdir -p ~/.amp/bin ~/.config/amp ~/.codex ~/.pi/agent ~/github ~/workspace \
    && git config --global init.defaultBranch main \
    && git config --global push.autoSetupRemote true \
    && git config --global --add safe.directory '*'

# ── Entrypoint + helpers (changes rarely) ───────────────────────────────────
COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --chmod=755 call.sh /usr/local/bin/call
COPY --chmod=755 slack-upload.sh /usr/local/bin/slack-upload

# ── Pi-mono extensions (TODO: wire up pi-plugins/ from repo root) ─────────
# COPY --chown=agent:agent pi-plugins/system-prompt.ts /home/agent/.pi/agent/extensions/system-prompt.ts
# COPY --chown=agent:agent pi-plugins/handoff.ts /home/agent/.pi/agent/extensions/handoff.ts
# COPY --chown=agent:agent pi-plugins/tool-harness.ts /home/agent/.pi/agent/extensions/tool-harness.ts
# COPY --chown=agent:agent pi-plugins/tools/ /home/agent/.pi/agent/extensions/tools/

# ── System prompts (changes most often — last for best caching) ─────────────
COPY --chown=agent:agent SYSTEM_PROMPT.md /home/agent/AGENTS.md
COPY --chown=agent:agent SYSTEM_PROMPT_ENG.md /home/agent/AGENTS_ENG.md

WORKDIR /home/agent/workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
