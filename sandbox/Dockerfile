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
    && apt-get install -y gh nodejs

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

# ── Harness CLIs (amp, claude-code, codex) ───────────────────────────────────
RUN curl -fsSL https://ampcode.com/install.sh | bash
USER root
RUN npm install -g @anthropic-ai/claude-code @openai/codex
USER agent

# ── Agent workspace setup (rarely changes) ──────────────────────────────────
RUN mkdir -p ~/.amp/bin ~/.config/amp ~/.codex ~/github ~/workspace \
    && ln -s ~/.amp/bin/amp ~/.amp/bin/amp 2>/dev/null || true \
    && git config --global init.defaultBranch main \
    && git config --global push.autoSetupRemote true \
    && git config --global --add safe.directory '*'

# ── Config templates (change occasionally) ──────────────────────────────────
COPY --chown=agent:agent config/amp-settings.json   /home/agent/.config/amp/settings.json.tmpl
COPY --chown=agent:agent config/claude-settings.json /home/agent/.claude.json.tmpl
COPY --chown=agent:agent config/codex-config.toml    /home/agent/.codex/config.toml.tmpl

# ── Entrypoint (changes rarely) ─────────────────────────────────────────────
COPY --chmod=755 entrypoint.sh /entrypoint.sh

# ── System prompt (changes most often — last for best caching) ──────────────
COPY --chown=agent:agent SYSTEM_PROMPT.md /home/agent/AGENTS.md

WORKDIR /home/agent/workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
