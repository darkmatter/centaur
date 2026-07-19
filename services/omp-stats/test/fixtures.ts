import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type Config } from "../src/config.ts";

/** Minimal but realistically-shaped omp session JSONL. */
export function sessionJsonl(sessionId: string): string {
  const lines = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace",
    },
    {
      type: "message",
      id: "aaaa0001",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "ping" }],
        attribution: "user",
        timestamp: 1767225601000,
      },
    },
    {
      type: "message",
      id: "aaaa0002",
      parentId: "aaaa0001",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1767225602000,
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export interface CorpusSpec {
  /** file name -> content; e.g. a session JSONL and thread-map.json */
  files: Record<string, string>;
}

/** Build `<transcriptsDir>/<encodedKey>/corpus.tar.gz` with flat contents. */
export async function writeCorpusTar(
  transcriptsDir: string,
  encodedKey: string,
  spec: CorpusSpec,
): Promise<string> {
  const staging = mkdtempSync("/tmp/omp-stats-fixture.");
  const names = Object.keys(spec.files);
  for (const [name, content] of Object.entries(spec.files)) {
    await Bun.write(join(staging, name), content);
  }
  const outDir = join(transcriptsDir, encodedKey);
  mkdirSync(outDir, { recursive: true });
  const tarPath = join(outDir, "corpus.tar.gz");
  const proc = Bun.spawn(["tar", "-czf", tarPath, "-C", staging, ...names], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`fixture tar failed: ${await new Response(proc.stderr).text()}`);
  }
  return tarPath;
}

/** Fresh Config rooted in throwaway /tmp dirs, TRANSCRIPTS_DIR mode. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  const dataDir = mkdtempSync("/tmp/omp-stats-data.");
  const transcriptsDir = mkdtempSync("/tmp/omp-stats-src.");
  return loadConfig({
    DATA_DIR: dataDir,
    TRANSCRIPTS_DIR: transcriptsDir,
    ...overrides,
  });
}

/** Backdate a file so mtime-based ordering is deterministic. */
export function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}
