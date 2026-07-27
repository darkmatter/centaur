# syntax=docker/dockerfile:1.7

# centaur-collab-relay — native OMP collab relay + web client image.
#
# Serves the exact upstream oh-my-pi collab-web WebSocket relay contract
# (/r/<roomId>?role=host|guest) and the prebuilt static browser client over a
# single port (7466), unprivileged. The relay protocol is the vendored
# upstream implementation (src/relay.ts, byte-identical to
# packages/collab-web/scripts/local-relay.ts at the pinned tag); this image
# owns only the composite HTTP/static-file glue (src/server.ts) and the build.

# ─── fetch: download + verify the upstream source ──────────────────────────
FROM oven/bun:1.3.14-slim AS fetch

ARG OMP_TAG=v17.0.5
ARG OMP_COMMIT=9fd6e97113f5ed3a847e66d346970efdf8afcad9
ARG OMP_COMMIT_ASSERT=9fd6e97113f5ed3a847e66d346970efdf8afcad9

RUN apt-get update \
    && apt-get install -y --no-install-recommends tar curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Fetch by full commit sha (content-addressable; immutable). The tag check
# prevents accidentally using a sha that is not the documented release tag.
RUN curl -fsSL "https://codeload.github.com/can1357/oh-my-pi/tar.gz/${OMP_COMMIT}" -o omp.tar.gz
RUN curl -fsSL "https://api.github.com/repos/can1357/oh-my-pi/git/refs/tags/${OMP_TAG}" \
      | grep -F "${OMP_COMMIT_ASSERT}" \
    || { echo "tag ${OMP_TAG} does not point at ${OMP_COMMIT_ASSERT}" >&2; exit 1; }
RUN mkdir -p /omp && tar -xzf omp.tar.gz -C /omp --strip-components=1 \
    && rm -f omp.tar.gz

# ─── build: build the static SPA from the pinned upstream workspace ─────────
FROM oven/bun:1.3.14-slim AS build

COPY --from=fetch /omp /build/omp
WORKDIR /build/omp
# The upstream workspace catalog and lockfile resolve all private collab-web
# source deps (including the published pi-wire contract) exactly as upstream.
RUN bun install --frozen-lockfile
RUN bun --cwd=packages/collab-web run build
RUN test -f packages/collab-web/dist/index.html && test -s packages/collab-web/dist/index.html

# ─── runtime: minimal unprivileged relay + static client ───────────────────
FROM oven/bun:1.3.14-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user; matches the gitops deployment's runAsUser/runAsGroup/fsGroup.
RUN useradd -m -s /bin/bash -u 1001 app
USER app
WORKDIR /home/app

# Runtime dependency: only @oh-my-pi/pi-wire (the vendored link.ts imports it
# for wire-envelope constants). The relay server has no other dependencies.
COPY --chown=1001:1001 package.json bun.lock ./
RUN bun install --prod --frozen-lockfile

# App code: centaur-owned composite server + vendored upstream relay protocol
# and link codec (byte-identical to the pinned tag).
COPY --chown=1001:1001 src/ src/
COPY --chown=1001:1001 upstream/ upstream/

# Static client built from the exact upstream source above.
COPY --chown=1001:1001 --from=build /build/omp/packages/collab-web/dist/ dist/

ENV NODE_ENV=production \
    PORT=7466 \
    WEB_ROOT=dist

EXPOSE 7466

ENTRYPOINT ["bun", "src/server.ts"]
