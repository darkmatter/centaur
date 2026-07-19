import type { Subprocess } from "bun";

import type { Config } from "./config.ts";

export interface StatsChild {
  stop(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A run this long counts as healthy and resets the backoff.
const HEALTHY_RUN_MS = 60_000;

/**
 * Run `omp stats --port <statsPort>` as a supervised child. HOME is pointed
 * at the app's data dir so the dashboard scans the synced corpora, not
 * whatever the container user's real home contains. The child is restarted
 * with exponential backoff; headless environments are fine because omp only
 * logs a warning when it cannot spawn a browser opener.
 */
export function startStatsChild(cfg: Config, log: (msg: string) => void): StatsChild {
  let stopped = false;
  let current: Subprocess | undefined;
  let backoffMs = INITIAL_BACKOFF_MS;

  const spawnOnce = (): void => {
    if (stopped) return;
    const startedAt = Date.now();
    current = Bun.spawn(["omp", "stats", "--port", String(cfg.statsPort)], {
      env: { ...process.env, HOME: cfg.homeDir },
      cwd: cfg.homeDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    current.exited.then((code) => {
      if (stopped) return;
      if (Date.now() - startedAt >= HEALTHY_RUN_MS) backoffMs = INITIAL_BACKOFF_MS;
      log(`omp stats exited with code ${code}; restarting in ${backoffMs}ms`);
      setTimeout(spawnOnce, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    });
  };

  spawnOnce();
  return {
    stop() {
      stopped = true;
      current?.kill();
    },
  };
}
