# RFC 0005: App Plane MVP — Harness Transcript Export and Usage Stats

Status: Draft
Owner: TBD
Target: `services/api-rs`, `services/sandbox`, `crates/harness-server`, `contrib/chart`, `services/console`, `services/slackbotv2`

## Summary

Expose two omp harness features to Centaur users through the browser:

- **Export**: render a session's harness transcript as a self-contained HTML
  page (`omp --export <session.jsonl> [out.html]`).
- **Stats**: the fleet-wide usage dashboard (`omp stats`), aggregating token,
  cost, model, and folder metrics from omp session JSONL files.

Both are pure functions of omp session JSONL files. The design makes those
files durable, syncs them out of sandboxes at execution end, and serves both
features from one long-running **app** — the first concrete slice of the app
plane sketched in `docs/pages/extend/apps.mdx`. The MVP ships the app plane's
runtime and routing contract (one Deployment/Service/NetworkPolicy, API-routed
`/apps/{name}/...`) with a static chart-managed registry, deferring the
DB-backed reconciler.

A prerequisite fix falls out of the design: omp session storage and session
identity are not durable today, so omp transcript continuity already breaks
across sandbox replacement. Phase 0 fixes that independently of the app plane.

## Motivation

Interactive omp users get `/export` (transcript HTML, opened in a browser) and
`/stats` (local dashboard server). Centaur sessions run omp headless inside
Kubernetes sandboxes: there is no browser, no user-reachable port, and the
session files live on per-pod filesystems. Meanwhile the apps design doc
proposes exactly the machinery these features need — an internal PaaS surface
behind the company boundary — but has no implementation. These two features are
a well-scoped forcing function for its first slice.

## Background (verified against current code)

### omp launch and session storage

`crates/harness-server/src/omp.rs` spawns one omp process per turn:

```
omp -p --mode json --auto-approve --session-dir <dir> [-r <session-id>] [--model <m>] -- <prompt>
```

- `<dir>` comes from `omp_session_dir()` (`omp.rs:406-415`): `OMP_SESSION_DIR`
  env when set, else `$HOME/.omp-harness-sessions`. **Not** `~/.omp/agent/`,
  and not on the state PVC — `services/sandbox/entrypoint.sh` persists only
  `codex/`, `claude/`, `uploads/`, `branches/` to `$STATE_DIR`.
- omp's first stdout line is a `session` event carrying the durable omp
  session id; subsequent turns resume it with `-r`.

### Session identity is bridge-local, not durable

- harness-server mints the bridge thread id as a fresh UUIDv4
  (`traits.rs:100`) and reports it in `thread.started`
  (`server.rs:948-958`, `turn.rs:284-292`). api-rs persists that bridge id as
  `sessions.harness_thread_id`.
- The actual omp session id (from the `session` stdout event) only updates
  harness-server's in-memory `state.harness_session_id`
  (`server.rs:1277-1279`). It is never persisted anywhere.
- On `thread/resume`, harness-server seeds `harness_session_id` from
  `params.thread_id` — the bridge UUID (`server.rs:986`). After a sandbox
  replacement, the next turn runs `omp -r <bridge-uuid>`, an id omp never
  issued. omp transcript continuity across sandbox replacement is therefore
  already broken; the exact failure mode (error vs fresh session) needs an
  empirical check during implementation.

Any export/sync keyed on `harness_thread_id` alone would inherit this broken
mapping. Phase 0 must establish a durable bridge-id → omp-session-id mapping.

### Control-plane facts the design builds on

- `exec_in_session_sandbox(thread_key, argv)`
  (`centaur-session-runtime/src/lib.rs`) runs a command in a session's live
  sandbox; precedent: `POST /api/session/{key}/workspace-diff` with an output
  size cap. Requires a live sandbox; the exec channel is kubelet-side, so it
  needs no pod-network allowance.
- Networking is default-deny. Sandboxes have no ingress; egress goes to the
  per-sandbox iron-proxy and (capability-gated) the control plane.
- The console is the only human-facing authenticated web surface (SSO cookie,
  own ingress, existing threads UI). api-rs is cluster-internal.
- api-rs already carries S3 plumbing (`aws_sdk_s3`, presigned PUT) for Slack
  archive imports.

## Design

### Phase 0 — durable omp session storage and identity

1. **Storage**: `services/sandbox/entrypoint.sh` exports
   `OMP_SESSION_DIR="$STATE_DIR/omp-sessions"` (created alongside the existing
   `$STATE_DIR` subdirs) when persistent state is available. harness-server
   already honors the env var; no code change there for storage.
2. **Identity mapping**: harness-server maintains
   `$OMP_SESSION_DIR/thread-map.json`, a small `{bridge_thread_id: omp_session_id}`
   map:
   - written when the `session` event first resolves an omp session id for a
     thread (the same point that updates `state.harness_session_id`);
   - consulted by `resumed_thread_state` / `command_for_turn` so a post-restart
     `thread/resume` maps the bridge UUID to the real omp session id before
     building `-r`.
   The map rides the same PVC as the sessions it describes, so storage and
   identity stay consistent as a unit.

   *Alternative considered*: surface the omp session id to api-rs through a
   session event and persist it in Postgres. More inspectable, but it crosses
   the app-server protocol boundary and adds a schema change for something only
   the sandbox-side resume path and the sync step need. The map file needs
   neither; the Postgres column can come later if other consumers appear.

Phase 0 stands alone: it fixes omp resume-after-replacement regardless of
whether the rest of this RFC ships.

### Phase 1 — transcript sync at execution end

When an execution reaches a terminal state and `harness_type` is omp, the
session runtime pulls the transcript corpus out of the sandbox and archives it:

- `exec_in_session_sandbox`: tar+gzip `$OMP_SESSION_DIR` (JSONLs plus
  `thread-map.json`), size-capped like the workspace-diff artifact.
- PUT to `s3://$CENTAUR_TRANSCRIPTS_BUCKET/transcripts/<encoded thread_key>/corpus.tar.gz`
  (reusing the existing S3 client configuration surface). Idempotent
  overwrite; last execution wins. A sandbox maps 1:1 to a thread key, so
  uploading the whole directory sidesteps per-file identity resolution — the
  map file travels with the corpus for consumers that need it.
- Failures are logged and non-fatal to the execution result: sync is an
  archival concern, not a delivery obligation.

Push-at-execution-end beats pull-on-demand: it works after the sandbox is
paused, replaced, or deleted, and grants sandboxes no new capability.

### Phase 2 — the `omp-stats` app (app plane MVP)

One chart-managed "system app" whose runtime shape matches
`docs/pages/extend/apps.mdx`, so it can migrate onto the future `POST /apps`
registry unchanged:

- **Workload** (`contrib/chart`): Deployment + Service + PVC + NetworkPolicy.
  Image: pinned omp plus a thin HTTP wrapper. No ServiceAccount token,
  `allowPrivilegeEscalation: false`, dropped capabilities. Ingress only from
  api-rs on the declared port; egress only DNS and the object-storage
  endpoint.
- **Sync loop**: list/get `transcripts/**` from the bucket, unpack per-thread
  corpora into a local sessions directory laid out where omp expects it, then
  rebuild the stats DB (`syncAllSessions()` from `@oh-my-pi/omp-stats`, or
  `omp stats`'s own sync-on-start).
- **Web process**:
  - `/` → the `omp stats` dashboard (fleet-wide usage).
  - `/export/{thread_key}` → resolve the thread's newest omp session JSONL via
    the synced `thread-map.json` (fallback: newest JSONL in the corpus), run
    `omp --export <file> <tmp>.html`, cache the HTML next to the corpus keyed
    by corpus mtime, serve `text/html`.
- **Routing** (api-rs): `ANY /apps/{name}/*path` proxy, per the apps doc — the
  API strips inbound auth headers and injects `x-centaur-app`. The registry
  behind the route is static configuration
  (`values.yaml: apps:`) for the MVP. This is the forward-compatible seam: the
  route and header contract stay; only the registry source changes when the
  reconciler lands.
- **Human access** (console): `GET /console/apps/{name}/*` — console session
  auth (SSO cookie), then reverse-proxy to api-rs with the console's internal
  credential. Humans never need direct api-rs exposure; the existing
  console→api-rs NetworkPolicy allowance covers the hop.

### Phase 3 — user-facing wiring

- **Console threads view**: an "Export HTML" link per thread and a "Usage"
  nav entry, both deep links into `/console/apps/omp-stats/...`.
- **Slack**: a slackbotv2 message intercept following the `stop-command.ts`
  pattern — "export (this thread)" short-circuits before the harness, calls
  api-rs, and replies with the console deep link. No agent turn, no tokens.
- **Fallback available today**: the agent can run `omp --export` in its own
  sandbox and `slack upload` the HTML (download-only UX in Slack; not the
  primary path).

## Security

- Transcripts can contain sensitive tool output. All access is gated behind
  console SSO; omp's public `/share` path is never wired.
- Real credentials should not appear in transcripts (iron-proxy placeholder
  injection), but the transcripts bucket is treated as secret-bearing:
  private, scoped prefix, credentials managed like other chart secrets.
- The app pod follows the apps-doc security shape (no SA token, API-only
  ingress, minimal egress).

## Compatibility with the full app plane

Deliberately deferred from the apps design: the `apps`/`app_releases` schema,
the reconciler, source-clone builds, per-app domains, and app-scoped API keys.
The MVP freezes only the parts these features exercise — the `/apps/{name}/*`
route shape, the header-stripping/identity-injection proxy behavior, and the
per-app workload security posture. A later registry replaces the static
values block without touching the app image, the console proxy, or user-facing
URLs.

## Open questions

- `omp stats` bind address and browser-open behavior headless: only
  `--port/--json/--summary` flags exist today; the app wrapper fronts it and
  must neutralize browser-open (empirically verified during implementation).
- Exact omp behavior for `-r <unknown-id>` (error vs fresh session): determines
  whether the Phase 0 map consult needs a guard for pre-Phase-0 sessions.
- Corpus size caps and retention: per-thread tarball cap, bucket lifecycle
  policy.
- Whether the omp session id should also be persisted in Postgres (session
  metadata) for operator inspection, in addition to the sandbox-local map.
- Non-omp harnesses: out of scope here; the sync step is harness-gated, and
  claude/codex transcripts already persist under their own `$STATE_DIR`
  symlinks.

## Milestones

1. **Phase 0** (`services/sandbox`, `crates/harness-server`): PVC-backed
   `OMP_SESSION_DIR`, `thread-map.json` write/consult, resume-semantics test
   (replace a sandbox, prove `-r` targets the mapped omp id).
2. **Phase 1** (`services/api-rs`): execution-end corpus sync to object
   storage, size-capped, non-fatal on failure.
3. **Phase 2** (`contrib/chart`, app image, `services/api-rs`,
   `services/console`): omp-stats workload, static `/apps/{name}/*` proxy,
   console reverse-proxy and auth gate.
4. **Phase 3** (`services/console`, `services/slackbotv2`): export/usage UI
   links, Slack export intercept.
