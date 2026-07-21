import { mkdirSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { createHandler } from "./server.ts";
import { startStatsChild } from "./stats-child.ts";
import { createSource, syncOnce } from "./sync.ts";

const cfg = loadConfig();
for (const dir of [cfg.homeDir, cfg.sessionsRoot, cfg.tmpDir, cfg.corporaDir, cfg.exportCacheDir]) {
  mkdirSync(dir, { recursive: true });
}

const log = (msg: string): void => console.log(`[omp-stats] ${msg}`);

const source = createSource(cfg);
if (source) {
  log(`corpus source: ${source.describe()}`);
  // Initial sync before serving so the first dashboard render has data, but
  // an unreachable source must not keep the pod from coming up: the interval
  // loop retries.
  try {
    const result = await syncOnce(cfg, source, { notify: false, log });
    log(`initial sync: ${result.changed.length} changed of ${result.total} corpora`);
  } catch (err) {
    log(`initial sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  log("no corpus source configured (set TRANSCRIPTS_S3_BUCKET or TRANSCRIPTS_DIR); sync disabled");
}

const statsChild = startStatsChild(cfg, log);

if (source) {
  // Chained timeout instead of setInterval so slow passes never overlap.
  const scheduleSync = (): void => {
    setTimeout(async () => {
      try {
        const result = await syncOnce(cfg, source, { log });
        if (result.changed.length > 0) {
          log(`sync: ${result.changed.length} changed of ${result.total} corpora`);
        }
      } catch (err) {
        log(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      scheduleSync();
    }, cfg.syncIntervalSeconds * 1000);
  };
  scheduleSync();
}

const server = Bun.serve({
  port: cfg.port,
  idleTimeout: 120,
  fetch: createHandler(cfg),
});
log(`listening on :${server.port} (stats dashboard child on :${cfg.statsPort})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    statsChild.stop();
    server.stop(true);
    process.exit(0);
  });
}
