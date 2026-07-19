import { S3Client } from "bun";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { removeInside, writeAtomic } from "./fsutil.ts";

const CORPUS_FILENAME = "corpus.tar.gz";

export interface CorpusRef {
  encodedKey: string;
  /** Change detector: S3 etag, or `mtimeMs:size` for local files. */
  fingerprint: string;
  load(): Promise<Uint8Array>;
}

export interface SyncSource {
  describe(): string;
  list(): Promise<CorpusRef[]>;
}

interface CorpusMeta {
  fingerprint: string;
  syncedAt: string;
}

export function createSource(cfg: Config): SyncSource | undefined {
  if (cfg.s3) {
    const s3 = cfg.s3;
    const client = new S3Client({
      bucket: s3.bucket,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      ...(s3.region ? { region: s3.region } : {}),
    });
    const keyPrefix = `${s3.prefix}/`;
    return {
      describe: () => `s3://${s3.bucket}/${s3.prefix}`,
      async list() {
        const refs: CorpusRef[] = [];
        let startAfter: string | undefined;
        for (;;) {
          const page = await client.list({
            prefix: keyPrefix,
            maxKeys: 1000,
            ...(startAfter ? { startAfter } : {}),
          });
          const contents = page.contents ?? [];
          for (const obj of contents) {
            const rest = obj.key.slice(keyPrefix.length);
            const segments = rest.split("/");
            if (segments.length !== 2 || segments[1] !== CORPUS_FILENAME) continue;
            const encodedKey = segments[0]!;
            if (!encodedKey) continue;
            refs.push({
              encodedKey,
              fingerprint: obj.eTag ?? `${obj.lastModified ?? ""}:${obj.size}`,
              load: async () => new Uint8Array(await client.file(obj.key).arrayBuffer()),
            });
          }
          if (!page.isTruncated || contents.length === 0) break;
          startAfter = contents[contents.length - 1]!.key;
        }
        return refs;
      },
    };
  }
  if (cfg.transcriptsDir) {
    const dir = cfg.transcriptsDir;
    return {
      describe: () => dir,
      async list() {
        if (!existsSync(dir)) return [];
        const refs: CorpusRef[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const tarPath = join(dir, entry.name, CORPUS_FILENAME);
          if (!existsSync(tarPath)) continue;
          const st = statSync(tarPath);
          refs.push({
            encodedKey: entry.name,
            fingerprint: `${st.mtimeMs}:${st.size}`,
            load: async () => new Uint8Array(await Bun.file(tarPath).arrayBuffer()),
          });
        }
        return refs;
      },
    };
  }
  return undefined;
}


export async function readCorpusFingerprint(
  cfg: Config,
  encodedKey: string,
): Promise<string | undefined> {
  try {
    const metaFile = Bun.file(join(cfg.corporaDir, `${encodedKey}.json`));
    const meta = (await metaFile.json()) as CorpusMeta;
    return meta.fingerprint;
  } catch {
    return undefined;
  }
}

async function extractCorpus(cfg: Config, encodedKey: string, bytes: Uint8Array): Promise<void> {
  mkdirSync(cfg.tmpDir, { recursive: true });
  mkdirSync(cfg.sessionsRoot, { recursive: true });
  const token = crypto.randomUUID();
  const tarPath = join(cfg.tmpDir, `corpus-${token}.tar.gz`);
  const staging = join(cfg.sessionsRoot, `.staging-${token}`);
  await Bun.write(tarPath, bytes);
  mkdirSync(staging, { recursive: true });
  try {
    const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", staging], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar extraction failed (${code}): ${err.trim()}`);
    }
    const dest = join(cfg.sessionsRoot, encodedKey);
    // Swap the extracted tree in whole so `omp stats` never scans a partial corpus.
    removeInside(cfg.dataDir, dest);
    renameSync(staging, dest);
  } finally {
    try {
      unlinkSync(tarPath);
    } catch {}
    if (existsSync(staging)) removeInside(cfg.dataDir, staging);
  }
}

async function notifyStats(cfg: Config, log: (msg: string) => void): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.statsPort}/api/sync`, { method: "POST" });
    if (!res.ok) log(`stats resync returned ${res.status}`);
  } catch (err) {
    // The dashboard child may be starting or restarting; it re-syncs on boot anyway.
    log(`stats resync skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface SyncResult {
  changed: string[];
  total: number;
}

/**
 * One sync pass: pull every changed corpus from the source, extract it under
 * the sessions root, then poke the dashboard to re-scan when anything moved.
 */
export async function syncOnce(
  cfg: Config,
  source: SyncSource,
  opts: { notify?: boolean; log?: (msg: string) => void } = {},
): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const refs = await source.list();
  const changed: string[] = [];
  for (const ref of refs) {
    if (ref.encodedKey.startsWith(".") || ref.encodedKey.includes("/")) {
      log(`skipping suspicious corpus key ${JSON.stringify(ref.encodedKey)}`);
      continue;
    }
    const known = await readCorpusFingerprint(cfg, ref.encodedKey);
    if (known === ref.fingerprint) continue;
    try {
      const bytes = await ref.load();
      await extractCorpus(cfg, ref.encodedKey, bytes);
      const meta: CorpusMeta = { fingerprint: ref.fingerprint, syncedAt: new Date().toISOString() };
      await writeAtomic(join(cfg.corporaDir, `${ref.encodedKey}.json`), JSON.stringify(meta));
      changed.push(ref.encodedKey);
    } catch (err) {
      log(
        `corpus ${ref.encodedKey} sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (changed.length > 0 && opts.notify !== false) await notifyStats(cfg, log);
  return { changed, total: refs.length };
}
