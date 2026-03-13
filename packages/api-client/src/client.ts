import type { CanonicalEvent } from "@centaur/harness-events";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { resilientFetch } from "./resilient-fetch";
import { ApiError } from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

export type InputContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export interface CentaurClientOptions {
  apiUrl: string;
  apiKey: string;
  logger?: { info: Function; warn: Function; error: Function };
}

export interface ExecuteOptions {
  threadKey: string;
  message: string | InputContentBlock[];
  harness?: string;
  platform?: string;
  userId?: string;
}

export interface PostContextOptions {
  threadKey: string;
  text: string;
  userId?: string;
  attachments?: Array<{ url: string; name: string; mimeType?: string }>;
}

export interface OrphanedEntry {
  thread_key: string;
  text: string;
  updated_at?: string | null;
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface CentaurClient {
  execute(opts: ExecuteOptions): AsyncGenerator<CanonicalEvent, void, undefined>;
  postContext(opts: PostContextOptions): Promise<void>;
  getStatus(threadKey: string): Promise<Record<string, unknown>>;
  listOrphaned(opts?: { maxAgeS?: number }): Promise<OrphanedEntry[]>;
  claimDelivery(threadKey: string): Promise<boolean>;
  markDelivered(threadKey: string): Promise<void>;
}

const BUSY_MAX_RETRIES = 4;
const BUSY_INITIAL_DELAY_MS = 300;
const BUSY_MAX_DELAY_MS = 2500;

export function createCentaurClient(options: CentaurClientOptions): CentaurClient {
  const { apiUrl, apiKey, logger } = options;

  const log = logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const fetchLog = { warn: log.warn.bind(log) } as Parameters<typeof resilientFetch>[3];

  function apiFetch(url: string, opts: Parameters<typeof resilientFetch>[1] = {}) {
    return resilientFetch(url, opts, apiKey, fetchLog);
  }

  // ── SSE parsing ─────────────────────────────────────────────────────────

  async function* readSSEStream(
    res: Response,
  ): AsyncGenerator<CanonicalEvent, void, undefined> {
    if (!res.body) return;

    const stream = (res.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    for await (const event of stream) {
      if (event.data === "[DONE]") return;
      try {
        yield JSON.parse(event.data) as CanonicalEvent;
      } catch {
        // skip unparseable
      }
    }
  }

  // ── Methods ─────────────────────────────────────────────────────────────

  async function* execute(
    opts: ExecuteOptions,
  ): AsyncGenerator<CanonicalEvent, void, undefined> {
    const { threadKey, message, harness, platform, userId } = opts;

    for (let attempt = 1; attempt <= BUSY_MAX_RETRIES; attempt++) {
      log.info("sse_connect", { thread_key: threadKey, harness });

      const body: Record<string, unknown> = {
        thread_key: threadKey,
        message,
        ...(harness ? { harness } : {}),
      };
      if (platform) body.platform = platform;
      if (userId) body.user_id = userId;

      const res = await apiFetch(`${apiUrl}/agent/execute`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "X-Trace-Id": threadKey },
        timeoutMs: 10 * 60_000,
        maxAttempts: 1,
        stream: true,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const isBusy = text.toLowerCase().includes("already in progress");
        if (isBusy && attempt < BUSY_MAX_RETRIES) {
          const delay = Math.min(BUSY_INITIAL_DELAY_MS * 2 ** (attempt - 1), BUSY_MAX_DELAY_MS);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON
        }
        const code = parsed?.code as string | undefined;
        throw new ApiError(
          code
            ? `${code}: ${(parsed?.detail as string) ?? text.slice(0, 300)}`
            : `/agent/execute failed (${res.status}): ${text.slice(0, 300)}`,
          res.status,
          res.status >= 500,
        );
      }

      log.info("sse_streaming", { thread_key: threadKey });
      yield* readSSEStream(res);
      return;
    }
  }

  async function postContext(opts: PostContextOptions): Promise<void> {
    const { threadKey, text, userId, attachments } = opts;
    const metadata: Record<string, unknown> = {};
    if (userId) metadata.user_id = userId;
    if (attachments?.length) metadata.attachments = attachments;

    const res = await apiFetch(`${apiUrl}/agent/messages`, {
      method: "POST",
      body: JSON.stringify({
        thread_key: threadKey,
        messages: [
          { role: "user", parts: [{ type: "text", text }], user_id: userId, metadata },
        ],
      }),
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `/agent/messages failed (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
  }

  async function getStatus(threadKey: string): Promise<Record<string, unknown>> {
    const res = await apiFetch(
      `${apiUrl}/agent/status?key=${encodeURIComponent(threadKey)}`,
      { timeoutMs: 5_000, maxAttempts: 1 },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `/agent/status failed (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async function listOrphaned(opts?: { maxAgeS?: number }): Promise<OrphanedEntry[]> {
    const qs = opts?.maxAgeS != null ? `?max_age_s=${opts.maxAgeS}` : "";
    const res = await apiFetch(`${apiUrl}/agent/orphaned${qs}`, {
      timeoutMs: 10_000,
      maxAttempts: 1,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `/agent/orphaned failed (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
    return (await res.json()) as OrphanedEntry[];
  }

  async function claimDelivery(threadKey: string): Promise<boolean> {
    const res = await apiFetch(`${apiUrl}/agent/claim-delivery`, {
      method: "POST",
      body: JSON.stringify({ thread_key: threadKey }),
      maxAttempts: 1,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { claimed: boolean };
    return data.claimed;
  }

  async function markDelivered(threadKey: string): Promise<void> {
    const res = await apiFetch(`${apiUrl}/agent/mark-delivered`, {
      method: "POST",
      body: JSON.stringify({ thread_key: threadKey }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new ApiError(
        `/agent/mark-delivered failed (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
  }

  return { execute, postContext, getStatus, listOrphaned, claimDelivery, markDelivered };
}
