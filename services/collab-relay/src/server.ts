import { closeAllRooms, createRelayWebSocket, type RelayMount, type Rooms, type SocketData } from "./relay.ts";

/**
 * Composite collab relay + web client server. Serves the native OMP collab
 * WebSocket relay contract (/r/<roomId>?role=host|guest) and the prebuilt
 * static browser client (dist/) over a single port — the deployment shape the
 * gitops Service + Tailscale ingress expect (one port, both surfaces).
 *
 * The relay protocol is the vendored upstream implementation (src/relay.ts);
 * this file owns only HTTP routing, static file serving, and lifecycle.
 */
export interface ServerConfig {
	/** Listen port; default 7466 (the documented collab relay port). */
	port: number;
	/** Static web client root; default ./dist (populated by the image build). */
	webRoot: string;
}

export interface CollabServer {
	port: number;
	rooms: Rooms;
	stop(): void;
}

const DEFAULT_PORT = 7466;
const DEFAULT_WEB_ROOT = "dist";
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

function intEnv(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || n > 65_535) {
		throw new Error(`invalid port: ${JSON.stringify(raw)}`);
	}
	return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
	return {
		port: intEnv(env.PORT, DEFAULT_PORT),
		webRoot: env.WEB_ROOT || DEFAULT_WEB_ROOT,
	};
}

/** Resolve a static asset path under webRoot, rejecting traversal escapes. */
function resolveAsset(webRoot: string, pathname: string): string {
	const decoded = decodeURIComponent(pathname);
	if (decoded.includes("\0") || decoded.includes("//")) return `${webRoot}/index.html`;
	// Bun.file is sandboxed to the process cwd; collapse leading slashes and
	// reject `..` so a crafted path can never escape the web root.
	const clean = decoded
		.replace(/^\/+/, "")
		.split("/")
		.filter((seg) => seg !== ".." && seg !== ".")
		.join("/");
	return clean === "" ? `${webRoot}/index.html` : `${webRoot}/${clean}`;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

function contentType(path: string): string {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return "application/octet-stream";
	return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

export interface HandlerOptions {
	relay?: RelayMount;
}

/**
 * Build the composite fetch handler. `webRoot` is injectable for tests so the
 * handler can be exercised without the built SPA on disk.
 */
export function createHandler(cfg: ServerConfig, opts: HandlerOptions = {}): (req: Request, srv: Bun.Server<SocketData>) => Promise<Response | undefined> {
	const relay = opts.relay ?? createRelayWebSocket();
	return async (req, srv): Promise<Response | undefined> => {
		const url = new URL(req.url);

		if (url.pathname === "/healthz") {
			return Response.json({ ok: true }, { status: 200 });
		}

		const match = ROOM_PATH_RE.exec(url.pathname);
		if (match) {
			const role = url.searchParams.get("role");
			if (role !== "host" && role !== "guest") {
				return new Response("not found", { status: 404 });
			}
			const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		}

		// Static web client. SPA fallback: unknown non-asset paths serve
		// index.html so the client-side router / deep-link hash takes over.
		const assetPath = resolveAsset(cfg.webRoot, url.pathname);
		const file = Bun.file(assetPath);
		if (await file.exists()) {
			return new Response(file, { headers: { "content-type": contentType(assetPath) } });
		}
		if (!url.pathname.includes(".")) {
			const index = Bun.file(`${cfg.webRoot}/index.html`);
			if (await index.exists()) {
				return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
			}
		}
		return new Response("not found", { status: 404 });
	};
}

export function startServer(cfg: ServerConfig = loadConfig()): CollabServer {
	const relay = createRelayWebSocket();
	const server = Bun.serve({
		port: cfg.port,
		idleTimeout: 120,
		fetch: createHandler(cfg, { relay }),
		websocket: relay,
	});
	console.log(`[collab-relay] listening on :${server.port} (relay + web client)`);
	return {
		port: server.port ?? cfg.port,
		rooms: relay.rooms,
		stop: (): void => {
			closeAllRooms(relay.rooms);
			server.stop(true);
		},
	};
}

if (import.meta.main) {
	const cfg = loadConfig();
	const srv = startServer(cfg);
	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		srv.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
