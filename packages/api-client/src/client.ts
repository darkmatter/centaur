import type { CanonicalEvent } from "@centaur/harness-events";
import { EventSourceParserStream, type EventSourceMessage } from "eventsource-parser/stream";
import axios, { type AxiosInstance } from "axios";

export type InputContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export interface MessageOptions {
  threadKey: string;
  parts: InputContentBlock[];
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteOptions {
  threadKey: string;
  message: string;
  harness?: string;
  platform?: string;
  userId?: string;
  signal?: AbortSignal;
}

/**
 * Centaur API client. Three-step protocol:
 *
 *   1. client.message()  — POST /agent/messages  (persist user message + attachments)
 *   2. client.connect()  — POST /agent/connect   (spawn + attach stdout → persistent SSE wire)
 *   3. client.execute()  — POST /agent/execute   (flush + write stdin → 200 OK)
 */
export class CentaurClient {
  readonly http: AxiosInstance;
  private log?: { info: Function; warn: Function; error: Function };

  constructor(opts: {
    apiUrl: string;
    apiKey: string;
    logger?: { info: Function; warn: Function; error: Function };
  }) {
    this.log = opts.logger;
    this.http = axios.create({
      baseURL: opts.apiUrl,
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      timeout: 30_000,
    });
  }

  private get authHeader(): string {
    return (this.http.defaults.headers["Authorization"] ?? this.http.defaults.headers.common?.["Authorization"]) as string;
  }

  /** Buffer a user message into chat_messages. */
  async message(opts: MessageOptions): Promise<void> {
    await this.http.post("/agent/messages", {
      thread_key: opts.threadKey,
      role: "user",
      parts: opts.parts,
      user_id: opts.userId,
      metadata: opts.metadata,
    });
  }

  /** Spawn/get sandbox and return persistent SSE stdout wire. */
  async *connect(opts: {
    threadKey: string;
    harness?: string;
    platform?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<CanonicalEvent, void, undefined> {
    const { threadKey, harness, platform, signal } = opts;
    this.log?.info("sse_connect", { thread_key: threadKey, harness });

    const body: Record<string, unknown> = { thread_key: threadKey };
    if (harness) body.harness = harness;
    if (platform) body.platform = platform;

    const res = await fetch(`${this.http.defaults.baseURL}/agent/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
        "X-Trace-Id": threadKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`/agent/connect failed (${res.status}): ${text.slice(0, 300)}`);
    }

    this.log?.info("sse_streaming", { thread_key: threadKey });
    if (!res.body) return;
    const stream = (res.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
      .pipeThrough(new EventSourceParserStream());
    for await (const event of stream as unknown as AsyncIterable<EventSourceMessage>) {
      if (event.data === "[DONE]") return;
      try { yield JSON.parse(event.data) as CanonicalEvent; } catch {}
    }
  }

  /** Flush pending messages + write to stdin. Returns immediately (no SSE). */
  async execute(opts: ExecuteOptions): Promise<{ ok: boolean; injected: boolean; turn_id?: number }> {
    const { threadKey, message, harness, platform, userId } = opts;
    this.log?.info("execute_stdin", { thread_key: threadKey });

    const body: Record<string, unknown> = {
      thread_key: threadKey,
      message,
    };
    if (harness) body.harness = harness;
    if (platform) body.platform = platform;
    if (userId) body.user_id = userId;

    const { data } = await this.http.post("/agent/execute", body);
    return data;
  }

  /** Re-attach to a running container's stdout without sending a new turn. */
  async *reconnect(opts: {
    threadKey: string;
    harness?: string;
    skipDoneCount?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<CanonicalEvent, void, undefined> {
    const { threadKey, harness, skipDoneCount = 0, signal } = opts;
    this.log?.info("sse_reconnect", { thread_key: threadKey });

    const body: Record<string, unknown> = {
      thread_key: threadKey,
      skip_done_count: skipDoneCount,
    };
    if (harness) body.harness = harness;

    const res = await fetch(`${this.http.defaults.baseURL}/agent/reconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
        "X-Trace-Id": threadKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`/agent/reconnect failed (${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.body) return;
    const stream = (res.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
      .pipeThrough(new EventSourceParserStream());
    for await (const event of stream as unknown as AsyncIterable<EventSourceMessage>) {
      if (event.data === "[DONE]") return;
      try { yield JSON.parse(event.data) as CanonicalEvent; } catch {}
    }
  }

  /** Check session status (used for recovery on expired streams). */
  async getStatus(threadKey: string) {
    const { data } = await this.http.get("/agent/status", { params: { key: threadKey } });
    return data as Record<string, unknown>;
  }
}
