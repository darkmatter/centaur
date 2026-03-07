import { apiPost, apiGet, resilientFetch, ApiError, API_URL, API_KEY } from "./api-client";

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
  const normalizedKey = normalizeThreadKey(threadKey);
  const res = await resilientFetch(`${API_URL}/agent/execute`, {
    method: "POST",
    body: JSON.stringify({
      thread_key: normalizedKey,
      message,
      harness: harness || "amp",
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
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastAssistantText = "";

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
      if (payload === "[DONE]") break;

      try {
        const evt = JSON.parse(payload);
        // Collect assistant text from harness events
        if (evt.type === "result" && typeof evt.result === "string") {
          lastAssistantText = evt.result;
        } else if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              lastAssistantText = block.text;
            }
          }
        }
      } catch {
        // Non-JSON line — could be plain text result
        if (payload.trim()) lastAssistantText = payload.trim();
      }
    }
  }

  return lastAssistantText;
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
  const response = await apiGet(
    "/api/threads/detail",
    { key: normalizedThreadKey },
    { timeoutMs: 10_000, maxAttempts: 2 }
  );
  if (!response.ok) {
    throw new ApiError(`thread detail failed (${response.status})`, response.status, response.status >= 500);
  }
  const payload = await response.json();
  const rawHarness = String(payload?.harness ?? "").trim().toLowerCase();
  const rawEngine = String(payload?.engine ?? "").trim().toLowerCase();
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
    attachments?: FileAttachment[];
  },
): Promise<{ status: string }> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  const payload: Record<string, unknown> = {
    thread_key: normalizedThreadKey,
    text,
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.userId ? { user_id: options.userId } : {}),
    ...(options?.messageId ? { message_id: options.messageId } : {}),
    ...(options?.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };
  const result = await apiPost("/api/threads/context-message", payload, { timeoutMs: 30_000 });
  return { status: String(result.status ?? "accepted") };
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
  const controller = new AbortController();
  const normalizedKey = normalizeThreadKey(threadKey);
  const url = `${API_URL}/api/threads/stream-ui?key=${encodeURIComponent(normalizedKey)}&live_only=1`;

  (async () => {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${API_KEY}`,
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (!controller.signal.aborted) {
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
          if (payload === "[DONE]") return;

          try {
            const evt = JSON.parse(payload);
            const status = describeEvent(evt);
            if (status) onStatus(status);
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }
    } catch {
      // Connection closed or aborted — expected on cleanup.
    }
  })();

  return () => controller.abort();
}

function describeEvent(evt: Record<string, unknown>): string | null {
  const type = typeof evt.type === "string" ? evt.type : "";

  if (type === "assistant") {
    const message = evt.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      if (block?.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool";
        return `Running tool: ${name}`;
      }
    }
    return "Generating response...";
  }

  if (type === "tool") return null;
  if (type === "reasoning") return "Thinking...";

  if (type === "command_execution") {
    const cmd = typeof evt.command === "string" ? evt.command : "";
    if (cmd) {
      const short = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      return `Running: ${short}`;
    }
    return "Running command...";
  }

  if (type === "status") {
    const stage = typeof evt.stage === "string" ? evt.stage : "";
    if (stage === "container.creating") return "Creating container...";
    if (stage === "container.ready") return "Container ready";
    if (stage === "files.downloading") return "Downloading files...";
    if (stage === "exec.start") return "Agent starting...";
    return null;
  }

  if (type === "data-agent-status") {
    const data = evt.data as Record<string, unknown> | undefined;
    const text = typeof data?.text === "string" ? data.text : "";
    if (text) return text;
  }

  return null;
}
