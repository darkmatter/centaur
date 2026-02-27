const API_URL = process.env.AI_V2_API_URL || "http://api:8000";
const API_KEY = process.env.AI_V2_API_KEY || "";

async function agentCall(
  endpoint: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const res = await fetch(`${API_URL}/agent/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agent/${endpoint} failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const elapsed = Math.round(performance.now() - t0);
  console.log(
    JSON.stringify({
      event: "api_call",
      endpoint: `agent/${endpoint}`,
      request_id: args.request_id ?? null,
      thread: args.slack_thread_key ?? null,
      elapsed_ms: elapsed,
    })
  );
  return data;
}

export type Harness = "amp" | "claude-code" | "codex" | "pi-mono";
export type AgentMode = "default" | "eng";
export type FileAttachment = { url: string; name: string };

export type RunOptions = {
  mode: AgentMode;
  harness: Harness | null;
  modelPreference: string | null;
  cleanedText: string;
  modeExplicit: boolean;
  harnessExplicit: boolean;
};

export function extractRunOptions(text: string): RunOptions {
  let cleaned = text;
  let mode: AgentMode = "default";
  let harness: Harness | null = null;
  let modelPreference: string | null = null;
  let modeExplicit = false;
  let harnessExplicit = false;

  const modeRegex = /(^|\s)--eng(?=\s|$)/gi;
  if (modeRegex.test(cleaned)) {
    mode = "eng";
    modeExplicit = true;
    cleaned = cleaned.replace(modeRegex, " ");
  }

  const kvMatch = cleaned.match(/\bharness\s*=\s*(amp|claude-code|codex|pi-mono)\b/i);
  if (kvMatch) {
    harness = kvMatch[1].toLowerCase() as Harness;
    modelPreference = harness;
    harnessExplicit = true;
    cleaned = (
      cleaned.slice(0, kvMatch.index) + cleaned.slice(kvMatch.index! + kvMatch[0].length)
    ).trim();
  }

  const harnessFlags: Array<{ regex: RegExp; value: Harness }> = [
    { regex: /(^|\s)--amp(?=\s|$)/gi, value: "amp" },
    { regex: /(^|\s)--claude(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--claude-code(?=\s|$)/gi, value: "claude-code" },
    { regex: /(^|\s)--codex(?=\s|$)/gi, value: "codex" },
    { regex: /(^|\s)--pi(?=\s|$)/gi, value: "pi-mono" },
    { regex: /(^|\s)--pi-mono(?=\s|$)/gi, value: "pi-mono" },
  ];
  for (const { regex, value } of harnessFlags) {
    if (regex.test(cleaned)) {
      harness = value;
      modelPreference = value;
      harnessExplicit = true;
      cleaned = cleaned.replace(regex, " ");
    }
  }

  const engineFlagMatch = cleaned.match(
    /(^|\s)--engine\s+(amp|claude-code|codex|pi-mono)(?=\s|$)/i
  );
  if (engineFlagMatch) {
    harness = engineFlagMatch[2].toLowerCase() as Harness;
    modelPreference = harness;
    harnessExplicit = true;
    cleaned = cleaned.replace(engineFlagMatch[0], " ");
  }

  const modelEqMatch = cleaned.match(/\bmodel\s*=\s*([A-Za-z0-9._-]+)\b/i);
  if (modelEqMatch) {
    modelPreference = modelEqMatch[1];
    cleaned = (
      cleaned.slice(0, modelEqMatch.index) +
      cleaned.slice(modelEqMatch.index! + modelEqMatch[0].length)
    ).trim();
  }

  const modelFlagMatch = cleaned.match(/(^|\s)--model\s+([A-Za-z0-9._-]+)(?=\s|$)/i);
  if (modelFlagMatch) {
    modelPreference = modelFlagMatch[2];
    cleaned = cleaned.replace(modelFlagMatch[0], " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return {
    mode,
    harness,
    modelPreference,
    cleanedText: cleaned,
    modeExplicit,
    harnessExplicit,
  };
}

export function extractHarness(text: string): {
  harness: Harness;
  cleanedText: string;
} {
  const parsed = extractRunOptions(text);
  return { harness: parsed.harness ?? "amp", cleanedText: parsed.cleanedText };
}

export async function spawn(
  threadKey: string,
  harness: Harness = "amp",
  repo?: string,
  requestId?: string
): Promise<{ sessionId: string; status: string }> {
  const result = await agentCall("spawn", {
    slack_thread_key: threadKey,
    harness,
    ...(repo ? { repo } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  });
  return {
    sessionId: result.session_id as string,
    status: result.status as string,
  };
}

export async function execute(
  threadKey: string,
  message: string,
  harness: Harness = "amp",
  requestId?: string,
  files?: FileAttachment[],
): Promise<string> {
  const result = await agentCall("execute", {
    slack_thread_key: threadKey,
    message,
    harness,
    ...(requestId ? { request_id: requestId } : {}),
    ...(files && files.length > 0 ? { files } : {}),
  });
  return (result.result as string) || "No response from agent.";
}

export async function stop(threadKey: string): Promise<void> {
  await agentCall("stop", { slack_thread_key: threadKey });
}

export async function interrupt(threadKey: string): Promise<void> {
  await agentCall("interrupt", { slack_thread_key: threadKey });
}

async function apiCall(
  path: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function splitThreadKey(threadKey: string): { channel: string; threadTs: string } {
  const idx = threadKey.indexOf(":");
  if (idx <= 0 || idx >= threadKey.length - 1) {
    throw new Error(`Invalid thread key: ${threadKey}`);
  }
  return {
    channel: threadKey.slice(0, idx),
    threadTs: threadKey.slice(idx + 1),
  };
}

export async function startEngineerFlow(
  threadKey: string,
  task: string,
  modelPreference?: string | null,
  attachments?: FileAttachment[]
): Promise<{ status: string; runId?: string }> {
  const { channel, threadTs } = splitThreadKey(threadKey);
  const result = await apiCall("/slack/start", {
    thread_key: threadKey,
    channel,
    thread_ts: threadTs,
    task,
    model_preference: modelPreference ?? null,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });
  return {
    status: (result.status as string) || "started",
    runId: result.run_id as string | undefined,
  };
}

export async function replyEngineerFlow(
  threadKey: string,
  reply: string,
  attachments?: FileAttachment[]
): Promise<{ status: string }> {
  const result = await apiCall("/slack/reply", {
    thread_key: threadKey,
    reply,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });
  return { status: (result.status as string) || "accepted" };
}
