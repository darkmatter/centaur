# syntax=docker/dockerfile:1.7

# Thin HTTP wrapper around `omp stats` + `omp --export`. Mirrors the sandbox
# image's omp/bun install mechanics (services/sandbox/Dockerfile) but drops
# every agent toolchain not needed for serving transcripts.

FROM oven/bun:1.3.14-slim AS base

ARG OMP_VERSION=16.3.5
ENV BUN_INSTALL=/opt/bun-global
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends tar ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# omp ships its own bundled runtime. Keep the global package and executable
# outside /root so the non-root runtime user can execute it.
RUN bun install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
    && omp --version | grep -F "${OMP_VERSION}"

# Non-root user; the app never needs root and the PVC is owned by this uid.
RUN useradd -m -s /bin/bash -u 1001 app
USER app
WORKDIR /home/app

# App code. COPY --chown keeps the uid right without a chown layer.
COPY --chown=1001:1001 package.json bun.lock ./
COPY --chown=1001:1001 src/ src/

RUN bun install --prod --frozen-lockfile

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["bun", "src/index.ts"]
