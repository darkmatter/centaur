import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { loadConfig, createHandler, startServer, type ServerConfig } from "../src/server.ts";
import type { RelayMount } from "../src/relay.ts";
import { createRelayWebSocket } from "../src/relay.ts";
import { packEnvelope, unpackEnvelope } from "../upstream/src/lib/link";

const ROOM = "RelayRoom_12345";
const REQUEST_TIMEOUT_MS = 1_000;

let server: ReturnType<typeof Bun.serve> | null = null;
const sockets: WebSocket[] = [];

function baseConfig(webRoot: string): ServerConfig {
	return { port: 0, webRoot };
}

function httpUrl(srv: ReturnType<typeof Bun.serve>): string {
	return `http://localhost:${srv.port}`;
}

interface Inbox {
	text: string[];
	binary: Uint8Array[];
	open: boolean;
}

const inboxes = new Map<WebSocket, Inbox>();

function socket(srv: ReturnType<typeof Bun.serve>, path: string): WebSocket {
	const ws = new WebSocket(`${httpUrl(srv)}${path}`);
	const inbox: Inbox = { text: [], binary: [], open: false };
	inboxes.set(ws, inbox);
	ws.addEventListener("open", () => {
		inbox.open = true;
	});
	ws.addEventListener("message", (ev: MessageEvent) => {
		const data = ev.data;
		if (typeof data === "string") inbox.text.push(data);
		else if (data instanceof ArrayBuffer) inbox.binary.push(new Uint8Array(data));
		else if (data instanceof Uint8Array) inbox.binary.push(data);
	});
	sockets.push(ws);
	return ws;
}

function waitEvent<T extends Event>(ws: WebSocket, type: string, label: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting ${label}`)), timeoutMs);
		ws.addEventListener(type, (ev) => {
			clearTimeout(timer);
			resolve(ev as T);
		}, { once: true });
		ws.addEventListener("close", () => {
			clearTimeout(timer);
			reject(new Error(`socket closed while waiting ${label}`));
		}, { once: true });
	});
}

function waitOpen(ws: WebSocket): Promise<Event> {
	return waitEvent<Event>(ws, "open", "open");
}

async function waitText(ws: WebSocket, label: string): Promise<string> {
	const inbox = inboxes.get(ws)!;
	if (inbox.text.length > 0) return inbox.text.shift()!;
	const ev = await waitEvent<MessageEvent>(ws, "message", label);
	if (typeof ev.data !== "string") throw new Error(`${label}: expected text frame`);
	return ev.data as string;
}

async function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
	const inbox = inboxes.get(ws)!;
	if (inbox.binary.length > 0) return inbox.binary.shift()!;
	await waitEvent<MessageEvent>(ws, "message", label);
	if (inbox.binary.length === 0) throw new Error(`${label}: expected binary frame`);
	return inbox.binary.shift()!;
}

function closeSocket(ws: WebSocket): void {
	if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

function makeServer(webRoot: string, relay?: RelayMount): { srv: ReturnType<typeof Bun.serve>; relay: RelayMount } {
	const r = relay ?? createRelayWebSocket();
	const srv = Bun.serve({
		port: 0,
		fetch: createHandler(baseConfig(webRoot), { relay: r }),
		websocket: r,
	});
	server = srv;
	return { srv, relay: r };
}

afterEach(() => {
	for (const ws of sockets) closeSocket(ws);
	sockets.length = 0;
	inboxes.clear();
	if (server) {
		server.stop(true);
		server = null;
	}
});

describe("composite server /healthz", () => {
	it("returns ok:true", async () => {
		const { srv } = makeServer("dist");
		const res = await fetch(`${httpUrl(srv)}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("composite server relay contract", () => {
	it("rejects non-relay requests with 404 and guests before a host creates the room", async () => {
		const { srv } = makeServer("dist");

		const notFound = await fetch(`${httpUrl(srv)}/nope`);
		expect(notFound.status).toBe(404);

		const upgradeRequired = await fetch(`${httpUrl(srv)}/r/${ROOM}?role=host`);
		expect(upgradeRequired.status).toBe(426);

		const guest = socket(srv, `/r/${ROOM}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(4004);
		expect(close.reason).toBe("no such room");
	});

	it("routes opaque envelopes without decrypting them", async () => {
		const { srv } = makeServer("dist");
		const host = socket(srv, `/r/${ROOM}?role=host`);
		await waitOpen(host);

		const guest1 = socket(srv, `/r/${ROOM}?role=guest`);
		await waitOpen(guest1);
		expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const guest2 = socket(srv, `/r/${ROOM}?role=guest`);
		await waitOpen(guest2);
		expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

		guest1.send(packEnvelope(0, new Uint8Array([1, 2, 3])));
		const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
		expect(fromGuest?.peerId).toBe(1);
		expect(fromGuest?.payload).toEqual(new Uint8Array([1, 2, 3]));

		const broadcast1 = waitBinary(guest1, "broadcast to guest 1");
		const broadcast2 = waitBinary(guest2, "broadcast to guest 2");
		host.send(packEnvelope(0, new Uint8Array([9])));
		expect(unpackEnvelope(await broadcast1)?.payload).toEqual(new Uint8Array([9]));
		expect(unpackEnvelope(await broadcast2)?.payload).toEqual(new Uint8Array([9]));

		const targeted = waitBinary(guest2, "targeted guest 2 frame");
		host.send(packEnvelope(2, new Uint8Array([7])));
		expect(unpackEnvelope(await targeted)?.payload).toEqual(new Uint8Array([7]));
	});

	it("enforces one host and closes guests when the room host leaves", async () => {
		const { srv } = makeServer("dist");
		const host = socket(srv, `/r/${ROOM}?role=host`);
		await waitOpen(host);

		const duplicateHost = socket(srv, `/r/${ROOM}?role=host`);
		const duplicateClose = await waitEvent<CloseEvent>(duplicateHost, "close", "duplicate host close");
		expect(duplicateClose.code).toBe(4009);
		expect(duplicateClose.reason).toBe("a host is already connected for this room");

		const guest = socket(srv, `/r/${ROOM}?role=guest`);
		await waitOpen(guest);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const closure = waitText(guest, "room close control");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
		host.close(1000);
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(4001);
	});
});

describe("composite server static web client", () => {
	it("serves index.html at / and SPA-falls back for unknown non-asset paths", async () => {
		const webRoot = import.meta.dir;
		const root = join(webRoot, "..", "public");
		const { srv } = makeServer(root);

		const index = await fetch(`${httpUrl(srv)}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toContain("text/html");
		const body = await index.text();
		expect(body).toContain("<!doctype html>");

		// SPA fallback: an unknown path with no extension serves index.html
		const fallback = await fetch(`${httpUrl(srv)}/some/deep/path`);
		expect(fallback.status).toBe(200);
		expect((await fallback.text())).toContain("<!doctype html>");
	});

	it("serves a known static asset with the right content type and 404s unknown assets", async () => {
		const webRoot = import.meta.dir;
		const root = join(webRoot, "..", "public");
		const { srv } = makeServer(root);

		const css = await fetch(`${httpUrl(srv)}/style.css`);
		expect(css.status).toBe(200);
		expect(css.headers.get("content-type")).toContain("text/css");

		const missing = await fetch(`${httpUrl(srv)}/missing.js`);
		expect(missing.status).toBe(404);
	});

	it("rejects traversal attempts by serving index.html instead of escaping", async () => {
		const root = join(import.meta.dir, "..", "public");
		const { srv } = makeServer(root);

		const escapeAttempt = await fetch(`${httpUrl(srv)}/../../etc/passwd`);
		// resolveAsset collapses .. and the SPA fallback serves index.html
		expect(escapeAttempt.status).toBe(200);
		expect((await escapeAttempt.text())).toContain("<!doctype html>");
	});
});

describe("restart invalidates rooms", () => {
	it("a stopped server has no rooms; a fresh server starts empty", async () => {
		const root = join(import.meta.dir, "..", "public");
		const first = makeServer(root);
		const host = socket(first.srv, `/r/${ROOM}?role=host`);
		await waitOpen(host);
		expect(first.relay.rooms.size).toBe(1);

		// Tear down the first server the way SIGTERM does: closeAllRooms + stop.
		first.srv.stop(true);
		// Rooms are in-process heap; closeAllRooms (called by stop) clears them.
		expect(first.relay.rooms.size).toBe(0);
		// Suppress the afterEach double-stop of the torn-down server.
		server = null;

		const second = makeServer(root);
		expect(second.relay.rooms.size).toBe(0);
	});
});

describe("loadConfig env parsing", () => {
	it("applies defaults", () => {
		const cfg = loadConfig({});
		expect(cfg.port).toBe(7466);
		expect(cfg.webRoot).toBe("dist");
	});

	it("parses PORT and WEB_ROOT", () => {
		const cfg = loadConfig({ PORT: "9999", WEB_ROOT: "/srv/web" });
		expect(cfg.port).toBe(9999);
		expect(cfg.webRoot).toBe("/srv/web");
	});

	it("rejects an invalid port", () => {
		expect(() => loadConfig({ PORT: "0" })).toThrow();
		expect(() => loadConfig({ PORT: "nope" })).toThrow();
	});
});
