// Native RPC/transcript helpers for the opt-in OMP live test. The handshake mirrors
// harness-server's omp.rs; this module only transports frames and reads the JSONL journal.
import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type Frame = Record<string, unknown>;

export const PROVIDER = "anthropic";
export const MODEL_ID = "claude-sonnet-5";

const READY_MS = 120_000;
const ACK_MS = 60_000;
const MARKER_NEEDLES = [
  "turn-cancelled",
  "turn_cancelled",
  "previous request before the assistant produced any output",
];

export function newToken(label: string): string {
  return `${label}_${randomBytes(10).toString("hex").toUpperCase()}`;
}
export function newId(role: string, kind: string): string {
  return `live-${role}-${kind}-${randomBytes(6).toString("hex")}`;
}

export function asFrame(value: unknown): Frame | null {
  return typeof value === "object" && value !== null ? (value as Frame) : null;
}

export function messageText(message: unknown): string {
  const frame = asFrame(message);
  if (!frame) return "";
  const content = frame.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      const block = asFrame(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

export function recordText(record: Frame): string {
  return messageText(record.message);
}

export function transcriptFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith(".jsonl"))
      .sort()
      .map(name => join(dir, name));
  } catch {
    return [];
  }
}

export function readSession(path: string): Frame[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: Frame[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = asFrame(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // trailing partial write
    }
  }
  return records;
}

function messageRecords(records: Frame[]): Frame[] {
  return records.filter(record => record.type === "message");
}

export function userEntriesWith(records: Frame[], token: string): Frame[] {
  return messageRecords(records).filter(
    record => asFrame(record.message)?.role === "user" && recordText(record).includes(token),
  );
}

export function assistantEntries(records: Frame[]): Frame[] {
  return messageRecords(records).filter(record => asFrame(record.message)?.role === "assistant");
}

export function abortedAssistants(records: Frame[]): Frame[] {
  return assistantEntries(records).filter(entry => asFrame(entry.message)?.stopReason === "aborted");
}

export function isCompletedAssistant(entry: Frame): boolean {
  const message = asFrame(entry.message);
  return (
    message?.role === "assistant" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error"
  );
}

export function toolCounts(records: Frame[]): { calls: number; results: number } {
  let calls = 0;
  let results = 0;
  for (const record of messageRecords(records)) {
    const message = asFrame(record.message);
    if (message?.role === "toolResult") results += 1;
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (asFrame(part)?.type === "toolCall") calls += 1;
    }
  }
  return { calls, results };
}

/** The patched context marker is model-context-only; any journal hit is a bug. */
export function hasTurnCancelledRecord(records: Frame[]): boolean {
  return records.some(record => {
    if (record.type === "custom_message" && record.customType === "turn-cancelled") {
      return true;
    }
    let serialized = "";
    try {
      serialized = JSON.stringify(record).toLowerCase();
    } catch {
      return false;
    }
    return MARKER_NEEDLES.some(needle => serialized.includes(needle));
  });
}

export function modelOutputFrames(frames: Frame[]): Frame[] {
  return frames.filter(frame => {
    if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
      return true;
    }
    if (frame.type === "message_update") return true;
    if (frame.type === "message_end") {
      return asFrame(frame.message)?.role === "assistant";
    }
    return false;
  });
}

/** Frame window scan: first match at/after start, bounded by timeout and deadline. */
export async function poll<T>(
  scan: () => T | null,
  timeoutMs: number,
  deadline: number,
): Promise<T | null> {
  const end = Date.now() + Math.min(timeoutMs, Math.max(0, deadline - Date.now()));
  for (;;) {
    const hit = scan();
    if (hit !== null) return hit;
    if (Date.now() >= end) return null;
    await Bun.sleep(30);
  }
}

type Child = {
  kill(signal?: number | string): void;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write(chunk: string): number; flush(): Promise<void> };
};

export class NativeOmp {
  readonly frames: Frame[] = [];
  parseErrors = 0;
  stderrBytes = 0;
  private stopped = false;

  private constructor(
    readonly role: string,
    readonly child: Child,
    private readonly deadline: number,
  ) {}

  static start(role: string, ompBin: string, cwd: string, deadline: number): NativeOmp {
    // Bun's spawn overloads do not unify on the pipe shape; this is its runtime shape.
    const child = Bun.spawn([ompBin, "--mode", "rpc", "--no-ui"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    }) as unknown as Child;
    const proc = new NativeOmp(role, child, deadline);
    void proc.pumpFrames(child.stdout);
    void proc.pumpStderr(child.stderr);
    return proc;
  }

  private async pumpFrames(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = -1;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const frame = asFrame(JSON.parse(line));
          if (frame) this.frames.push(frame);
          else this.parseErrors += 1;
        } catch {
          this.parseErrors += 1;
        }
      }
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderrBytes += value.length;
    }
  }

  async send(frame: Frame) {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
    await this.child.stdin.flush();
  }

  /** Send a command with a unique id and return only its correlated response. */
  async request(
    kind: string,
    fields: Frame,
    options?: { id?: string; timeoutMs?: number },
  ): Promise<{ id: string; response: Frame; data: Frame }> {
    const id = options?.id ?? newId(this.role, kind);
    const start = this.frames.length;
    await this.send({ ...fields, type: kind, id });
    const response = await poll(
      () => {
        for (let index = start; index < this.frames.length; index += 1) {
          const frame = this.frames[index];
          if (frame.type === "response" && frame.id === id) return frame;
        }
        return null;
      },
      options?.timeoutMs ?? 30_000,
      this.deadline,
    );
    if (!response) throw new Error(`${this.role}:${kind} response timeout`);
    if (response.success !== true) {
      const error = asFrame(response.error);
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      throw new Error(`${this.role}:${kind} failed${code}`);
    }
    return { id, response, data: asFrame(response.data) ?? {} };
  }

  async handshake(sessionDir: string): Promise<Frame> {
    if (!(await poll(() => this.frames.find(frame => frame.type === "ready") ?? null, READY_MS, this.deadline))) {
      throw new Error(`${this.role}: ready frame timeout`);
    }
    const negotiated = await this.request("negotiate_protocol", { protocolVersion: 2 });
    if (negotiated.data.protocolVersion !== 2) {
      throw new Error(`${this.role}: negotiate_protocol: expected protocolVersion 2`);
    }
    await this.request("set_event_filter", {
      events: [
        "agent_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
      ],
      messageUpdates: "delta",
    });
    const opened = await this.request(
      "open_session",
      { sessionDir, provider: PROVIDER, modelId: MODEL_ID },
      { timeoutMs: ACK_MS },
    );
    if (opened.data.cancelled === true) throw new Error(`${this.role}: open_session cancelled`);
    await this.request("set_thinking_level", { level: "inherit" });
    await this.request("set_cache_warming", { mode: "off" });
    return opened.data;
  }

  async promptResult(id: string, start: number, timeoutMs: number): Promise<Frame | null> {
    return poll(
      () => {
        for (let index = start; index < this.frames.length; index += 1) {
          const frame = this.frames[index];
          if (frame.type === "prompt_result" && frame.id === id) return frame;
        }
        return null;
      },
      timeoutMs,
      this.deadline,
    );
  }

  kill() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  async stop() {
    this.kill();
    try {
      await Promise.race([this.child.exited, Bun.sleep(5_000)]);
    } catch {
      // exited race lost
    }
  }
}
