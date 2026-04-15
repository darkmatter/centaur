# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04 AS toolchain

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

# ── Python deps ──────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    pip3 install --break-system-packages \
    python-docx==1.2.0 lxml==6.0.2 docx-revisions==0.1.4 \
    matplotlib==3.10.8 numpy==2.4.4 pandas==3.0.2 \
    python-pptx==1.0.2 openpyxl==3.1.5 PyMuPDF==1.27.2 mammoth==1.12.0

# ── GitHub CLI + Node.js 22 + Docker CLI (single layer, cached) ─────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update && apt-get install -y gh nodejs docker-ce-cli docker-compose-plugin

# ── Non-root agent user ─────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash -u 1001 agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent

# ── Global npm CLIs (root, cached) ──────────────────────────────────────────
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g @anthropic-ai/claude-code@1.0.16 @openai/codex@0.121.0 @mariozechner/pi-coding-agent@0.67.2 agent-browser@0.25.4

USER agent
WORKDIR /home/agent

ENV PATH="/home/agent/.cargo/bin:/home/agent/.local/bin:/home/agent/.foundry/bin:${PATH}"

ARG AMP_CLI_VERSION=0.0.1774529752-g94f44d

# ── Agent-scoped toolchains ─────────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN curl -L https://foundry.paradigm.xyz | bash \
    && /home/agent/.foundry/bin/foundryup
RUN set -eux; \
    amp_platform="$(case "$(dpkg --print-architecture)" in \
      amd64) echo linux-x64 ;; \
      arm64) echo linux-arm64 ;; \
      *) echo unsupported-architecture >&2; exit 1 ;; \
    esac)"; \
    mkdir -p "$HOME/.amp/bin" "$HOME/.local/bin"; \
    curl -fsSL "https://static.ampcode.com/cli/${AMP_CLI_VERSION}/${amp_platform}-amp.sha256" -o /tmp/amp.sha256; \
    curl -fsSL "https://static.ampcode.com/cli/${AMP_CLI_VERSION}/amp-${amp_platform}" -o "$HOME/.amp/bin/amp"; \
    echo "$(cat /tmp/amp.sha256)  $HOME/.amp/bin/amp" | sha256sum -c -; \
    chmod +x "$HOME/.amp/bin/amp"; \
    ln -sf "$HOME/.amp/bin/amp" "$HOME/.local/bin/amp"; \
    rm -f /tmp/amp.sha256

# ── agent-browser (Chromium + system deps — heavy, keep isolated) ────────────
# Chrome for Testing doesn't provide Linux ARM64 builds; fall back to system chromium
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      agent-browser install --with-deps; \
    else \
      apt-get update && apt-get install -y --no-install-recommends chromium-browser || true \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ── Agent skills + workspace setup (rarely changes) ─────────────────────────
RUN npx -y skills add vercel-labs/agent-browser
RUN mkdir -p ~/.amp/bin ~/.config/amp ~/.codex ~/.pi/agent ~/github ~/workspace \
    && git config --global init.defaultBranch main \
    && git config --global push.autoSetupRemote true \
    && git config --global --add safe.directory '*' \
    && git config --global user.name "Paradigm AI" \
    && git config --global user.email "ai@paradigm.xyz"

# ==============================================================================
# Final thin stage: only frequently-changing local files below.
# Changing harness_session.py / SYSTEM_PROMPT.md / entrypoint.sh rebuilds only
# the COPY layers — the entire toolchain stage stays cached.
# ==============================================================================

FROM toolchain AS sandbox

USER root
COPY --link --chmod=755 services/sandbox/call.sh /usr/local/bin/call
COPY --link --chmod=755 services/sandbox/slack-upload.sh /usr/local/bin/slack-upload
COPY --link --chmod=755 services/sandbox/md2docx.py /usr/local/bin/md2docx
COPY --link --chmod=755 services/sandbox/amp-wrapper.py /usr/local/bin/amp-wrapper
COPY --link --chmod=755 services/sandbox/git-branch.sh /usr/local/bin/git-branch
COPY --link --chmod=755 services/sandbox/entrypoint.sh /entrypoint.sh

USER agent
WORKDIR /home/agent

# No RUN instructions after these — all repo-local content at the very end.
COPY --link --chown=1001:1001 .agents/skills/ /home/agent/.agents/skills/
COPY --link --chown=1001:1001 services/sandbox/SYSTEM_PROMPT.md /home/agent/AGENTS.md

ENTRYPOINT ["/entrypoint.sh"]
# Default CMD uses amp-wrapper which handles follow-handoff chaining;
# docker.py overrides via command= for other engines.
CMD ["amp-wrapper"]
