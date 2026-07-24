# centaur-collab-relay

Single-port native OMP collaboration relay and browser client image.

The service serves:

- `GET /healthz` — `{"ok":true}` readiness/liveness response.
- `GET /` and static assets — the exact upstream `@oh-my-pi/collab-web` SPA.
- `GET /r/<roomId>?role=host|guest` — the native OMP WebSocket relay contract.

The relay is content-blind: OMP frames remain sealed end-to-end. Rooms are held
only in the process heap. A graceful shutdown or container restart closes active
rooms and a guest joining the old room receives close code `4004` (`no such
room`). The process listens on port `7466` and runs as uid/gid `1001`.

## Upstream provenance

The web client is built from the immutable upstream source revision:

- Repository: `can1357/oh-my-pi`
- Tag: `v17.0.5`
- Commit: `9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- Source path: `packages/collab-web`

The Dockerfile downloads the full-commit archive, verifies that the tag resolves
to the expected commit, and runs the upstream workspace build. The relay
handlers in `src/relay.ts` are a mechanical extraction of the upstream
`packages/collab-web/scripts/local-relay.ts` implementation; the protocol
handlers are unchanged and the upstream link/envelope codec is retained
verbatim at `upstream/src/lib/link.ts`.

## Local development

```sh
bun install
bun run check:types
bun test test
bun src/server.ts
```

The test suite exercises HTTP health/static serving, the full native host/guest
WebSocket flow (opaque envelope routing, peer controls, duplicate-host and
missing-room close codes), and room invalidation after shutdown.

## Image build and smoke

Build from the service directory with the repository recipe:

```sh
docker build --tag centaur-collab-relay:local \
  --file services/collab-relay/Dockerfile services/collab-relay
```

Run locally and check the service:

```sh
docker run --rm --name centaur-collab-relay \
  --publish 7466:7466 centaur-collab-relay:local
curl -fsS http://127.0.0.1:7466/healthz
```

The publication workflow pushes only immutable long SHA tags:

```text
ghcr.io/darkmatter/centaur-collab-relay:sha-<40-character-git-commit>
```

No `latest`, branch, or other mutable source/image tag is used for this image.
