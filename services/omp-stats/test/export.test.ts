import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderExport, selectSessionJsonl } from "../src/export.ts";
import { sessionJsonl, setMtime, testConfig } from "./fixtures.ts";

const OLD_ID = "019f0000-0000-7000-8000-00000000000a";
const NEW_ID = "019f0000-0000-7000-8000-00000000000b";
const OLD_NAME = `2026-01-01T00-00-00-000Z_${OLD_ID}.jsonl`;
const NEW_NAME = `2026-01-02T00-00-00-000Z_${NEW_ID}.jsonl`;

function makeCorpus(cfg: ReturnType<typeof testConfig>, key: string): string {
  const dir = join(cfg.sessionsRoot, key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("selectSessionJsonl", () => {
  test("prefers the thread-map mapping even when a newer unmapped JSONL exists", () => {
    const cfg = testConfig();
    const dir = makeCorpus(cfg, "k1");
    writeFileSync(join(dir, OLD_NAME), sessionJsonl(OLD_ID));
    writeFileSync(join(dir, NEW_NAME), sessionJsonl(NEW_ID));
    setMtime(join(dir, OLD_NAME), 1_700_000_000);
    setMtime(join(dir, NEW_NAME), 1_800_000_000);
    writeFileSync(
      join(dir, "thread-map.json"),
      JSON.stringify({ version: 1, threads: { "bridge-1": OLD_ID } }),
    );
    expect(selectSessionJsonl(dir)).toBe(join(dir, OLD_NAME));
  });

  test("among multiple mapped sessions picks the newest by mtime", () => {
    const cfg = testConfig();
    const dir = makeCorpus(cfg, "k1");
    writeFileSync(join(dir, OLD_NAME), sessionJsonl(OLD_ID));
    writeFileSync(join(dir, NEW_NAME), sessionJsonl(NEW_ID));
    setMtime(join(dir, OLD_NAME), 1_700_000_000);
    setMtime(join(dir, NEW_NAME), 1_800_000_000);
    writeFileSync(
      join(dir, "thread-map.json"),
      JSON.stringify({ version: 1, threads: { "bridge-1": OLD_ID, "bridge-2": NEW_ID } }),
    );
    expect(selectSessionJsonl(dir)).toBe(join(dir, NEW_NAME));
  });

  test("falls back to newest JSONL when the map is absent or matches nothing", () => {
    const cfg = testConfig();
    const dir = makeCorpus(cfg, "k1");
    writeFileSync(join(dir, OLD_NAME), sessionJsonl(OLD_ID));
    writeFileSync(join(dir, NEW_NAME), sessionJsonl(NEW_ID));
    setMtime(join(dir, OLD_NAME), 1_800_000_000);
    setMtime(join(dir, NEW_NAME), 1_700_000_000);
    expect(selectSessionJsonl(dir)).toBe(join(dir, OLD_NAME));

    writeFileSync(
      join(dir, "thread-map.json"),
      JSON.stringify({ version: 1, threads: { "bridge-x": "not-a-real-session" } }),
    );
    expect(selectSessionJsonl(dir)).toBe(join(dir, OLD_NAME));
  });

  test("returns undefined for a missing or empty corpus", () => {
    const cfg = testConfig();
    expect(selectSessionJsonl(join(cfg.sessionsRoot, "nope"))).toBeUndefined();
    const dir = makeCorpus(cfg, "empty");
    expect(selectSessionJsonl(dir)).toBeUndefined();
  });
});

describe("renderExport", () => {
  test("renders HTML via omp --export and caches until the corpus changes", async () => {
    const cfg = testConfig();
    const dir = makeCorpus(cfg, "k1");
    writeFileSync(join(dir, OLD_NAME), sessionJsonl(OLD_ID));

    const first = await renderExport(cfg, "k1");
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") throw new Error("unreachable");
    const html = await Bun.file(first.htmlPath).text();
    expect(html.toLowerCase()).toContain("<!doctype html>");

    // Poison the cached file; an unchanged fingerprint must serve it as-is.
    writeFileSync(first.htmlPath, "CACHED-SENTINEL");
    const second = await renderExport(cfg, "k1");
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") throw new Error("unreachable");
    expect(await Bun.file(second.htmlPath).text()).toBe("CACHED-SENTINEL");
  }, 30_000);

  test("reports not-found for unknown keys", async () => {
    const cfg = testConfig();
    expect((await renderExport(cfg, "missing")).kind).toBe("not-found");
  });
});
