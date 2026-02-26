FROM ubuntu:24.04

# System deps
RUN apt-get update && apt-get install -y \
    git curl wget build-essential pkg-config \
    libssl-dev python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install all harness CLIs
RUN curl -fsSL https://ampcode.com/install.sh | bash \
    && cp -L /root/.amp/bin/amp /usr/local/bin/amp
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Non-root user (required by claude-code --dangerously-skip-permissions)
RUN useradd -m -s /bin/bash agent \
    && mkdir -p /repos \
    && chown agent:agent /repos

# Set up agent user's home with amp runtime marker + config dirs
USER agent
RUN mkdir -p ~/.amp/bin ~/.config/amp ~/.codex \
    && ln -s /usr/local/bin/amp ~/.amp/bin/amp
WORKDIR /repos

# Copy pre-cloned repos
COPY --chown=agent:agent repos/ /repos/

# Minimal entrypoint — all config passed inline via CLI flags
COPY --chmod=755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
