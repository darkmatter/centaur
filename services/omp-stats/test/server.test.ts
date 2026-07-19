import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { sessionJsonl, testConfig } from "./fixtures.ts";
import { writeCorpusTar } from "./fixtures.ts";

describe("createHandler /healthz", () => {
  test("returns ok:true", async () => {
    const cfg = testConfig();
    const handler = createHandler(cfg, { upstream: "http://127.0.0.1:1" });
    const res = await handler(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("createHandler proxy", () => {
  test("reverse-proxies arbitrary paths to the upstream, preserving method/headers minus hop-by-hop", async () => {
    let seenMethod: string | undefined;
    let seenPath: string | undefined;
    let seenXApp: string | null | undefined;
    let seenHost: string | null | undefined;
    let seenXApiKey: string | null | undefined;
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        seenMethod = req.method;
        seenPath = u.pathname;
        seenXApp = req.headers.get("x-centaur-app");
        seenHost = req.headers.get("host");
        seenXApiKey = req.headers.get("x-api-key");
        return new Response(`stub:${u.pathname}`, {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    try {
      const cfg = testConfig({ STATS_PORT: String(stub.port) });
      const handler = createHandler(cfg, { upstream: `http://127.0.0.1:${stub.port}` });
      const req = new Request(`http://localhost/api/stats/overview?range=all`, {
        headers: {
          "x-centaur-app": "omp-stats",
          // `host` is hop-by-hop: the proxy drops the inbound value and
          // lets fetch recompute it for the upstream.
          host: "localhost:8080",
          "x-api-key": "secret", // api-rs strips this at the outer boundary; the wrapper passes it through untouched
        },
      });
      const res = await handler(req);
      expect(seenMethod).toBe("GET");
      expect(seenPath).toBe("/api/stats/overview");
      expect(seenXApp).toBe("omp-stats");
      expect(seenHost).toBe(`127.0.0.1:${stub.port}`);
      // Non-hop-by-hop headers pass through untouched; the identity-injected
      // x-centaur-app and the outer-boundary x-api-key both reach the upstream.
      expect(seenXApiKey).toBe("secret");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("stub:/api/stats/overview");
    } finally {
      stub.stop(true);
    }
  });

  test("injects prefix-compat script into proxied HTML", async () => {
    const stub = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<!DOCTYPE html>\n<html><head><title>x</title></head><body>hi</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    try {
      const cfg = testConfig({ STATS_PORT: String(stub.port) });
      const handler = createHandler(cfg, { upstream: `http://127.0.0.1:${stub.port}` });
      const res = await handler(new Request("http://localhost/"));
      const body = await res.text();
      expect(body).toContain("location.pathname");
      expect(body).toContain("<title>x</title>");
      expect(body).toContain("</html>");
    } finally {
      stub.stop(true);
    }
  });

  test("forwards non-GET bodies and returns 502 when upstream is down", async () => {
    const cfg = testConfig({ STATS_PORT: "1" });
    const handler = createHandler(cfg, { upstream: "http://127.0.0.1:1" });
    const res = await handler(new Request("http://localhost/api/sync", { method: "POST", body: "{}" }));
    expect(res.status).toBe(502);
  });
});

describe("createHandler /export/:key", () => {
  test("returns 404 for unknown keys", async () => {
    const cfg = testConfig();
    const handler = createHandler(cfg, { upstream: "http://127.0.0.1:1" });
    const res = await handler(new Request("http://localhost/export/T%3A0000"));
    expect(res.status).toBe(404);
  });

  test("serves rendered transcript HTML for a known corpus", async () => {
    const cfg = testConfig();
    const SESSION_ID = "019f0000-0000-7000-8000-00000000000c";
    const jsonlName = `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;
    await writeCorpusTar(cfg.transcriptsDir!, "k1", { files: { [jsonlName]: sessionJsonl(SESSION_ID) } });

    const { syncOnce } = await import("../src/sync.ts");
    await syncOnce(cfg, (await import("../src/sync.ts")).createSource(cfg)!, { notify: false });

    const handler = createHandler(cfg, { upstream: "http://127.0.0.1:1" });
    const res = await handler(new Request("http://localhost/export/k1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await res.text()).toLowerCase()).toContain("<!doctype html>");
  }, 30_000);
});

describe("loadConfig env parsing", () => {
  test("applies defaults", () => {
    const cfg = loadConfig({ DATA_DIR: "/tmp/whatever" });
    expect(cfg.port).toBe(8080);
    expect(cfg.statsPort).toBe(3847);
    expect(cfg.syncIntervalSeconds).toBe(300);
    expect(cfg.sessionsRoot).toBe("/tmp/whatever/home/.omp/agent/sessions");
  });
  test("parses S3 env when bucket is set", () => {
    const cfg = loadConfig({
      DATA_DIR: "/tmp/whatever",
      TRANSCRIPTS_S3_BUCKET: "bkt",
      TRANSCRIPTS_S3_PREFIX: "x",
      TRANSCRIPTS_S3_ENDPOINT: "http://minio",
      TRANSCRIPTS_S3_REGION: "us-east-2",
    });
    expect(cfg.s3).toBeDefined();
    expect(cfg.s3!.bucket).toBe("bkt");
    expect(cfg.s3!.prefix).toBe("x");
    expect(cfg.s3!.endpoint).toBe("http://minio");
    expect(cfg.s3!.region).toBe("us-east-2");
  });
});
