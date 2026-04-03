import { normalizeThreadKey, splitThreadKey } from "@centaur/harness-events";
import type { CanonicalEvent } from "@centaur/harness-events";
import { CentaurClient } from "@centaur/api-client";
import type { InputContentBlock } from "@centaur/api-client";

import { stringifyMarkdown, parseMarkdown, isTableNode, type StreamChunk } from "chat";
import type { Root, Content } from "chat";
import { log } from "@/lib/logger";
import { ProgressTracker } from "./progress-tracker";
import { convertDashboardBlocks } from "./dashboard-to-slack";

const KEEPALIVE_MS = 120_000; // 2 min — Slack expires streaming state after ~5 min
const STREAM_EXPIRED_POLL_INTERVAL_MS = 3_000;
const STREAM_EXPIRED_POLL_MAX_MS = 5 * 60_000;
const SLACK_MSG_MAX_CHARS = 3900; // Slack's hard limit is 4000; leave margin
const RECONNECT_MAX_RETRIES = 3;
const RECONNECT_BASE_DELAY_MS = 2_000;
const FINAL_DELIVERY_BATCH_SIZE = 5;
const FINAL_DELIVERY_IDLE_MS = 2_000;
const FINAL_DELIVERY_ERROR_MS = 5_000;
const FINAL_DELIVERY_LEASE_SECONDS = 90;
const EXECUTION_HARNESSES = new Set(["amp", "claude-code", "codex", "pi-mono"]);
const PROMPT_FLAG_ALIASES = new Map<string, string>([
  ["claude", "claude-code"],
  ["pi", "pi-mono"],
]);
const STREAM_BOOTSTRAP_TEXT = "\u200b";

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

/** Check if markdown text contains a pipe-delimited table. */
function containsMarkdownTable(md: string): boolean {
  const ast = parseMarkdown(md);
  return ast.children.some((node) => isTableNode(node as Content));
}

type SlackRawMessage = {
  team_id?: string;
  team?: string;
  ts?: string;
};

type DeliveryContext = {
  messageId?: string;
  userId?: string;
  teamId?: string;
};

type InFlightExecution = {
  executionId: string;
  abortController: AbortController;
};

type FinalDeliveryRecord = {
  execution_id?: string;
  thread_key?: string;
  attempt_count?: number;
  delivery?: Record<string, unknown>;
  final_payload?: Record<string, unknown> | null;
};

/** Extract harness/persona flag (e.g. --invest, --legal) from message text. */
function parsePromptSelectorFlag(text: string): string | undefined {
  // Match --flag patterns, skip known non-harness flags
  const skip = new Set(["engine", "model", "opus", "sonnet", "haiku"]);
  const re = /(?:^|\s)--([a-z][a-z0-9-]*)(?=\s|$)/gi;
  let match: RegExpExecArray | null;
  let selector: string | undefined;
  while ((match = re.exec(text)) !== null) {
    const flag = match[1].toLowerCase();
    if (!skip.has(flag)) selector = PROMPT_FLAG_ALIASES.get(flag) || flag;
  }
  return selector;
}

/** Extract text from a message, preferring the formatted AST (preserves links) over plain text. */
function richTextFromMessage(msg: { text: string; formatted?: Root }): string {
  if (msg.formatted) {
    return stringifyMarkdown(msg.formatted).trim();
  }
  return (msg.text || "").trim();
}

function stableSlackMessageId(msg: { id?: string; raw?: SlackRawMessage }): string | undefined {
  const stableId = msg.id || msg.raw?.ts;
  return stableId ? `slack:${stableId}` : undefined;
}

function slackTeamId(msg: { raw?: SlackRawMessage }): string | undefined {
  const teamId = msg.raw?.team_id ?? msg.raw?.team;
  return typeof teamId === "string" && teamId.trim() ? teamId : undefined;
}

function promptSelectorToSpawnOptions(promptSelector?: string): { harness?: string; personaId?: string } {
  if (!promptSelector) return {};
  return EXECUTION_HARNESSES.has(promptSelector)
    ? { harness: promptSelector }
    : { personaId: promptSelector };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function slackAdapterThreadId(threadKey: string): string {
  return threadKey.startsWith("slack:") ? threadKey : `slack:${threadKey}`;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface BotThread {
  id: string;
  subscribe(): Promise<void>;
  startTyping(status?: string): Promise<void>;
  post(content: AsyncGenerator<StreamChunk> | { markdown: string }, options?: { taskDisplayMode?: "timeline" | "plan" }): Promise<{ id: string; edit(content: { markdown: string }): Promise<void> }>;
}

export interface BotMessage {
  id?: string;
  text: string;
  formatted?: Root;
  isMention?: boolean;
  raw?: SlackRawMessage;
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
  fetchMessages(threadId: string, options?: { direction?: "forward" | "backward"; limit?: number }): Promise<{ messages: Array<{ id?: string; text: string; formatted?: Root; raw?: SlackRawMessage; author: { isMe: boolean; isBot: boolean; userId: string }; attachments?: BotAttachment[] }> }>;
  setAssistantTitle(channel: string, threadTs: string, title: string): Promise<void>;
  postMessage(threadId: string, message: { markdown: string }): Promise<{ id: string }>;
  getInstallation?(teamId: string): Promise<{ botToken: string } | null>;
  withBotToken?<T>(token: string, fn: () => Promise<T> | T): Promise<T>;
}

// ── Bot ───────────────────────────────────────────────────────────────────
//
// Mental model:
//   - First mention  → spawn assignment + buffer message + execute + stream durable events
//   - Non-mention in subscribed thread → buffer message (context only)
//   - Mention in subscribed thread → buffer + execute against current assignment_generation
//

export class SlackBot {
  /** Ephemeral UX coordination only — durable correctness lives in Postgres. */
  private inFlightExecutions = new Map<string, InFlightExecution>();

  private finalDeliveryLoop: Promise<void> | null = null;

  private readonly deliveryConsumerId = `slackbot:${process.env.HOSTNAME || "local"}`;

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

  startFinalDeliveryWorker() {
    if (!this.slack || this.finalDeliveryLoop) return;
    this.finalDeliveryLoop = this.runFinalDeliveryLoop();
  }

  private async runFinalDeliveryLoop(): Promise<void> {
    while (true) {
      try {
        const processed = await this.drainFinalDeliveriesOnce();
        await sleep(processed > 0 ? 0 : FINAL_DELIVERY_IDLE_MS);
      } catch (err) {
        log.error("final_delivery_loop_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(FINAL_DELIVERY_ERROR_MS);
      }
    }
  }

  private async drainFinalDeliveriesOnce(): Promise<number> {
    if (!this.slack) return 0;
    const { deliveries } = await this.client.claimFinalDeliveries({
      consumerId: this.deliveryConsumerId,
      limit: FINAL_DELIVERY_BATCH_SIZE,
      leaseSeconds: FINAL_DELIVERY_LEASE_SECONDS,
      platform: "slack",
    });
    for (const delivery of deliveries as FinalDeliveryRecord[]) {
      log.info("final_delivery_claimed", {
        thread_key: delivery.thread_key,
        execution_id: delivery.execution_id,
        attempt_count: delivery.attempt_count,
      });
      await this.processFinalDelivery(delivery);
    }
    return deliveries.length;
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  async onNewMention(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;
    const threadKey = normalizeThreadKey(thread.id);
    log.info("mention_received", { thread_key: threadKey, user_id: msg.author.userId, is_new_thread: true });
    await thread.subscribe();
    thread.startTyping().catch(() => {});

    const richText = richTextFromMessage(msg);
    const promptSelector = parsePromptSelectorFlag(richText);

    // Buffer prior thread messages as context before the mentioning message
    await this.backfillThreadHistory(thread.id, promptSelector);

    const attachments = await this.resolveAttachments(thread.id, msg);
    const parts = await this.toParts(richText, attachments);
    await this.bufferAndExecute(thread, richText, parts, {
      messageId: stableSlackMessageId(msg),
      userId: msg.author.userId,
      teamId: slackTeamId(msg),
    });
  }

  async onSubscribedMessage(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;

    const attachments = msg.isMention ? await this.resolveAttachments(thread.id, msg) : (msg.attachments || []);
    const text = richTextFromMessage(msg);
    if (!text && !attachments.length) return;

    const parts = await this.toParts(text || "Shared attachment in thread.", attachments);
    if (msg.isMention) {
      log.info("mention_received", { thread_key: normalizeThreadKey(thread.id), user_id: msg.author.userId, is_new_thread: false });
      thread.startTyping().catch(() => {});
      await this.bufferAndExecute(thread, text, parts, {
        messageId: stableSlackMessageId(msg),
        userId: msg.author.userId,
        teamId: slackTeamId(msg),
      });
      return;
    }

    const threadKey = normalizeThreadKey(thread.id);
    const state = await this.ensureAssignment(threadKey);

    try {
      await this.client.message({
        threadKey,
        assignmentGeneration: state.assignmentGeneration,
        messageId: stableSlackMessageId(msg),
        parts,
        userId: msg.author.userId,
      });
      log.info("message_buffered", {
        thread_key: threadKey,
        message_id: stableSlackMessageId(msg),
        assignment_generation: state.assignmentGeneration,
        is_mention: false,
      });
    } catch (err) {
      log.warn("message_buffer_failed", { thread_key: normalizeThreadKey(thread.id), error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Core ────────────────────────────────────────────────────────────────

  private async bufferAndExecute(thread: BotThread, text: string, parts: InputContentBlock[], delivery: DeliveryContext) {
    const threadKey = normalizeThreadKey(thread.id);
    await this.cancelInflightExecution(threadKey);
    const promptSelector = parsePromptSelectorFlag(text);
    const state = await this.ensureAssignment(threadKey, promptSelector);
    await this.client.message({
      threadKey,
      assignmentGeneration: state.assignmentGeneration,
      messageId: delivery.messageId,
      parts,
      userId: delivery.userId,
    });
    log.info("message_buffered", {
      thread_key: threadKey,
      message_id: delivery.messageId,
      assignment_generation: state.assignmentGeneration,
      is_mention: true,
    });
    await this.execute(thread, threadKey, {
      assignmentGeneration: state.assignmentGeneration,
      userId: delivery.userId,
      teamId: delivery.teamId,
    });
  }

  private async execute(thread: BotThread, threadKey: string, opts: { assignmentGeneration: number; userId?: string; teamId?: string }) {
    const ac = new AbortController();

    const tracker = new ProgressTracker();
    const t0 = Date.now();
    let executionId = "";
    try {
      const { channel, threadTs } = splitThreadKey(thread.id);
      const executeId = `exec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const accepted = await this.client.execute({
        threadKey,
        assignmentGeneration: opts.assignmentGeneration,
        executeId,
        platform: "slack",
        userId: opts.userId,
        delivery: {
          channel,
          thread_ts: threadTs,
          platform: "slack",
          recipient_user_id: opts.userId,
          recipient_team_id: opts.teamId,
        },
      });
      executionId = accepted.execution_id;
      this.inFlightExecutions.set(threadKey, {
        executionId,
        abortController: ac,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute_enqueue_failed", { thread_key: threadKey, error: errMsg });
      try {
        await thread.post({ markdown: `Agent request failed before execution started: ${errMsg}` });
      } catch {
        // best-effort
      }
      return;
    }

    log.info("execute_start", { thread_key: threadKey, user_id: opts.userId, execution_id: executionId });

    let sentMessage: Awaited<ReturnType<typeof thread.post>> | undefined;
    let deliveredToSlack = false;
    try {
      try {
        const stream = this.streamExecution(threadKey, executionId, tracker, t0, ac.signal);
        const iter = stream[Symbol.asyncIterator]();
        let firstChunk: StreamChunk | undefined;

        while (!ac.signal.aborted) {
          const next = await iter.next();
          if (next.done) break;
          firstChunk = next.value;
          break;
        }

        if (firstChunk) {
          sentMessage = await thread.post(
            (async function* () {
              if (firstChunk.type !== "markdown_text") {
                // Slack's structured streaming chunks can be rejected if they arrive
                // before any markdown delta has established the stream state.
                yield { type: "markdown_text", text: STREAM_BOOTSTRAP_TEXT };
              }
              yield firstChunk;
              while (true) {
                const next = await iter.next();
                if (next.done) return;
                yield next.value;
              }
            })(),
            { taskDisplayMode: "plan" },
          );
          deliveredToSlack = true;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Slack killed the streaming state before we called stop() (long-running turn),
        // or the accumulated streamed text exceeded Slack's message length limit.
        // Fall back to posting a plain message with whatever result we accumulated,
        // or poll the API for the final result if we don't have one yet.
        if (errMsg.includes("message_not_in_streaming_state") || errMsg.includes("msg_too_long")) {
          log.warn("slack_stream_fallback", { thread_key: threadKey, error: errMsg, execution_id: executionId });
          let fallback = convertDashboardBlocks((tracker.resultText || tracker.lastAssistantText).trim());

          if (!fallback) {
            fallback = convertDashboardBlocks(await this.pollForResult(executionId));
          }

          if (fallback) {
            for (const chunk of splitSlackMessage(fallback)) {
              await thread.post({ markdown: chunk });
            }
            deliveredToSlack = true;
          } else if (this.viewerUrl) {
            const viewerLink = `${this.viewerUrl}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
            await thread.post({ markdown: `Agent completed. [View full output](${viewerLink})` });
            deliveredToSlack = true;
          }
          if (deliveredToSlack) {
            await this.ackFinalDelivery(executionId, threadKey, { requireLease: false });
          }
          return;
        }

        log.error("execute_error", { thread_key: threadKey, error: errMsg, execution_id: executionId });
        try {
          await thread.post({ markdown: `Agent request failed: ${errMsg}` });
        } catch (postErr) {
          log.error("error_post_failed", { thread_key: threadKey, error: postErr instanceof Error ? postErr.message : String(postErr) });
        }
        return;
      }

      // If the response contains markdown tables, edit the streamed message to
      // use native Slack table blocks (the streaming path renders tables as plain
      // code blocks; editMessage triggers the Chat SDK's renderWithTableBlocks).
      if (sentMessage && tracker.streamedMarkdown && containsMarkdownTable(tracker.streamedMarkdown)) {
        try {
          await sentMessage.edit({ markdown: tracker.streamedMarkdown });
          log.info("table_reformat", { thread_key: threadKey });
        } catch (err) {
          log.warn("table_reformat_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
        }
      }

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

      if (deliveredToSlack) {
        await this.ackFinalDelivery(executionId, threadKey, { requireLease: false });
      }

      await this.setAssistantTitle(threadKey, finalText);
    } finally {
      const durationMs = Date.now() - t0;
      log.info("execute_completed", {
        thread_key: threadKey,
        execution_id: executionId,
        duration_ms: durationMs,
        delivered_to_slack: deliveredToSlack,
      });
      const current = this.inFlightExecutions.get(threadKey);
      if (current?.executionId === executionId) {
        this.inFlightExecutions.delete(threadKey);
      }
    }
  }

  private async pollForResult(executionId: string): Promise<string> {
    const deadline = Date.now() + STREAM_EXPIRED_POLL_MAX_MS;
    while (Date.now() < deadline) {
      try {
        const data = await this.client.getExecution(executionId);
        const status = String(data.status || "");
        const result = data.result_text;
        if (typeof result === "string" && result.trim()) return result.trim();
        if (status === "failed_permanent" || status === "cancelled") {
          const err = typeof data.error_text === "string" ? data.error_text : "Execution failed";
          return err;
        }
      } catch {
        // best-effort — keep polling
      }
      await new Promise((r) => setTimeout(r, STREAM_EXPIRED_POLL_INTERVAL_MS));
    }
    return "";
  }

  private async hydrateStoredTerminalResult(
    executionId: string,
    tracker: ProgressTracker,
  ): Promise<boolean> {
    try {
      const data = await this.client.getExecution(executionId);
      const status = String(data.status || "");
      if (!["completed", "failed_permanent", "cancelled"].includes(status)) {
        return false;
      }

      const result = typeof data.result_text === "string" ? data.result_text.trim() : "";
      const error = typeof data.error_text === "string" ? data.error_text.trim() : "";
      const terminalReason = typeof data.terminal_reason === "string"
        ? data.terminal_reason.trim()
        : "";
      tracker.resultText = result || error || terminalReason;
      return true;
    } catch {
      return false;
    }
  }

  private async *streamExecution(
    threadKey: string,
    executionId: string,
    tracker: ProgressTracker,
    t0: number,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    yield* this.consumeExecutionEvents(threadKey, executionId, tracker, signal);

    // If aborted, don't emit any final output — the new stream owns it
    if (signal.aborted) return;

    // Complete all in-progress steps and set plan title to "Completed"
    yield* tracker.finalize();

    // Emit the final response as markdown_text so Slack's streaming API includes it.
    // If the text exceeds Slack's 4k char limit, yield only the first chunk here
    // and stash overflow for the caller to post as separate messages.
    // Convert ```dashboard blocks to markdown tables so they render as Slack Block Kit.
    const finalText = convertDashboardBlocks((tracker.resultText || tracker.lastAssistantText).trim());
    if (finalText) {
      const dur = (Date.now() - t0) / 1000;
      const durStr = dur < 10 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`;
      const harness = tracker.agentThreadId
        ? `[agent](https://ampcode.com/threads/${tracker.agentThreadId})`
        : "agent";
      const prefix = `_${[process.env.APP_NAME || "Centaur", harness, durStr].join(" · ")}_\n\n`;
      const suffix = this.viewerUrl ? `\n\n[Thread Viewer](${this.viewerUrl}/${encodeURIComponent(threadKey)})` : "";
      const fullMd = `${prefix}${finalText}${suffix}`;
      tracker.streamedMarkdown = fullMd;
      const chunks = splitSlackMessage(fullMd);
      yield { type: "markdown_text", text: chunks[0] };
      tracker.overflowChunks = chunks.slice(1);
    } else {
      yield { type: "markdown_text", text: "Agent completed with no output." };
    }
  }

  /**
   * Consume durable execution events until terminal state, reconnecting from
   * the last durable cursor on transient stream failures.
   */
  private async *consumeExecutionEvents(
    threadKey: string,
    executionId: string,
    tracker: ProgressTracker,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    let retriesLeft = RECONNECT_MAX_RETRIES;
    let afterEventId = 0;
    log.info("stream_started", { thread_key: threadKey, execution_id: executionId });

    while (true) {
      const stream = this.client.streamEvents({
        threadKey,
        executionId,
        afterEventId,
        signal,
      });
      const iter = stream[Symbol.asyncIterator]();
      let pending: Promise<IteratorResult<{ eventId: number; eventKind: string; data: Record<string, unknown> }, void>> | null = null;
      let streamBroke = false;
      let terminal = false;

      try {
        while (true) {
          if (signal.aborted) {
            log.info("stream_aborted", { thread_key: threadKey });
            return;
          }

          if (!pending) pending = iter.next();

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
            // Invisible markdown keepalive prevents Slack from expiring the stream
            // on long-running turns even when there is no user-visible text yet.
            yield { type: "markdown_text", text: STREAM_BOOTSTRAP_TEXT };
            yield { type: "plan_update", title: "Still working…" };
            continue;
          }

          pending = null;
          if (raced.result.done) {
            streamBroke = true;
            break;
          }
          const streamEvent = raced.result.value;
          afterEventId = Math.max(afterEventId, streamEvent.eventId || 0);
          const payload = streamEvent.data;
          const eventType = typeof payload.type === "string" ? payload.type : "";

          if (eventType === "turn.done") {
            const result = String(payload.result || "").trim();
            if (result) tracker.resultText = result;
            terminal = true;
            break;
          }

          if (eventType === "execution.state") {
            const status = String(payload.status || "");
            if (status === "completed") {
              const result = String(payload.result_text || "").trim();
              if (result) tracker.resultText = result;
              terminal = true;
              break;
            }
            if (status === "failed_permanent" || status === "cancelled") {
              const err = String(payload.error_text || payload.terminal_reason || "Execution failed").trim();
              if (err && !tracker.resultText) tracker.resultText = err;
              terminal = true;
              break;
            }
            continue;
          }

          if (eventType.startsWith("final_delivery.")) continue;

          yield* tracker.update(payload as unknown as CanonicalEvent);
        }
      } catch {
        streamBroke = true;
      }

      if (terminal) {
        log.info("stream_completed", { thread_key: threadKey, execution_id: executionId, last_event_id: afterEventId });
        return;
      }
      if (await this.hydrateStoredTerminalResult(executionId, tracker)) {
        log.info("stream_completed", { thread_key: threadKey, execution_id: executionId, last_event_id: afterEventId });
        return;
      }
      if (!streamBroke) {
        log.info("stream_completed", { thread_key: threadKey, execution_id: executionId, last_event_id: afterEventId });
        return;
      }

      if (retriesLeft <= 0 || signal.aborted) {
        log.warn("wire_reconnect_exhausted", { thread_key: threadKey, execution_id: executionId });
        log.info("stream_completed", { thread_key: threadKey, execution_id: executionId, last_event_id: afterEventId });
        return;
      }

      const delay = RECONNECT_BASE_DELAY_MS * (RECONNECT_MAX_RETRIES - retriesLeft + 1);
      log.info("wire_reconnecting", { thread_key: threadKey, retries_left: retriesLeft, delay_ms: delay });
      yield { type: "plan_update", title: "Reconnecting…" };
      await new Promise((r) => setTimeout(r, delay));
      retriesLeft--;

      if (signal.aborted) return;
    }
  }

  private async ackFinalDelivery(
    executionId: string,
    threadKey: string,
    opts?: { requireLease?: boolean },
  ): Promise<void> {
    try {
      await this.client.markFinalDelivered(
        executionId,
        opts?.requireLease === false ? undefined : this.deliveryConsumerId,
      );
    } catch (err) {
      log.warn("final_delivery_ack_failed", {
        thread_key: threadKey,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async failFinalDelivery(executionId: string, threadKey: string, error: string): Promise<void> {
    try {
      await this.client.markFinalFailed(executionId, error, {
        consumerId: this.deliveryConsumerId,
      });
    } catch (err) {
      log.warn("final_delivery_fail_mark_failed", {
        thread_key: threadKey,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async cancelInflightExecution(threadKey: string): Promise<void> {
    const current = this.inFlightExecutions.get(threadKey);
    if (!current) return;

    this.inFlightExecutions.delete(threadKey);
    current.abortController.abort();
    log.info("cancelling_previous_execution", {
      thread_key: threadKey,
      execution_id: current.executionId,
    });

    try {
      await this.client.cancelExecution(current.executionId);
    } catch (err) {
      log.warn("cancel_previous_execution_failed", {
        thread_key: threadKey,
        execution_id: current.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ensureAssignment(
    threadKey: string,
    promptSelector?: string,
  ): Promise<{ assignmentGeneration: number }> {
    const spawn = await this.client.spawn({
      threadKey,
      spawnId: `spawn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ...promptSelectorToSpawnOptions(promptSelector),
    });
    log.info("assignment_ready", {
      thread_key: threadKey,
      assignment_generation: Number(spawn.assignment_generation || 0),
      runtime_id: spawn.runtime_id,
      prompt_ref: spawn.prompt_ref,
      prompt_sha: spawn.effective_agents_md_sha256,
      prompt_selector: promptSelector,
    });
    return {
      assignmentGeneration: Number(spawn.assignment_generation || 0),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async processFinalDelivery(record: FinalDeliveryRecord): Promise<void> {
    if (!this.slack) return;

    const executionId = typeof record.execution_id === "string" ? record.execution_id : "";
    const threadKey = typeof record.thread_key === "string" ? record.thread_key : "";
    const delivery = asRecord(record.delivery);
    const finalPayload = asRecord(record.final_payload);

    if (!executionId || !threadKey) return;
    log.info("final_delivery_started", { thread_key: threadKey, execution_id: executionId });

    if (this.isExecutionStreaming(executionId)) {
      log.info("final_delivery_deferred_live_stream", {
        execution_id: executionId,
        thread_key: threadKey,
      });
      // Keep the claimed lease intact so the live stream can ack the same
      // outbox row on completion instead of racing a retry into a duplicate post.
      return;
    }

    if (this.shouldSuppressFinalDelivery(finalPayload)) {
      log.info("final_delivery_suppressed", {
        execution_id: executionId,
        thread_key: threadKey,
        status: finalPayload.status,
        terminal_reason: finalPayload.terminal_reason,
      });
      await this.ackFinalDelivery(executionId, threadKey);
      return;
    }

    const markdown = this.renderFinalDeliveryMarkdown(threadKey, finalPayload);
    try {
      await this.withSlackDeliveryContext(delivery, async () => {
        for (const chunk of splitSlackMessage(markdown)) {
          await this.slack!.postMessage(slackAdapterThreadId(threadKey), { markdown: chunk });
        }
      });
      await this.ackFinalDelivery(executionId, threadKey);
      await this.setAssistantTitle(threadKey, markdown);
      log.info("final_delivery_completed", { thread_key: threadKey, execution_id: executionId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("final_delivery_post_failed", {
        execution_id: executionId,
        thread_key: threadKey,
        error,
      });
      await this.failFinalDelivery(executionId, threadKey, error);
    }
  }

  private isExecutionStreaming(executionId: string): boolean {
    for (const current of this.inFlightExecutions.values()) {
      if (current.executionId === executionId && !current.abortController.signal.aborted) {
        return true;
      }
    }
    return false;
  }

  private shouldSuppressFinalDelivery(finalPayload: Record<string, unknown>): boolean {
    const status = typeof finalPayload.status === "string" ? finalPayload.status : "";
    const terminalReason = typeof finalPayload.terminal_reason === "string"
      ? finalPayload.terminal_reason
      : "";
    return status === "cancelled" || terminalReason === "cancel_requested" || terminalReason === "cancelled";
  }

  private renderFinalDeliveryMarkdown(threadKey: string, finalPayload: Record<string, unknown>): string {
    const resultText = typeof finalPayload.result_text === "string" ? finalPayload.result_text.trim() : "";
    const errorText = typeof finalPayload.error_text === "string" ? finalPayload.error_text.trim() : "";
    const rendered = convertDashboardBlocks((resultText || errorText).trim());
    const viewerSuffix = this.viewerUrl
      ? `\n\n[Thread Viewer](${this.viewerUrl}/${encodeURIComponent(threadKey)})`
      : "";

    if (rendered) {
      return `${rendered}${viewerSuffix}`;
    }

    if (this.viewerUrl) {
      return `Agent completed. [View full output](${this.viewerUrl}/${encodeURIComponent(threadKey)})`;
    }

    return errorText || "Agent completed with no output.";
  }

  private async withSlackDeliveryContext<T>(
    delivery: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.slack?.withBotToken || !this.slack.getInstallation) {
      return fn();
    }

    const teamId = typeof delivery.recipient_team_id === "string"
      ? delivery.recipient_team_id.trim()
      : "";
    if (!teamId) return fn();

    const installation = await this.slack.getInstallation(teamId);
    if (!installation?.botToken) {
      log.warn("final_delivery_missing_installation", { team_id: teamId });
      return fn();
    }

    return this.slack.withBotToken(installation.botToken, fn);
  }

  private async setAssistantTitle(threadKey: string, title: string): Promise<void> {
    if (!this.slack || !title.trim()) return;

    try {
      const { channel, threadTs } = splitThreadKey(threadKey);
      await this.slack.setAssistantTitle(channel, threadTs, title.slice(0, 60));
    } catch (err) {
      log.warn("set_title_failed", {
        thread_key: threadKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Fetch prior thread messages and buffer them to the API so the agent has full context. */
  private async backfillThreadHistory(threadId: string, promptSelector?: string) {
    if (!this.slack) return;
    const threadKey = normalizeThreadKey(threadId);
    const state = await this.ensureAssignment(threadKey, promptSelector);
    try {
      const { messages } = await this.slack.fetchMessages(threadId, { direction: "forward", limit: 50 });
      // Skip the last message (the mention itself — it gets buffered by the caller)
      const prior = messages.filter((m) => !m.author.isMe && !m.author.isBot);
      if (!prior.length) return;
      // Drop the last non-bot message since it's the mentioning message buffered by bufferAndExecute
      const history = prior.slice(0, -1);
      for (const m of history) {
        const text = richTextFromMessage(m);
        const attachments = m.attachments || [];
        if (!text && !attachments.length) continue;
        const parts = await this.toParts(text || "Shared attachment in thread.", attachments);
        await this.client.message({
          threadKey,
          assignmentGeneration: state.assignmentGeneration,
          messageId: stableSlackMessageId(m),
          parts,
          userId: m.author.userId,
        });
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
    const ts = msg.id || msg.raw?.ts || "";
    if (!ts || !this.slack) return [];
    try {
      const refetched = await this.slack.fetchMessage(threadId, ts);
      if (refetched?.attachments?.length) {
        log.info("mention_files_refetched", { thread_key: normalizeThreadKey(threadId), count: refetched.attachments.length });
        return [...refetched.attachments];
      }
    } catch (err) {
      log.warn("mention_files_refetch_failed", { thread_key: normalizeThreadKey(threadId), error: err instanceof Error ? err.message : String(err) });
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
