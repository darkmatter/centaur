import { normalizeThreadKey, splitThreadKey } from "@centaur/harness-events";
import type { CanonicalEvent } from "@centaur/harness-events";
import { CentaurClient } from "@centaur/api-client";
import type { InputContentBlock } from "@centaur/api-client";

import { stringifyMarkdown, type StreamChunk } from "chat";
import type { Root } from "chat";
import { log } from "@/lib/logger";
import { ProgressTracker } from "./progress-tracker";

const KEEPALIVE_MS = 120_000; // 2 min — Slack expires streaming state after ~5 min
const STREAM_EXPIRED_POLL_INTERVAL_MS = 3_000;
const STREAM_EXPIRED_POLL_MAX_MS = 5 * 60_000;
const SLACK_MSG_MAX_CHARS = 3900; // Slack's hard limit is 4000; leave margin
const RECONNECT_MAX_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 2_000;

/**
 * Split text into chunks that fit within Slack's message limit.
 * Splits on paragraph boundaries (double newline), falling back to single newlines,
 * then hard-cutting at the limit if no natural break is found.
 */
export function splitSlackMessage(text: string, limit = SLACK_MSG_MAX_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = -1;
    // Prefer splitting at a paragraph boundary
    const paraIdx = remaining.lastIndexOf("\n\n", limit);
    if (paraIdx > limit * 0.3) {
      cut = paraIdx;
    } else {
      // Fall back to single newline
      const nlIdx = remaining.lastIndexOf("\n", limit);
      if (nlIdx > limit * 0.3) {
        cut = nlIdx;
      } else {
        // Hard cut at last space
        const spIdx = remaining.lastIndexOf(" ", limit);
        cut = spIdx > limit * 0.3 ? spIdx : limit;
      }
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Extract harness/persona flag (e.g. --invest, --legal) from message text. */
function parseHarnessFlag(text: string): string | undefined {
  // Match --flag patterns, skip known non-harness flags
  const skip = new Set(["engine", "model", "opus", "sonnet", "haiku"]);
  const re = /(?:^|\s)--([a-z][a-z0-9-]*)(?=\s|$)/gi;
  let match: RegExpExecArray | null;
  let harness: string | undefined;
  while ((match = re.exec(text)) !== null) {
    const flag = match[1].toLowerCase();
    if (!skip.has(flag)) harness = flag;
  }
  return harness;
}

/** Extract text from a message, preferring the formatted AST (preserves links) over plain text. */
function richTextFromMessage(msg: { text: string; formatted?: Root }): string {
  if (msg.formatted) {
    return stringifyMarkdown(msg.formatted).trim();
  }
  return (msg.text || "").trim();
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface BotThread {
  id: string;
  subscribe(): Promise<void>;
  startTyping(status?: string): Promise<void>;
  post(content: AsyncGenerator<StreamChunk> | { markdown: string }, options?: { taskDisplayMode?: "timeline" | "plan" }): Promise<{ id: string; edit(content: { markdown: string }): Promise<void> }>;
}

export interface BotMessage {
  text: string;
  formatted?: Root;
  isMention?: boolean;
  author: { isMe: boolean; isBot: boolean; userId?: string };
  attachments?: BotAttachment[];
}

export interface BotAttachment {
  url?: string;
  name?: string;
  mimeType?: string;
  fetchData?: () => Promise<Buffer>;
}

export interface SlackAdapter {
  fetchMessage(threadId: string, ts: string): Promise<{ attachments?: BotAttachment[] } | null>;
  fetchMessages(threadId: string, options?: { direction?: "forward" | "backward"; limit?: number }): Promise<{ messages: Array<{ text: string; formatted?: Root; author: { isMe: boolean; isBot: boolean; userId: string }; attachments?: BotAttachment[] }> }>;
  setAssistantTitle(channel: string, threadTs: string, title: string): Promise<void>;
}

// ── Bot ───────────────────────────────────────────────────────────────────
//
// Mental model:
//   - First mention  → subscribe + buffer message + connect wire + execute
//   - Non-mention in subscribed thread → buffer message (context only)
//   - Mention in subscribed thread with wire open → inject stdin only
//   - Mention in subscribed thread without wire → connect + execute
//

export class SlackBot {
  /** Active wires keyed by threadKey — one persistent SSE connection per thread. */
  private wires = new Map<string, {
    iter: AsyncIterator<CanonicalEvent, void, undefined>;
    ready: boolean;
  }>();

  /** Abort controllers for in-flight streams — prevents duplicate responses when a new mention arrives mid-turn. */
  private streamAbort = new Map<string, AbortController>();

  constructor(
    readonly client: CentaurClient,
    private viewerUrl = "",
    private slack?: SlackAdapter,
  ) {}

  static createFromEnv(slack?: SlackAdapter): SlackBot {
    return new SlackBot(
      new CentaurClient({
        apiUrl: process.env.CENTAUR_API_URL || "http://api:8000",
        apiKey: process.env.SLACKBOT_API_KEY || process.env.API_SECRET_KEY || "",
        logger: log,
      }),
      process.env.THREAD_VIEWER_URL || "",
      slack,
    );
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  async onNewMention(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;
    await thread.subscribe();

    // Buffer prior thread messages as context before the mentioning message
    await this.backfillThreadHistory(thread.id);

    const richText = richTextFromMessage(msg);
    const attachments = await this.resolveAttachments(thread.id, msg);
    const parts = await this.toParts(richText, attachments);
    await this.bufferAndExecute(thread, richText, parts, msg.author.userId);
  }

  async onSubscribedMessage(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;

    const attachments = msg.isMention ? await this.resolveAttachments(thread.id, msg) : (msg.attachments || []);
    const text = richTextFromMessage(msg);
    if (!text && !attachments.length) return;

    const parts = await this.toParts(text || "Shared attachment in thread.", attachments);
    const threadKey = normalizeThreadKey(thread.id);

    // Always buffer
    try {
      await this.client.message({ threadKey, parts, userId: msg.author.userId });
    } catch (err) {
      log.warn("message_buffer_failed", { thread: thread.id, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Only execute on mention
    if (msg.isMention) {
      await this.execute(thread, threadKey, text, msg.author.userId);
    }
  }

  // ── Core ────────────────────────────────────────────────────────────────

  private async bufferAndExecute(thread: BotThread, text: string, parts: InputContentBlock[], userId?: string) {
    const threadKey = normalizeThreadKey(thread.id);
    await this.client.message({ threadKey, parts, userId });
    await this.execute(thread, threadKey, text, userId);
  }

  private async ensureWire(threadKey: string, harness?: string): Promise<AsyncIterator<CanonicalEvent, void, undefined>> {
    const existing = this.wires.get(threadKey);
    if (existing?.ready) return existing.iter;

    // Open a new persistent wire
    const wire = this.client.connect({ threadKey, harness, platform: "slack" });
    const iter = wire[Symbol.asyncIterator]();

    // Wait for wire.ready
    const readyResult = await iter.next();
    if (readyResult.done || (readyResult.value as any).type !== "wire.ready") {
      throw new Error("Wire did not emit wire.ready");
    }

    const entry = { iter, ready: true };
    this.wires.set(threadKey, entry);
    log.info("wire_opened", { thread_key: threadKey });
    return iter;
  }

  private async execute(thread: BotThread, threadKey: string, text: string, userId?: string) {
    // Abort any in-flight stream for this thread so we don't get duplicate responses
    const prev = this.streamAbort.get(threadKey);
    if (prev) {
      log.info("aborting_previous_stream", { thread_key: threadKey });
      prev.abort();
    }
    const ac = new AbortController();
    this.streamAbort.set(threadKey, ac);

    const tracker = new ProgressTracker();
    const t0 = Date.now();
    log.info("execute_start", { thread_key: threadKey, user_id: userId });

    try {
      await thread.post(this.stream(threadKey, text, tracker, userId, t0, ac.signal), { taskDisplayMode: "plan" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Slack killed the streaming state before we called stop() (long-running turn).
      // Fall back to posting a plain message with whatever result we accumulated,
      // or poll the API for the final result if we don't have one yet.
      if (errMsg.includes("message_not_in_streaming_state")) {
        log.warn("slack_stream_expired", { thread_key: threadKey, error: errMsg });
        let fallback = (tracker.resultText || tracker.lastAssistantText).trim();

        if (!fallback) {
          fallback = await this.pollForResult(normalizeThreadKey(threadKey));
        }

        if (fallback) {
          for (const chunk of splitSlackMessage(fallback)) {
            await thread.post({ markdown: chunk });
          }
        } else if (this.viewerUrl) {
          const viewerLink = `${this.viewerUrl}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
          await thread.post({ markdown: `Agent completed. [View full output](${viewerLink})` });
        }
        return;
      }

      log.error("execute_error", { thread_key: threadKey, error: errMsg });
      // Wire is probably dead — clean up so next mention reconnects
      this.wires.delete(threadKey);
      try {
        await thread.post({ markdown: `Agent request failed: ${errMsg}` });
      } catch (postErr) {
        log.error("error_post_failed", { thread_key: threadKey, error: postErr instanceof Error ? postErr.message : String(postErr) });
      }
      return;
    }

    // Clean up abort controller if we're still the active one
    if (this.streamAbort.get(threadKey) === ac) this.streamAbort.delete(threadKey);

    // Post any overflow chunks that didn't fit in the streaming message
    for (const chunk of tracker.overflowChunks) {
      try {
        await thread.post({ markdown: chunk });
      } catch (err) {
        log.warn("overflow_post_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const finalText = (tracker.resultText || tracker.lastAssistantText).trim();
    log.info("execute_complete", { thread_key: threadKey, duration_s: Math.round((Date.now() - t0) / 100) / 10, result_length: finalText.length, overflow_chunks: tracker.overflowChunks.length });

    if (this.slack) {
      try {
        const { channel, threadTs } = splitThreadKey(thread.id);
        await this.slack.setAssistantTitle(channel, threadTs, finalText.slice(0, 60));
      } catch (err) {
        log.warn("set_title_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async pollForResult(threadKey: string): Promise<string> {
    const deadline = Date.now() + STREAM_EXPIRED_POLL_MAX_MS;
    while (Date.now() < deadline) {
      try {
        const data = await this.client.getStatus(threadKey);
        const result = data.last_result;
        if (typeof result === "string" && result.trim()) {
          return result.trim();
        }
      } catch {
        // best-effort — keep polling
      }
      await new Promise((r) => setTimeout(r, STREAM_EXPIRED_POLL_INTERVAL_MS));
    }
    return "";
  }

  private async *stream(
    threadKey: string, text: string, tracker: ProgressTracker, userId: string | undefined, t0: number,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    // 1. Ensure we have a persistent wire (reuse existing or open new)
    const harness = parseHarnessFlag(text);
    let iter: AsyncIterator<CanonicalEvent, void, undefined>;
    try {
      iter = await this.ensureWire(threadKey, harness);
    } catch (err) {
      log.error("wire_connect_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
      yield { type: "markdown_text", text: "Failed to establish agent connection." };
      return;
    }

    // 2. Inject the message into stdin (fire-and-forget)
    this.client.execute({ threadKey, message: text, harness, platform: "slack", userId }).catch((err) => {
      log.error("stdin_inject_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
    });

    // 3. Stream events from the wire until turn.done (with auto-reconnect on break)
    yield* this.consumeWire(iter, threadKey, harness, tracker, signal);

    // If aborted, don't emit any final output — the new stream owns it
    if (signal.aborted) return;

    // Complete all in-progress steps and set plan title to "Completed"
    yield* tracker.finalize();

    // Emit the final response as markdown_text so Slack's streaming API includes it.
    // If the text exceeds Slack's 4k char limit, yield only the first chunk here
    // and stash overflow for the caller to post as separate messages.
    const finalText = (tracker.resultText || tracker.lastAssistantText).trim();
    if (finalText) {
      const dur = (Date.now() - t0) / 1000;
      const durStr = dur < 10 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`;
      const harness = tracker.agentThreadId
        ? `[agent](https://ampcode.com/threads/${tracker.agentThreadId})`
        : "agent";
      const prefix = `_${[process.env.APP_NAME || "Centaur", harness, durStr].join(" · ")}_\n\n`;
      const suffix = this.viewerUrl ? `\n\n[Thread Viewer](${this.viewerUrl}/${encodeURIComponent(threadKey)})` : "";
      const fullMd = `${prefix}${finalText}${suffix}`;
      const chunks = splitSlackMessage(fullMd);
      yield { type: "markdown_text", text: chunks[0] };
      tracker.overflowChunks = chunks.slice(1);
    } else {
      yield { type: "markdown_text", text: "Agent completed with no output." };
    }
  }

  /**
   * Consume events from a wire iterator until turn.done, with auto-reconnect
   * on wire breaks (e.g. API restarts). Retries up to RECONNECT_MAX_RETRIES
   * times with exponential backoff before giving up.
   */
  private async *consumeWire(
    iter: AsyncIterator<CanonicalEvent, void, undefined>,
    threadKey: string,
    harness: string | undefined,
    tracker: ProgressTracker,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    let currentIter = iter;
    let retriesLeft = RECONNECT_MAX_RETRIES;

    outer: while (true) {
      let pending: Promise<IteratorResult<CanonicalEvent, void>> | null = null;
      let wireBroke = false;

      try {
        while (true) {
          if (signal.aborted) {
            log.info("stream_aborted", { thread_key: threadKey });
            return;
          }

          if (!pending) pending = currentIter.next();

          const raced = await Promise.race([
            pending.then((r) => ({ kind: "value" as const, result: r })),
            new Promise<{ kind: "keepalive" }>((r) => setTimeout(() => r({ kind: "keepalive" }), KEEPALIVE_MS)),
            new Promise<{ kind: "aborted" }>((r) => {
              if (signal.aborted) { r({ kind: "aborted" }); return; }
              signal.addEventListener("abort", () => r({ kind: "aborted" }), { once: true });
            }),
          ]);

          if (raced.kind === "aborted") {
            log.info("stream_aborted", { thread_key: threadKey });
            return;
          }

          if (raced.kind === "keepalive") {
            yield { type: "plan_update", title: "Still working…" };
            continue;
          }

          pending = null;
          if (raced.result.done) {
            this.wires.delete(threadKey);
            break outer;
          }
          const event = raced.result.value;

          if ((event as any).type === "turn.done") {
            const result = ((event as any).result || "").trim();
            if (result) tracker.resultText = result;
            break outer;
          }

          yield* tracker.update(event);
        }
      } catch {
        wireBroke = true;
        this.wires.delete(threadKey);
      }

      if (!wireBroke) break;

      // Attempt reconnect
      if (retriesLeft <= 0 || signal.aborted) {
        log.warn("wire_reconnect_exhausted", { thread_key: threadKey });
        break;
      }

      const delay = RECONNECT_BASE_DELAY_MS * (RECONNECT_MAX_RETRIES - retriesLeft + 1);
      log.info("wire_reconnecting", { thread_key: threadKey, retries_left: retriesLeft, delay_ms: delay });
      yield { type: "plan_update", title: "Reconnecting…" };
      await new Promise((r) => setTimeout(r, delay));
      retriesLeft--;

      if (signal.aborted) return;

      try {
        const wire = this.client.reconnect({ threadKey, harness });
        currentIter = wire[Symbol.asyncIterator]();
        log.info("wire_reconnected", { thread_key: threadKey });
        // Don't store in this.wires — it's a reconnect stream, not a persistent wire
      } catch (err) {
        log.warn("wire_reconnect_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
        // Loop will retry or exhaust
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Fetch prior thread messages and buffer them to the API so the agent has full context. */
  private async backfillThreadHistory(threadId: string) {
    if (!this.slack) return;
    const threadKey = normalizeThreadKey(threadId);
    try {
      const { messages } = await this.slack.fetchMessages(threadId, { direction: "forward", limit: 50 });
      // Skip the last message (the mention itself — it gets buffered by the caller)
      const prior = messages.filter((m) => !m.author.isMe && !m.author.isBot);
      if (!prior.length) return;
      // Drop the last non-bot message since it's the mentioning message buffered by bufferAndExecute
      const history = prior.slice(0, -1);
      for (const m of history) {
        const text = richTextFromMessage(m);
        if (!text) continue;
        const parts = await this.toParts(text, m.attachments || []);
        await this.client.message({ threadKey, parts, userId: m.author.userId });
      }
      if (history.length) {
        log.info("thread_history_backfilled", { thread_key: threadKey, count: history.length });
      }
    } catch (err) {
      log.warn("thread_history_backfill_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async resolveAttachments(threadId: string, msg: BotMessage): Promise<BotAttachment[]> {
    if (msg.attachments?.length) return [...msg.attachments];
    const ts = (msg as { ts?: string }).ts || "";
    if (!ts || !this.slack) return [];
    try {
      const refetched = await this.slack.fetchMessage(threadId, ts);
      if (refetched?.attachments?.length) {
        log.info("mention_files_refetched", { thread: threadId, count: refetched.attachments.length });
        return [...refetched.attachments];
      }
    } catch (err) {
      log.warn("mention_files_refetch_failed", { thread: threadId, error: err instanceof Error ? err.message : String(err) });
    }
    return [];
  }

  async toParts(text: string, attachments: BotAttachment[]): Promise<InputContentBlock[]> {
    const parts: InputContentBlock[] = [{ type: "text", text }];
    for (const att of attachments) {
      if (!att.fetchData || !att.mimeType) continue;
      try {
        const data = await att.fetchData();
        const b64 = data.toString("base64");
        const source = { type: "base64" as const, media_type: att.mimeType, data: b64 };
        parts.push(att.mimeType.startsWith("image/") ? { type: "image", source } : { type: "document", source });
      } catch (err) {
        log.warn("attachment_fetch_failed", { name: att.name || "unknown", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return parts;
  }
}
