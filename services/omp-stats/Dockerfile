# syntax=docker/dockerfile:1.7

# Thin HTTP wrapper around `omp stats` + `omp --export`. Mirrors the sandbox
# image's omp/bun install mechanics (services/sandbox/Dockerfile) but drops
# every agent toolchain not needed for serving transcripts.

FROM oven/bun:1.3.14-slim AS base

ARG OMP_VERSION=16.3.5
# omp's npm bin shim is a `#!/usr/bin/env bun` script, so bun must be on PATH
# before omp can be verified. The base image ships bun; the version pin below
# only guards against drift if the base is rebased.
ARG BUN_VERSION=bun-v1.3.14

RUN apt-get update \
    && apt-get install -y --no-install-recommends tar ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# omp ships its own bundled runtime; install it globally the same way the
# sandbox image does (npm -g @oh-my-pi/pi-coding-agent). Verification runs
# after bun is already on PATH from the base image.
RUN npm install -g --prefer-online --force \
      "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
    && omp --version | grep -F "${OMP_VERSION}"

# Non-root user; the app never needs root and the PVC is owned by this uid.
RUN useradd -m -s /bin/bash -u 1001 app
USER app
WORKDIR /home/app

# App code. COPY --chown keeps the uid right without a chown layer.
COPY --chown=1001:1001 package.json bun.lockb ./
COPY --chown=1001:1001 src/ src/

RUN bun install --prod --frozen-lockfile

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["bun", "src/index.ts"]
