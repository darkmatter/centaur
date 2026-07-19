export interface S3SourceConfig {
  bucket: string;
  prefix: string;
  endpoint?: string;
  region?: string;
}

export interface Config {
  /** Wrapper listen port. */
  port: number;
  /** Persistent root; everything the app writes lives under here. */
  dataDir: string;
  /** Port the internal `omp stats` dashboard child binds. */
  statsPort: number;
  /** Local corpus source: a directory of `<encoded key>/corpus.tar.gz`. */
  transcriptsDir?: string;
  /** Object-storage corpus source; mutually preferred over transcriptsDir when both are set. */
  s3?: S3SourceConfig;
  syncIntervalSeconds: number;
  /** HOME for omp children; sessions live under `$HOME/.omp/agent/sessions`. */
  homeDir: string;
  /** Where corpora are extracted, one subdirectory per encoded thread key. */
  sessionsRoot: string;
  /** Scratch space for downloads and exports (never the process TMPDIR). */
  tmpDir: string;
  /** Per-corpus sync metadata (fingerprints), survives restarts. */
  corporaDir: string;
  /** Rendered export HTML cache. */
  exportCacheDir: string;
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid numeric env value: ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.DATA_DIR || "/data";
  const homeDir = `${dataDir}/home`;
  const bucket = env.TRANSCRIPTS_S3_BUCKET || undefined;
  return {
    port: intEnv(env.PORT, 8080),
    dataDir,
    statsPort: intEnv(env.STATS_PORT, 3847),
    transcriptsDir: env.TRANSCRIPTS_DIR || undefined,
    s3: bucket
      ? {
          bucket,
          prefix: env.TRANSCRIPTS_S3_PREFIX || "transcripts",
          endpoint: env.TRANSCRIPTS_S3_ENDPOINT || undefined,
          region: env.TRANSCRIPTS_S3_REGION || undefined,
        }
      : undefined,
    syncIntervalSeconds: intEnv(env.SYNC_INTERVAL_SECONDS, 300),
    homeDir,
    sessionsRoot: `${homeDir}/.omp/agent/sessions`,
    tmpDir: `${dataDir}/tmp`,
    corporaDir: `${dataDir}/corpora`,
    exportCacheDir: `${dataDir}/export-cache`,
  };
}
