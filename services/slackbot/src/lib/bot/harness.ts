import { log } from "@/lib/logger";
import { resilientFetch, isNetworkError, ApiError, API_URL } from "./api-client";
import { getPool } from "@/lib/db";
import { normalizeHarnessEvent, normalizeThreadKey, type CanonicalEvent } from "@centaur/harness-events";
import { sleep } from "@/lib/utils";

export type Harness = string;  // Dynamic — personas discovered at runtime
export type BudgetMode = "simple" | "auto" | "complex";

type RunOptions = {
  harness: Harness;
  budgetMode: BudgetMode | null;
  cleanedText: string;
  harnessExplicit: boolean;
};

export function extractRunOptions(text: string): RunOptions {
  let cleaned = text;
  let harness: Harness = "amp";
  let budgetMode: BudgetMode | null = null;
  let harnessExplicit = false;

  // harness=<value> key-value (accepts any value — API validates)
  const kvMatch = cleaned.match(/\bharness\s*=\s*([A-Za-z0-9_-]+)\b/i);
  if (kvMatch) {
    harness = kvMatch[1].toLowerCase();
    harnessExplicit = true;
    cleaned = (
      cleaned.slice(0, kvMatch.index) + cleaned.slice(kvMatch.index! + kvMatch[0].length)
    ).trim();
  }

  // Engine flags: --amp, --claude, --codex, --pi
  const engineFlags: Array<{ regex: RegExp; value: string }> = [
    { regex: /(^|\s)--amp(?=\s|$)/gi, value: "amp" },
    { regex: /(^|\s)--claude(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--claude-code(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--codex(?=\s|$)/gi, value: "codex" },
    { regex: /(^|\s)--pi(?=\s|$)/gi, value: "pi-mono" },
    { regex: /(^|\s)--pi-mono(?=\s|$)/gi, value: "pi-mono" },
  ];
  for (const { regex, value } of engineFlags) {
    const matched = regex.test(cleaned);
    regex.lastIndex = 0;
    if (matched) {
      harness = value;
      harnessExplicit = true;
      cleaned = cleaned.replace(regex, " ");
      regex.lastIndex = 0;
    }
  }

  // Strip --model/--engine/--opus/--sonnet/--haiku flags (no longer used, but
  // don't let them leak into the prompt if someone types them out of habit).
  cleaned = cleaned.replace(/(^|\s)--(engine|model)\s+[A-Za-z0-9._-]+(?=\s|$)/gi, " ");
  cleaned = cleaned.replace(/(^|\s)--(opus|sonnet|haiku)(?=\s|$)/gi, " ");
  cleaned = cleaned.replace(/\bmodel\s*=\s*[A-Za-z0-9._-]+\b/gi, "");

  // Budget mode
  const modeEqMatch = cleaned.match(/\bmode\s*=\s*(simple|auto|complex)\b/i);
  if (modeEqMatch) {
    budgetMode = modeEqMatch[1].toLowerCase() as BudgetMode;
    cleaned = (
      cleaned.slice(0, modeEqMatch.index) + cleaned.slice(modeEqMatch.index! + modeEqMatch[0].length)
    ).trim();
  }

  const budgetFlags: Array<{ regex: RegExp; value: BudgetMode }> = [
    { regex: /(^|\s)--simple(?=\s|$)/gi, value: "simple" },
    { regex: /(^|\s)--fast(?=\s|$)/gi, value: "simple" },
    { regex: /(^|\s)--auto(?=\s|$)/gi, value: "auto" },
    { regex: /(^|\s)--balanced(?=\s|$)/gi, value: "auto" },
    { regex: /(^|\s)--complex(?=\s|$)/gi, value: "complex" },
    { regex: /(^|\s)--deep(?=\s|$)/gi, value: "complex" },
  ];
  for (const { regex, value } of budgetFlags) {
    const matched = regex.test(cleaned);
    regex.lastIndex = 0;
    if (matched) {
      budgetMode = value;
      cleaned = cleaned.replace(regex, " ");
      regex.lastIndex = 0;
    }
  }

  // Generic --<flag> catch-all: any remaining --<word> flags are treated as persona names.
  // Known engine/budget/model flags were already consumed above.
  const knownFlags = new Set([
    "amp", "claude", "claude-code", "codex", "pi", "pi-mono",
    "simple", "fast", "auto", "balanced", "complex", "deep",
    "opus", "sonnet", "haiku", "engine", "model",
  ]);
  const genericFlagRegex = /(^|\s)--([a-z][a-z0-9-]*)(?=\s|$)/gi;
  let genericMatch: RegExpExecArray | null;
  while ((genericMatch = genericFlagRegex.exec(cleaned)) !== null) {
    const flag = genericMatch[2];
    if (knownFlags.has(flag)) continue;
    harness = flag;
    harnessExplicit = true;
  }
  cleaned = cleaned.replace(genericFlagRegex, " ");

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return { harness, budgetMode, cleanedText: cleaned, harnessExplicit };
}

function isBusyRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("already in progress") || normalized.includes("run is already in progress");
}

const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 15_000;

async function* reconnectLoop(opts: {
  threadKey: string;
  harnessName: string;
  skipCount: number;
  delayBeforeFirst: boolean;
  skipDoneCount?: number;
}): AsyncGenerator<CanonicalEvent, string, undefined> {
  const { threadKey, harnessName, skipCount, delayBeforeFirst, skipDoneCount } = opts;
  const maxAttempts = RECONNECT_MAX_ATTEMPTS + (delayBeforeFirst ? 0 : 1);
  let yieldedCount = 0;
  let lastAssistantText = "";
  let resultText = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shouldDelay = delayBeforeFirst || attempt > 0;
    if (shouldDelay) {
      const exponent = delayBeforeFirst ? attempt : attempt - 1;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, exponent), RECONNECT_MAX_MS);
      log.info("stream_reconnect", {
        thread: threadKey,
        attempt: attempt + 1,
        delay_ms: delay,
        skipping: skipCount + yieldedCount,
      });
      await new Promise((r) => setTimeout(r, delay));
    }

    let res: Response;
    try {
      res = await resilientFetch(`${API_URL}/agent/reconnect`, {
        method: "POST",
        body: JSON.stringify({
          thread_key: threadKey,
          harness: harnessName,
          ...(skipDoneCount ? { skip_done_count: skipDoneCount } : {}),
        }),
        headers: { "X-Trace-Id": threadKey },
        timeoutMs: 10 * 60_000,
        maxAttempts: 1,
        stream: true,
      });
    } catch (err) {
      if (attempt + 1 < maxAttempts && isNetworkError(err)) continue;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 && attempt + 1 < maxAttempts) continue;
      throw new ApiError(
        `/agent/reconnect failed (${res.status}): ${text.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }

    try {
      const inner = readSSEStream(res, harnessName);
      let replayCount = 0;
      while (true) {
        const { done, value } = await inner.next();
        if (done) {
          const ret = value as { lastAssistantText: string; resultText: string; sawDone: boolean };
          lastAssistantText = ret.lastAssistantText || lastAssistantText;
          resultText = ret.resultText || resultText;
          return resultText || lastAssistantText;
        }
        replayCount++;
        if (replayCount <= skipCount + yieldedCount) continue;
        if (value.type === "result" && "text" in value) resultText = value.text;
        yieldedCount++;
        yield value;
      }
    } catch (err) {
      if (attempt + 1 < maxAttempts && isNetworkError(err)) continue;
      throw err;
    }
  }

  return resultText || lastAssistantText;
}

async function* readSSEStream(
  res: Response,
  harnessName: string,
): AsyncGenerator<
  CanonicalEvent,
  { lastAssistantText: string; resultText: string; sawDone: boolean },
  undefined
> {
  if (!res.body) return { lastAssistantText: "", resultText: "", sawDone: true };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastAssistantText = "";
  let resultText = "";
  let sawDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (buf.includes("\n\n")) {
      const boundary = buf.indexOf("\n\n");
      const raw = buf.slice(0, boundary);
      buf = buf.slice(boundary + 2);

      const dataLines = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") {
        sawDone = true;
        break;
      }

      try {
        const evt = JSON.parse(payload);
        const canonical = normalizeHarnessEvent(String(harnessName), evt);
        for (const ce of canonical) {
          if (ce.type === "result" && "text" in ce) {
            resultText = ce.text;
          } else if (ce.type === "assistant" && ce.message?.content) {
            for (const block of ce.message.content) {
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
              }
            }
          }
          yield ce;
        }
      } catch {
        if (payload.trim()) lastAssistantText = payload.trim();
      }
    }
    if (sawDone) break;
  }

  return { lastAssistantText, resultText, sawDone };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

export async function* executeStreaming(
  threadKey: string,
  message: string | ContentBlock[],
  harness?: Harness | null,
  options?: { platform?: string; userId?: string },
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const harnessName = harness || "amp";

  log.info("sse_connect", { thread_key: normalizedKey, endpoint: "execute", harness: harnessName });

  // Initial execute request
  const body: Record<string, unknown> = {
    thread_key: normalizedKey,
    message,
    harness: harnessName,
  };
  if (options?.platform) body.platform = options.platform;
  if (options?.userId) body.user_id = options.userId;
  const res = await resilientFetch(`${API_URL}/agent/execute`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Trace-Id": normalizedKey },
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    stream: true,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `/agent/execute failed (${res.status}): ${text.slice(0, 300)}`,
      res.status,
      res.status >= 500,
    );
  }

  let lastAssistantText = "";
  let resultText = "";
  // Track events already yielded so reconnect (which replays full history
  // via logs=True) can skip them and only surface new output.
  let yieldedCount = 0;
  let firstEvent = false;

  try {
    const inner = readSSEStream(res, harnessName);
    while (true) {
      const { done, value } = await inner.next();
      if (done) {
        const ret = value as { lastAssistantText: string; resultText: string; sawDone: boolean };
        lastAssistantText = ret.lastAssistantText || lastAssistantText;
        resultText = ret.resultText || resultText;
        if (ret.sawDone) {
          log.info("sse_done", { thread_key: normalizedKey, yielded_count: yieldedCount });
          return resultText || lastAssistantText;
        }
        break; // EOF without [DONE] — stream dropped cleanly
      }
      if (!firstEvent) {
        firstEvent = true;
        log.info("sse_first_event", { thread_key: normalizedKey });
      }
      if (value.type === "result" && "text" in value) resultText = value.text;
      yieldedCount++;
      yield value;
    }
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    // Mid-stream network error — fall through to reconnect
    log.warn("stream_disconnect", {
      thread: normalizedKey,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Reconnect loop: the container is still running, just re-attach to stdout.
  // The API replays full stdout history (logs=True) so we skip events we
  // already yielded and only forward new ones (produced during the gap).
  return yield* reconnectLoop({
    threadKey: normalizedKey,
    harnessName,
    skipCount: yieldedCount,
    delayBeforeFirst: true,
  });
}

/**
 * Re-attach to a running container's stdout without sending a new turn.
 *
 * Used after a follow=true handoff: Amp has already navigated to the new
 * thread and started working autonomously — we just need to read its output.
 * Sending a new turn.start (via executeStreaming) would create a competing
 * turn that produces a stale "mid-reply" summary.
 *
 * Also used for post-restart recovery when the slackbot reconnects to a
 * container that was running while the process was down.
 */
export async function* reconnectStreaming(
  threadKey: string,
  harness?: Harness | null,
  skipCount: number = 0,
  skipDoneCount: number = 0,
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const harnessName = harness || "amp";

  return yield* reconnectLoop({
    threadKey: normalizedKey,
    harnessName,
    skipCount,
    delayBeforeFirst: false,
    skipDoneCount,
  });
}

export async function fetchThreadHarness(threadKey: string): Promise<Harness | null> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT harness FROM sandbox_sessions WHERE thread_key = $1`,
    [normalizedThreadKey],
  );
  return rows[0]?.harness || null;
}

export async function* executeStreamingWithBusyRetries(
  threadKey: string,
  message: string | ContentBlock[],
  harness: Harness,
  options?: { platform?: string; userId?: string },
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return yield* executeStreaming(threadKey, message, harness, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isBusyRunError(detail) && attempt < maxAttempts) {
        await sleep(Math.min(300 * Math.pow(2, attempt - 1), 2500));
        continue;
      }
      throw error;
    }
  }
  return "";
}

export async function* reconnectStreamingWithRetries(
  threadKey: string,
  harness: Harness,
  skipCount: number = 0,
  skipDoneCount: number = 0,
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return yield* reconnectStreaming(threadKey, harness, skipCount, skipDoneCount);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isBusyRunError(detail) && attempt < maxAttempts) {
        await sleep(Math.min(300 * Math.pow(2, attempt - 1), 2500));
        continue;
      }
      throw error;
    }
  }
  return "";
}

export async function postThreadContextMessage(
  threadKey: string,
  text: string,
  options?: {
    source?: string;
    userId?: string;
    messageId?: string;
    slackTs?: string;
    attachments?: Array<{ url: string; name: string; mimeType?: string }>;
  },
): Promise<{ status: string }> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  const pool = getPool();
  const msgId = options?.messageId || `ctx-${normalizedThreadKey}-${Date.now()}`;
  const metadata: Record<string, unknown> = {};
  if (options?.source) metadata.source = options.source;
  if (options?.userId) metadata.user_id = options.userId;
  if (options?.attachments?.length) metadata.attachments = options.attachments;

  // Derive created_at from the Slack message timestamp so messages sort in
  // the order they were actually posted, not when the webhook was processed.
  const ts = options?.slackTs || options?.messageId || "";
  const epoch = parseFloat(ts);
  const createdAt = epoch > 1_000_000_000 ? new Date(epoch * 1000).toISOString() : null;

  if (createdAt) {
    await pool.query(
      `INSERT INTO chat_messages (id, thread_key, role, parts, metadata, created_at)
       VALUES ($1, $2, 'user', $3::jsonb, $4::jsonb, $5::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [msgId, normalizedThreadKey, JSON.stringify([{ type: "text", text }]), JSON.stringify(metadata), createdAt],
    );
  } else {
    await pool.query(
      `INSERT INTO chat_messages (id, thread_key, role, parts, metadata)
       VALUES ($1, $2, 'user', $3::jsonb, $4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [msgId, normalizedThreadKey, JSON.stringify([{ type: "text", text }]), JSON.stringify(metadata)],
    );
  }
  return { status: "accepted" };
}

export async function postMessages(
  threadKey: string,
  messages: Array<{
    role?: string;
    parts: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
    user_id?: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<{ ok: boolean; inserted: number }> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const res = await resilientFetch(`${API_URL}/agent/messages`, {
    method: "POST",
    body: JSON.stringify({
      thread_key: normalizedKey,
      messages,
    }),
    timeoutMs: 10_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `/agent/messages failed (${res.status}): ${text.slice(0, 300)}`,
      res.status,
      res.status >= 500,
    );
  }
  return res.json();
}

export { normalizeThreadKey };

