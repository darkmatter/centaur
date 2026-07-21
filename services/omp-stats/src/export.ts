import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { writeAtomic } from "./fsutil.ts";
import { readCorpusFingerprint } from "./sync.ts";

interface ThreadMap {
  version: number;
  threads: Record<string, string>;
}

/**
 * Pick the session JSONL to export for a corpus directory. Preference order:
 * newest (by mtime) JSONL that a thread-map entry resolves to, so a resumed
 * thread exports its real omp session; otherwise newest JSONL overall.
 */
export function selectSessionJsonl(corpusDir: string): string | undefined {
  if (!existsSync(corpusDir)) return undefined;
  const jsonls = readdirSync(corpusDir).filter((name) => name.endsWith(".jsonl"));
  if (jsonls.length === 0) return undefined;

  let mappedIds: string[] = [];
  try {
    const map = JSON.parse(readFileSync(join(corpusDir, "thread-map.json"), "utf8")) as ThreadMap;
    mappedIds = Object.values(map.threads ?? {});
  } catch {
    // Absent or malformed map: fall through to the mtime heuristic.
  }

  const mapped = jsonls.filter((name) =>
    mappedIds.some((id) => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`)),
  );
  const pool = mapped.length > 0 ? mapped : jsonls;
  let best: string | undefined;
  let bestMtime = -Infinity;
  for (const name of pool) {
    const mtime = statSync(join(corpusDir, name)).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = name;
    }
  }
  return best ? join(corpusDir, best) : undefined;
}

export type ExportResult =
  | { kind: "ok"; htmlPath: string }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * Render (or serve from cache) the transcript HTML for one encoded thread
 * key. The cache is keyed on the corpus fingerprint recorded at sync time,
 * falling back to the chosen JSONL's mtime for corpora that predate the
 * metadata (or arrived outside the sync loop).
 */
export async function renderExport(cfg: Config, encodedKey: string): Promise<ExportResult> {
  const corpusDir = join(cfg.sessionsRoot, encodedKey);
  const jsonlPath = selectSessionJsonl(corpusDir);
  if (!jsonlPath) return { kind: "not-found" };

  const fingerprint =
    (await readCorpusFingerprint(cfg, encodedKey)) ?? `mtime:${statSync(jsonlPath).mtimeMs}`;
  const cacheHtml = join(cfg.exportCacheDir, `${encodedKey}.html`);
  const cacheMeta = join(cfg.exportCacheDir, `${encodedKey}.meta`);
  try {
    if (existsSync(cacheHtml) && (await Bun.file(cacheMeta).text()) === fingerprint) {
      return { kind: "ok", htmlPath: cacheHtml };
    }
  } catch {}

  mkdirSync(cfg.tmpDir, { recursive: true });
  mkdirSync(cfg.exportCacheDir, { recursive: true });
  const outPath = join(cfg.tmpDir, `export-${crypto.randomUUID()}.html`);
  const proc = Bun.spawn(["omp", "--export", jsonlPath, outPath], {
    env: { ...process.env, HOME: cfg.homeDir },
    cwd: cfg.tmpDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(outPath)) {
    const err = await new Response(proc.stderr).text();
    try {
      unlinkSync(outPath);
    } catch {}
    return { kind: "error", message: `omp --export failed (${code}): ${err.trim()}` };
  }
  renameSync(outPath, cacheHtml);
  await writeAtomic(cacheMeta, fingerprint);
  return { kind: "ok", htmlPath: cacheHtml };
}
