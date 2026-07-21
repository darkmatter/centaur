import { describe, expect, test } from "bun:test";
import { existsSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { createSource, syncOnce } from "../src/sync.ts";
import { sessionJsonl, testConfig, writeCorpusTar } from "./fixtures.ts";

const SESSION_ID = "019f0000-0000-7000-8000-000000000001";
const JSONL_NAME = `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;

describe("syncOnce (TRANSCRIPTS_DIR mode)", () => {
  test("extracts corpora into per-key session subdirectories", async () => {
    const cfg = testConfig();
    await writeCorpusTar(cfg.transcriptsDir!, "T%3A1234", {
      files: {
        [JSONL_NAME]: sessionJsonl(SESSION_ID),
        "thread-map.json": JSON.stringify({
          version: 1,
          threads: { "bridge-uuid": SESSION_ID },
        }),
      },
    });

    const source = createSource(cfg)!;
    const result = await syncOnce(cfg, source, { notify: false });
    expect(result.changed).toEqual(["T%3A1234"]);
    expect(result.total).toBe(1);

    const corpusDir = join(cfg.sessionsRoot, "T%3A1234");
    expect(existsSync(join(corpusDir, JSONL_NAME))).toBe(true);
    expect(existsSync(join(corpusDir, "thread-map.json"))).toBe(true);
  });

  test("is idempotent until the corpus fingerprint changes", async () => {
    const cfg = testConfig();
    const tarPath = await writeCorpusTar(cfg.transcriptsDir!, "k1", {
      files: { [JSONL_NAME]: sessionJsonl(SESSION_ID) },
    });
    const source = createSource(cfg)!;

    expect((await syncOnce(cfg, source, { notify: false })).changed).toEqual(["k1"]);
    expect((await syncOnce(cfg, source, { notify: false })).changed).toEqual([]);

    // Same content, new mtime -> new fingerprint -> re-extract.
    const bumped = statSync(tarPath).mtimeMs / 1000 + 10;
    utimesSync(tarPath, bumped, bumped);
    expect((await syncOnce(cfg, source, { notify: false })).changed).toEqual(["k1"]);
  });

  test("re-extraction replaces the corpus directory wholesale", async () => {
    const cfg = testConfig();
    const tarPath = await writeCorpusTar(cfg.transcriptsDir!, "k1", {
      files: { "old.jsonl": sessionJsonl(SESSION_ID) },
    });
    const source = createSource(cfg)!;
    await syncOnce(cfg, source, { notify: false });
    expect(existsSync(join(cfg.sessionsRoot, "k1", "old.jsonl"))).toBe(true);

    await writeCorpusTar(cfg.transcriptsDir!, "k1", {
      files: { "new.jsonl": sessionJsonl(SESSION_ID) },
    });
    const bumped = statSync(tarPath).mtimeMs / 1000 + 10;
    utimesSync(tarPath, bumped, bumped);
    await syncOnce(cfg, source, { notify: false });
    expect(existsSync(join(cfg.sessionsRoot, "k1", "new.jsonl"))).toBe(true);
    expect(existsSync(join(cfg.sessionsRoot, "k1", "old.jsonl"))).toBe(false);
  });

  test("notifies the stats backend once per changed pass and tolerates refusal", async () => {
    let syncPosts = 0;
    const stub = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/api/sync" && req.method === "POST") syncPosts++;
        return Response.json({ ok: true });
      },
    });
    try {
      const cfg = testConfig({ STATS_PORT: String(stub.port) });
      await writeCorpusTar(cfg.transcriptsDir!, "k1", {
        files: { [JSONL_NAME]: sessionJsonl(SESSION_ID) },
      });
      const source = createSource(cfg)!;
      await syncOnce(cfg, source);
      expect(syncPosts).toBe(1);
      // No change -> no notify.
      await syncOnce(cfg, source);
      expect(syncPosts).toBe(1);
    } finally {
      stub.stop(true);
    }

    // Backend down: sync must still succeed.
    const cfg2 = testConfig({ STATS_PORT: "1" });
    await writeCorpusTar(cfg2.transcriptsDir!, "k2", {
      files: { [JSONL_NAME]: sessionJsonl(SESSION_ID) },
    });
    const result = await syncOnce(cfg2, createSource(cfg2)!);
    expect(result.changed).toEqual(["k2"]);
  });
});
