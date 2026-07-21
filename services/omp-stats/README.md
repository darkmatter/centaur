# centaur-omp-stats

Thin Bun HTTP wrapper around the `omp` CLI exposing two harness features to
Centaur users through the browser:

- **Stats** — the fleet-wide usage dashboard (`omp stats`), reverse-proxied at
  `/`.
- **Export** — a single session's transcript rendered as self-contained HTML
  (`omp --export`), served at `/export/<encoded thread key>`.

The wrapper syncs a corpus of omp session JSONL files out of object storage
(or a local directory for dev/test), lays them out where `omp stats` expects
them, spawns the dashboard as a supervised child, and fronts both features
behind one port.

## Configuration

All config is env-driven (`src/config.ts`).

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Wrapper listen port. |
| `DATA_DIR` | `/data` | Persistent root; everything the app writes lives under here. |
| `STATS_PORT` | `3847` | Port the internal `omp stats` child binds. |
| `TRANSCRIPTS_DIR` | unset | Local corpus source: a directory of `<encoded key>/corpus.tar.gz`. Mutually preferred over S3 when both are set. |
| `TRANSCRIPTS_S3_BUCKET` | unset | Object-storage corpus source (unset = off). |
| `TRANSCRIPTS_S3_PREFIX` | `transcripts` | Key prefix inside the bucket. |
| `TRANSCRIPTS_S3_ENDPOINT` / `TRANSCRIPTS_S3_REGION` | unset | S3 endpoint/region, same envs the slack-archive-import code uses. AWS creds via the standard `AWS_*` envs. |
| `SYNC_INTERVAL_SECONDS` | `300` | Sync-loop cadence. Initial sync runs before serving. |

Children run with `HOME=$DATA_DIR/home`; session JSONLs are extracted under
`$DATA_DIR/home/.omp/agent/sessions/<encoded key>/`.

## Corpus layout

Each corpus is a flat `corpus.tar.gz` (the contents of one omp session dir,
plus an optional `thread-map.json`). Layout in object storage:

```
<prefix>/<encoded thread key>/corpus.tar.gz
```

`<encoded thread key>` percent-encodes per UTF-8 byte, keeping
`[A-Za-z0-9._~-]` and escaping everything else as `%XX` (uppercase hex). The
same encoding is used as a directory name on disk.

## Empirical findings (recorded during implementation against omp 16.5.2)

1. **`omp stats --summary` scans session subdirectories recursively, but not
   the sessions root.** A JSONL flat in the sessions root yields `Synced 0 new
   entries`; the same file one directory down yields `Synced 2 new entries`.
   The wrapper therefore extracts each corpus into a per-key subdirectory
   (`sessions/<encoded key>/`) rather than flattening onto the root.

2. **`omp stats` keeps serving headless when the browser opener fails.** With
   `BROWSER=true` and no graphical session, `openPath()` logs
   `Failed to open external URL/path` and returns; the dashboard prints
   `Dashboard available at: http://localhost:<port>` and
   `Press Ctrl+C to stop`, then continues serving. No `BROWSER=` override is
   required. The wrapper inherits the ambient `HOME`/`BROWSER` envs but points
   `HOME` at the app's data dir so the dashboard scans synced corpora.

3. **The dashboard bundle issues absolute `/api/...` fetches.** Served behind
   a path prefix (`/console/apps/omp-stats/`, `/apps/omp-stats/`) the dashboard
   breaks because `/api/...` resolves to the host root. The wrapper injects a
   small script at the top of every proxied HTML response that (a) forces a
   trailing slash on the page URL so relative asset URLs resolve under the
   prefix, and (b) wraps `window.fetch` to rebase root-relative URLs onto the
   directory the page was served from. The bundle uses `fetch()` exclusively
   (no XHR/WebSocket/EventSource), so patching `fetch` is sufficient. Verified
   behind a throwaway prefix proxy: the rebased
   `/console/apps/omp-stats/api/stats/overview?range=all` returns 200 from the
   real `omp stats` backend through the wrapper.

## Development

```sh
bun install
bun test            # encoding, sync, export, handler/proxy
bun run src/index.ts # serve (needs TRANSCRIPTS_DIR or S3 env)
```

The Dockerfile mirrors the sandbox image's omp/bun install mechanics
(pinned `@oh-my-pi/pi-coding-agent`, bun base image) and runs as a non-root
user with a `/data` volume.
