import type { Config } from "./config.ts";
import { renderExport } from "./export.ts";
import { decodeThreadKey, encodeThreadKey } from "./encoding.ts";

// Hop-by-hop headers must not be forwarded in either direction (RFC 9110
// §7.6.1). `host` is recomputed by fetch; `accept-encoding` is dropped so the
// upstream response arrives uncompressed and HTML rewriting stays simple.
const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  trailers: true,
  "transfer-encoding": true,
  upgrade: true,
  host: true,
  "accept-encoding": true,
};

// The dashboard bundle requests absolute /api/... paths, which break when the
// app is served behind a path prefix (e.g. an API or console proxy). Injected
// at the top of proxied HTML: force a trailing slash so the page's relative
// asset URLs resolve under the prefix, then rebase root-absolute fetch()
// targets onto the directory the page was served from. The bundle uses
// fetch() exclusively (no XHR/WebSocket/EventSource), so patching fetch is
// sufficient.
const PREFIX_COMPAT_SCRIPT = `<script>
(function () {
  if (!location.pathname.endsWith("/")) {
    location.replace(location.pathname + "/" + location.search + location.hash);
    return;
  }
  var dir = location.pathname;
  if (dir === "/") return;
  var base = dir.slice(0, -1);
  var orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    if (typeof url === "string" && url.length > 1 && url[0] === "/" && url[1] !== "/") {
      var rebased = base + url;
      input = typeof input === "string" ? rebased : new Request(rebased, input);
    }
    return orig(input, init);
  };
})();
</script>`;

function filteredHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, name) => {
    if (!HOP_BY_HOP[name.toLowerCase()]) out.set(name, value);
  });
  return out;
}

async function proxyToStats(req: Request, url: URL, upstream: string): Promise<Response> {
  const target = `${upstream}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers: filteredHeaders(req.headers),
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("stats backend unavailable\n", { status: 502 });
  }

  const headers = filteredHeaders(res.headers);
  // fetch() has already decoded any content encoding, and HTML injection
  // changes the length; let the runtime recompute both.
  headers.delete("content-encoding");
  headers.delete("content-length");

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const injected = html.replace(/<head[^>]*>/i, (m) => `${m}\n${PREFIX_COMPAT_SCRIPT}`);
    return new Response(injected, { status: res.status, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}
/** Build the wrapper's fetch handler; `upstream` overrides target for tests. */
export function createHandler(
  cfg: Config,
  opts: { upstream?: string } = {},
): (req: Request) => Promise<Response> {
  const upstream = opts.upstream ?? `http://127.0.0.1:${cfg.statsPort}`;
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    const exportMatch = /^\/export\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && exportMatch) {
      // Axum decodes percent escapes in `/apps/:name/*path` before forwarding.
      // Canonicalize both decoded (`T:1234`) and encoded (`T%3A1234`) forms to
      // the object-storage directory spelling used by transcript sync.
      let threadKey: string;
      try {
        threadKey = encodeThreadKey(decodeThreadKey(exportMatch[1]!));
      } catch {
        return new Response("invalid thread key\n", { status: 400 });
      }
      const result = await renderExport(cfg, threadKey);
      switch (result.kind) {
        case "ok":
          return new Response(Bun.file(result.htmlPath), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        case "not-found":
          return new Response("unknown thread key\n", { status: 404 });
        case "error":
          console.error(result.message);
          return new Response("export failed\n", { status: 500 });
      }
    }
    return proxyToStats(req, url, upstream);
  };
}
