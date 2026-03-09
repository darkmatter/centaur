import { apiPost, resilientFetch, ApiError, API_URL } from "./api-client";
import { getPool } from "@/lib/db";
import { normalizeHarnessEvent, type CanonicalEvent } from "@/lib/normalize-harness-event";

export type Engine = "amp" | "claude-code" | "codex" | "pi-mono";
export type Harness = Engine | "eng" | "legal";
export type BudgetMode = "simple" | "auto" | "complex";
export type FileAttachment = { url: string; name: string };
export type ExecuteSource = "slack" | "thread_ui" | "api";

export type RunOptions = {
  harness: Harness;
  engine: Engine | null;
  model: string | null;
  budgetMode: BudgetMode | null;
  cleanedText: string;
  harnessExplicit: boolean;
  engineExplicit: boolean;
  budgetExplicit: boolean;
};

type RunOptionContext = {
  activeHarness?: Harness | null;
};

export function extractRunOptions(text: string, context: RunOptionContext = {}): RunOptions {
  let cleaned = text;
  let harness: Harness = "amp";
  let engine: Engine | null = null;
  let model: string | null = null;
  let budgetMode: BudgetMode | null = null;
  let harnessExplicit = false;
  let engineExplicit = false;
  let budgetExplicit = false;
  const activeHarness = context.activeHarness ?? null;

  const isPersonaHarness = (value: Harness): value is "eng" | "legal" =>
    value === "eng" || value === "legal";

  const applyHarness = (value: Harness): void => {
    if (isPersonaHarness(value)) {
      harness = value;
      harnessExplicit = true;
      return;
    }
    if (isPersonaHarness(harness)) {
      engine = value;
      engineExplicit = true;
      return;
    }
    harness = value;
    harnessExplicit = true;
    engine = null;
    engineExplicit = false;
  };

  // --eng flag → harness="eng"
  const engRegex = /(^|\s)--eng(?=\s|$)/gi;
  if (engRegex.test(cleaned)) {
    applyHarness("eng");
    cleaned = cleaned.replace(engRegex, " ");
    engRegex.lastIndex = 0;
  }

  // --legal flag → harness="legal"
  const legalRegex = /(^|\s)--legal(?=\s|$)/gi;
  if (legalRegex.test(cleaned)) {
    applyHarness("legal");
    cleaned = cleaned.replace(legalRegex, " ");
    legalRegex.lastIndex = 0;
  }

  // harness=<value> key-value
  const kvMatch = cleaned.match(/\bharness\s*=\s*(amp|claude-code|codex|pi-mono|eng|legal)\b/i);
  if (kvMatch) {
    applyHarness(kvMatch[1].toLowerCase() as Harness);
    cleaned = (
      cleaned.slice(0, kvMatch.index) + cleaned.slice(kvMatch.index! + kvMatch[0].length)
    ).trim();
  }

  // Harness flags: --amp, --claude, --codex, --pi
  const harnessFlags: Array<{ regex: RegExp; value: Harness }> = [
    { regex: /(^|\s)--amp(?=\s|$)/gi, value: "amp" },
    { regex: /(^|\s)--claude(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--claude-code(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--codex(?=\s|$)/gi, value: "codex" },
    { regex: /(^|\s)--pi(?=\s|$)/gi, value: "pi-mono" },
    { regex: /(^|\s)--pi-mono(?=\s|$)/gi, value: "pi-mono" },
  ];
  for (const { regex, value } of harnessFlags) {
    const matched = regex.test(cleaned);
    regex.lastIndex = 0;
    if (matched) {
      applyHarness(value);
      cleaned = cleaned.replace(regex, " ");
      regex.lastIndex = 0;
    }
  }

  // --engine <harness> flag
  const engineFlagMatch = cleaned.match(
    /(^|\s)--engine\s+(amp|claude-code|codex|pi-mono)(?=\s|$)/i
  );
  if (engineFlagMatch) {
    const parsedEngine = engineFlagMatch[2].toLowerCase() as Engine;
    const personaContextHarness =
      isPersonaHarness(harness)
        ? harness
        : activeHarness && isPersonaHarness(activeHarness)
          ? activeHarness
          : null;
    if (personaContextHarness) {
      if (!isPersonaHarness(harness)) {
        harness = personaContextHarness;
      }
      engine = parsedEngine;
      engineExplicit = true;
    } else {
      harness = parsedEngine;
      harnessExplicit = true;
    }
    cleaned = cleaned.replace(engineFlagMatch[0], " ");
  }

  // Model shortcuts: --opus, --sonnet, --haiku
  const modelShortcuts: Array<{ regex: RegExp; value: string }> = [
    { regex: /(^|\s)--opus(?=\s|$)/gi, value: "opus" },
    { regex: /(^|\s)--sonnet(?=\s|$)/gi, value: "sonnet" },
    { regex: /(^|\s)--haiku(?=\s|$)/gi, value: "haiku" },
  ];
  for (const { regex, value } of modelShortcuts) {
    const matched = regex.test(cleaned);
    regex.lastIndex = 0;
    if (matched) {
      model = value;
      cleaned = cleaned.replace(regex, " ");
      regex.lastIndex = 0;
    }
  }

  // model=<value> key-value
  const modelEqMatch = cleaned.match(/\bmodel\s*=\s*([A-Za-z0-9._-]+)\b/i);
  if (modelEqMatch) {
    model = modelEqMatch[1];
    cleaned = (
      cleaned.slice(0, modelEqMatch.index) +
      cleaned.slice(modelEqMatch.index! + modelEqMatch[0].length)
    ).trim();
  }

  // --model <value> flag
  const modelFlagMatch = cleaned.match(/(^|\s)--model\s+([A-Za-z0-9._-]+)(?=\s|$)/i);
  if (modelFlagMatch) {
    model = modelFlagMatch[2];
    cleaned = cleaned.replace(modelFlagMatch[0], " ");
  }

  // Budget mode: mode=<value>
  const modeEqMatch = cleaned.match(/\bmode\s*=\s*(simple|auto|complex)\b/i);
  if (modeEqMatch) {
    budgetMode = modeEqMatch[1].toLowerCase() as BudgetMode;
    budgetExplicit = true;
    cleaned = (
      cleaned.slice(0, modeEqMatch.index) + cleaned.slice(modeEqMatch.index! + modeEqMatch[0].length)
    ).trim();
  }

  // Budget flags: --simple, --fast, --auto, --complex, --deep
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
      budgetExplicit = true;
      cleaned = cleaned.replace(regex, " ");
      regex.lastIndex = 0;
    }
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return {
    harness,
    engine,
    model,
    budgetMode,
    cleanedText: cleaned,
    harnessExplicit,
    engineExplicit,
    budgetExplicit,
  };
}

const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 15_000;

function isStreamNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("etimedout")
  );
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

export async function* executeStreaming(
  threadKey: string,
  message: string,
  harness?: Harness | null,
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const harnessName = harness || "amp";

  // Initial execute request
  const res = await resilientFetch(`${API_URL}/agent/execute`, {
    method: "POST",
    body: JSON.stringify({
      thread_key: normalizedKey,
      message,
      harness: harnessName,
    }),
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    stream: true,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `/pipe/execute failed (${res.status}): ${text.slice(0, 300)}`,
      res.status,
      res.status >= 500,
    );
  }

  let lastAssistantText = "";
  let resultText = "";
  // Track events already yielded so reconnect (which replays full history
  // via logs=True) can skip them and only surface new output.
  let yieldedCount = 0;

  try {
    const inner = readSSEStream(res, harnessName);
    while (true) {
      const { done, value } = await inner.next();
      if (done) {
        const ret = value as { lastAssistantText: string; resultText: string; sawDone: boolean };
        lastAssistantText = ret.lastAssistantText || lastAssistantText;
        resultText = ret.resultText || resultText;
        if (ret.sawDone) {
          return resultText || lastAssistantText;
        }
        break; // EOF without [DONE] — stream dropped cleanly
      }
      if (value.type === "result" && "text" in value) resultText = value.text;
      yieldedCount++;
      yield value;
    }
  } catch (err) {
    if (!isStreamNetworkError(err)) throw err;
    // Mid-stream network error — fall through to reconnect
    console.log(JSON.stringify({
      event: "stream_disconnect",
      thread: normalizedKey,
      reason: err instanceof Error ? err.message : String(err),
    }));
  }

  // Reconnect loop: the container is still running, just re-attach to stdout.
  // The API replays full stdout history (logs=True) so we skip events we
  // already yielded and only forward new ones (produced during the gap).
  for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, attempt),
      RECONNECT_MAX_MS,
    );
    console.log(JSON.stringify({
      event: "stream_reconnect",
      thread: normalizedKey,
      attempt: attempt + 1,
      delay_ms: delay,
      skipping: yieldedCount,
    }));
    await new Promise((r) => setTimeout(r, delay));

    let reconnRes: Response;
    try {
      reconnRes = await resilientFetch(`${API_URL}/agent/reconnect`, {
        method: "POST",
        body: JSON.stringify({
          thread_key: normalizedKey,
          harness: harnessName,
        }),
        timeoutMs: 10 * 60_000,
        maxAttempts: 1,
        stream: true,
      });
    } catch (err) {
      if (attempt + 1 < RECONNECT_MAX_ATTEMPTS && isStreamNetworkError(err)) continue;
      throw err;
    }

    if (!reconnRes.ok) {
      const text = await reconnRes.text().catch(() => "");
      if (reconnRes.status >= 500 && attempt + 1 < RECONNECT_MAX_ATTEMPTS) continue;
      throw new ApiError(
        `/agent/reconnect failed (${reconnRes.status}): ${text.slice(0, 300)}`,
        reconnRes.status,
        reconnRes.status >= 500,
      );
    }

    try {
      const inner = readSSEStream(reconnRes, harnessName);
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
        if (replayCount <= yieldedCount) continue; // skip already-yielded events
        if (value.type === "result" && "text" in value) resultText = value.text;
        yieldedCount++;
        yield value;
      }
    } catch (err) {
      if (attempt + 1 < RECONNECT_MAX_ATTEMPTS && isStreamNetworkError(err)) continue;
      throw err;
    }
  }

  return resultText || lastAssistantText;
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
): AsyncGenerator<CanonicalEvent, string, undefined> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const harnessName = harness || "amp";
  let yieldedCount = 0;
  let lastAssistantText = "";
  let resultText = "";

  for (let attempt = 0; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, attempt - 1),
        RECONNECT_MAX_MS,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    let res: Response;
    try {
      res = await resilientFetch(`${API_URL}/agent/reconnect`, {
        method: "POST",
        body: JSON.stringify({
          thread_key: normalizedKey,
          harness: harnessName,
        }),
        timeoutMs: 10 * 60_000,
        maxAttempts: 1,
        stream: true,
      });
    } catch (err) {
      if (attempt < RECONNECT_MAX_ATTEMPTS && isStreamNetworkError(err)) continue;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 && attempt < RECONNECT_MAX_ATTEMPTS) continue;
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
      if (attempt < RECONNECT_MAX_ATTEMPTS && isStreamNetworkError(err)) continue;
      throw err;
    }
  }

  return resultText || lastAssistantText;
}

export async function execute(
  threadKey: string,
  message: string,
  harness?: Harness | null,
  _requestId?: string,
  _files?: FileAttachment[],
  _userId?: string,
  _source: ExecuteSource = "slack",
  _model?: string | null,
  _engine?: Engine | null,
  _continueSession: boolean = true,
): Promise<string> {
  let lastText = "";
  const gen = executeStreaming(threadKey, message, harness);
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      return value;
    }
    const event = value;
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          lastText = block.text;
        }
      }
    }
  }
}

export async function interrupt(
  threadKey: string,
  _requestId?: string,
): Promise<{ sessionId: string; status: string }> {
  const normalizedKey = normalizeThreadKey(threadKey);
  const result = await apiPost("/agent/stop", {
    thread_key: normalizedKey,
  }, { timeoutMs: 30_000 });
  return {
    sessionId: normalizedKey,
    status: result.ok ? "stopped" : "not_found",
  };
}

export async function fetchThreadRuntimeConfig(
  threadKey: string
): Promise<{ harness: Harness | null; engine: Engine | null }> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT metadata->>'harness' as harness, metadata->>'engine' as engine
     FROM chat_messages
     WHERE thread_key = $1 AND metadata->>'harness' IS NOT NULL
     ORDER BY role = 'assistant' DESC, created_at DESC LIMIT 1`,
    [normalizedThreadKey],
  );
  if (rows.length === 0) return { harness: null, engine: null };
  const rawHarness = String(rows[0].harness ?? "").trim().toLowerCase();
  const rawEngine = String(rows[0].engine ?? "").trim().toLowerCase();
  const harness: Harness | null =
    rawHarness === "eng" || rawHarness === "engineer"
      ? "eng"
      : rawHarness === "legal"
        ? "legal"
        : rawHarness === "amp" || rawHarness === "claude-code" || rawHarness === "codex" || rawHarness === "pi-mono"
          ? (rawHarness as Engine)
          : null;
  const engine: Engine | null =
    rawEngine === "amp" || rawEngine === "claude-code" || rawEngine === "codex" || rawEngine === "pi-mono"
      ? (rawEngine as Engine)
      : null;
  return { harness, engine };
}

export async function postThreadContextMessage(
  threadKey: string,
  text: string,
  options?: {
    source?: string;
    userId?: string;
    messageId?: string;
    slackTs?: string;
    attachments?: FileAttachment[];
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

export function splitThreadKey(threadKey: string): { channel: string; threadTs: string } {
  const parts = threadKey.trim().split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { channel: parts[0], threadTs: parts[1] };
  }
  if (parts.length === 3 && parts[1] && parts[2]) {
    return { channel: parts[1], threadTs: parts[2] };
  }
  throw new Error(`Invalid thread key format (expected <channel>:<thread_ts>): ${threadKey}`);
}

export function normalizeThreadKey(threadKey: string): string {
  const { channel, threadTs } = splitThreadKey(threadKey);
  return `${channel}:${threadTs}`;
}

export function watchProgress(
  threadKey: string,
  onStatus: (status: string) => void,
): () => void {
  const normalizedKey = normalizeThreadKey(threadKey);
  let stopped = false;

  const poll = async () => {
    while (!stopped) {
      try {
        const res = await resilientFetch(
          `${API_URL}/agent/status?key=${encodeURIComponent(normalizedKey)}`,
          { timeoutMs: 5000, maxAttempts: 1 },
        );
        if (res.ok) {
          const data = await res.json();
          if (data.status === "running") {
            onStatus("Agent working...");
          }
        }
      } catch {
        // ignore
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  };

  void poll();
  return () => { stopped = true; };
}
