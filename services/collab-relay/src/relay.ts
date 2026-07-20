/**
 * Collab relay protocol — vendored verbatim from the upstream oh-my-pi
 * `packages/collab-web/scripts/local-relay.ts` and lifted into a reusable
 * factory so the composite server (src/server.ts) can mount the relay and
 * the static web client on one port.
 *
 * Provenance:
 *   repo:   can1357/oh-my-pi
 *   tag:    v17.0.5
 *   commit: 9fd6e97113f5ed3a847e66d346970efdf8afcad9
 *   path:   packages/collab-web/scripts/local-relay.ts
 *   sha256: 3c0104fa36b338168b1b4d322f80a58b63b1e4ac04bac3859a7d1666a48d8b37
 *
 * The `open`, `message`, and `close` bodies below are byte-identical to the
 * upstream relay; only the enclosing factory wrapper and the `rooms` map
 * ownership differ (lifted out so the composite server shares one process
 * heap with the static client). The relay contract is unchanged:
 *
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - The host creates the room; a second host is rejected with close 4009 and
 *   a guest joining a missing room with close 4004.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N
 *   targets that guest only — forwarded unchanged either way.
 * - Guest binary frames: the first 4 envelope bytes are rewritten to the
 *   sender's peerId, then forwarded to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001
 *   and the room is garbage-collected.
 *
 * The relay never sees plaintext: payloads stay sealed end to end.
 */
import { rewriteEnvelopePeer, unpackEnvelope } from "../upstream/src/lib/link";

export interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned when open for guests; the host stays 0. */
	peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

export interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

/** Per-process room registry; rooms live in the relay heap and are lost on restart. */
export type Rooms = Map<string, Room>;

/**
 * WebSocket handlers for the relay protocol. The composite server passes this
 * object to `Bun.serve({ websocket })`; `fetch` upgrades `/r/<roomId>?role=…`
 * with the same `SocketData` the handlers expect.
 */
export type RelayMount = Bun.WebSocketHandler<SocketData> & { rooms: Rooms };

export function createRelayWebSocket(): RelayMount {
	const rooms: Rooms = new Map();
	return {
		rooms,
		open(ws: RelaySocket): void {
			const { roomId, role } = ws.data;
			if (role === "host") {
				if (rooms.has(roomId)) {
					ws.close(4009, "a host is already connected for this room");
					return;
				}
				rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
				return;
			}
			const room = rooms.get(roomId);
			if (!room) {
				ws.close(4004, "no such room");
				return;
			}
			const peerId = room.nextPeerId++;
			ws.data.peerId = peerId;
			room.guests.set(peerId, ws);
			room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
		},
		message(ws: RelaySocket, message: string | Buffer): void {
			if (typeof message === "string") return; // clients never send TEXT
			const room = rooms.get(ws.data.roomId);
			if (!room) return;
			if (ws.data.role === "host") {
				const envelope = unpackEnvelope(message);
				if (!envelope) return;
				if (envelope.peerId === 0) {
					for (const guest of room.guests.values()) guest.send(message);
				} else {
					room.guests.get(envelope.peerId)?.send(message);
				}
				return;
			}
			if (message.byteLength < 4) return;
			rewriteEnvelopePeer(message, ws.data.peerId);
			room.host.send(message);
		},
		close(ws: RelaySocket): void {
			const { roomId, role, peerId } = ws.data;
			const room = rooms.get(roomId);
			if (!room) return;
			if (role === "host") {
				// Rejected second host: the live room is not ours to tear down.
				if (room.host !== ws) return;
				rooms.delete(roomId);
				const closure = JSON.stringify({ t: "room-closed" });
				for (const guest of room.guests.values()) {
					guest.send(closure);
					guest.close(4001, "room closed");
				}
				room.guests.clear();
				return;
			}
			if (room.guests.delete(peerId)) {
				room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
			}
		},
	};
}

/** Tear down every room on graceful shutdown, mirroring upstream `stop()`. */
export function closeAllRooms(rooms: Rooms): void {
	for (const room of rooms.values()) {
		const closure = JSON.stringify({ t: "room-closed" });
		for (const guest of room.guests.values()) {
			guest.send(closure);
			guest.close(4001, "room closed");
		}
		room.host.close(1001, "relay shutting down");
	}
	rooms.clear();
}
