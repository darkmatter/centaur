import { App, verifySlackRequest, type Receiver, type ReceiverEvent } from "@slack/bolt";
import { normalizeThreadKey } from "@centaur/harness-events";
import { WebClient } from "@slack/web-api";
import { NextRequest, NextResponse } from "next/server";

import { log } from "@/lib/logger";
import { SlackBot, type BotAttachment, type BotMessage, type BotThread, type PostPayload, type SlackAdapter } from "@/lib/bot/bot";
import {
  markdownToPlainText,
  renderMarkdownForSlack,
  SLACK_BLOCKS_PER_MESSAGE,
  SLACK_PLAIN_TEXT_MESSAGE_CHARS,
  slackFormattedTextToAst,
  slackFormattedTextToMarkdown,
  splitMarkdownForSlackMessages,
  type Root,
} from "./markdown";
import { classifySlackError, SlackApiCallError } from "./errors";
import type { StreamChunk } from "./types";

/**
 * Slack streaming limits. We apply a safety margin so we never hit the server-
 * side msg_too_long rejection.
 */
const STREAM_TEXT_LIMIT = Math.floor(SLACK_PLAIN_TEXT_MESSAGE_CHARS * 0.9);
const STREAM_BLOCKS_LIMIT = SLACK_BLOCKS_PER_MESSAGE - 2; // leave room for metadata block

function streamChunkTextLength(chunk: string | StreamChunk): number {
  if (typeof chunk === "string") return chunk.length;
  if (chunk.type === "markdown_text") return chunk.text.length;
  if (chunk.type === "blocks") {
    return chunk.blocks.reduce((sum, b) => {
      return sum + (typeof b.text === "string" ? b.text.length : 0);
    }, 0);
  }
  return 0;
}

function streamChunkBlockCount(chunk: string | StreamChunk): number {
  if (typeof chunk === "string") return 0;
  if (chunk.type === "blocks") return chunk.blocks.length;
  return 0;
}

function textFromSlackValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromSlackValue).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct = typeof record.text === "string" ? record.text : "";
  const nested = [record.elements, record.rows, record.cells]
    .map(textFromSlackValue)
    .filter(Boolean)
    .join(" ");
  return [direct, nested].filter(Boolean).join(" ").trim();
}

function tableBlockToMarkdown(block: Record<string, unknown>): string {
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const cells = rows.map((row) => Array.isArray(row) ? row.map(textFromSlackValue) : []);
  if (cells.length === 0) return "";
  const widths = Array.from({ length: Math.max(...cells.map((row) => row.length)) }, (_, index) =>
    Math.max(3, ...cells.map((row) => (row[index] || "").length)),
  );
  const format = (row: string[]) => widths.map((width, index) => (row[index] || "").padEnd(width)).join(" | ").trimEnd();
  return [format(cells[0]), widths.map((width) => "-".repeat(width)).join("-|-"), ...cells.slice(1).map(format)].join("\n");
}

function slackBlockToOverflowMarkdown(block: Record<string, unknown>): string {
  if (block.type === "markdown" && typeof block.text === "string") return block.text;
  if (block.type === "table") return tableBlockToMarkdown(block);
  return textFromSlackValue(block);
}

function extractOverflowMarkdown(chunk: string | StreamChunk): string {
  if (typeof chunk === "string") return chunk;
  if (chunk.type === "markdown_text") return chunk.text;
  if (chunk.type === "blocks") {
    return chunk.blocks
      .map((block) => slackBlockToOverflowMarkdown(block as Record<string, unknown>))
      .filter((text) => text.trim())
      .join("\n\n");
  }
  // task_update and plan_update are streaming-only UI — skip in overflow
  return "";
}

function isSlackStreamOverflowError(error: unknown): boolean {
  const classified = classifySlackError(error);
  const code = classified.code?.toLowerCase() || "";
  const message = classified.message.toLowerCase();
  return code === "msg_too_long"
    || code === "msg_blocks_too_long"
    || message.includes("msg_too_long")
    || message.includes("msg_blocks_too_long");
}

function isSlackStreamAlreadyClosedError(error: unknown): boolean {
  const classified = classifySlackError(error);
  const code = classified.code?.toLowerCase() || "";
  const message = classified.message.toLowerCase();
  return code === "message_not_in_streaming_state"
    || message.includes("message_not_in_streaming_state")
    || code === "message_not_found"
    || message.includes("message_not_found");
}

const PENDING_SUBSCRIPTION_TTL_MS = 2 * 60_000;
// Must exceed the execution hard timeout (default 60 min) to prevent
// duplicate Slack events (app_mention + message) from being re-processed
// when the first event's handler runs longer than the dedup window.
const SEEN_EVENT_TTL_MS = 65 * 60_000;
const DISPATCH_RETRY_DELAYS_MS = [500, 1500];
const STREAM_BOOTSTRAP_TEXT = "\u200b";
const POLICY_TOUCHPOINT_CHANNEL_ID = "C0AM0TR8N91";
const POLICY_TOUCHPOINT_PATTERN = /(^|\s)#touchpoint\b/i;

type SlackMessageEvent = {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  team_id?: string;
  files?: SlackFile[];
};

type SlackFile = {
  mimetype?: string;
  url_private?: string;
  name?: string;
  size?: number;
  original_w?: number;
  original_h?: number;
};

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: Record<string, unknown>;
  ssl_check?: string | boolean;
};

type WaitUntilOptions = {
  waitUntil?: (task: Promise<unknown>) => void;
};

type ThreadContext = {
  recipientUserId?: string;
  recipientTeamId?: string;
};

type SlackHistoryMessage = {
  id?: string;
  text: string;
  formatted?: Root;
  raw?: { ts?: string; team_id?: string; team?: string };
  author: { isMe: boolean; isBot: boolean; userId: string };
  attachments?: BotAttachment[];
};

type StreamPayload = { chunks: StreamChunk[] };

function threadIdFromEvent(event: SlackMessageEvent): string | null {
  if (!event.channel) return null;
  const threadTs = event.thread_ts || event.ts;
  if (!threadTs) return null;
  return `slack:${event.channel}:${threadTs}`;
}

function splitSlackThreadId(threadId: string): { channel: string; threadTs: string } {
  const parts = threadId.split(":");
  if (parts[0] !== "slack" || !parts[1] || (parts.length !== 2 && parts.length !== 3)) {
    throw new Error(`Invalid Slack thread id: ${threadId}`);
  }
  return { channel: parts[1], threadTs: parts[2] || "" };
}

function isIgnoredMessageSubtype(subtype?: string): boolean {
  return new Set([
    "message_changed",
    "message_deleted",
    "message_replied",
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_archive",
    "channel_unarchive",
    "group_join",
    "group_leave",
    "group_topic",
    "group_purpose",
    "group_name",
    "group_archive",
    "group_unarchive",
    "ekm_access_denied",
    "tombstone",
  ]).has(subtype || "");
}

class NextSlackReceiver implements Receiver {
  private app: App | null = null;

  init(app: App): void {
    this.app = app;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async dispatch(event: ReceiverEvent): Promise<void> {
    if (!this.app) throw new Error("Slack receiver not initialized");
    await this.app.processEvent(event);
  }
}

class WebClientSlackAdapter implements SlackAdapter {
  private readonly userCache = new Map<string, { displayName: string; realName: string }>();

  private botUserId = "";

  constructor(
    private readonly client: WebClient,
    private readonly botToken: string,
  ) {}

  async init(): Promise<void> {
    const auth = await this.client.auth.test();
    this.botUserId = typeof auth.user_id === "string" ? auth.user_id : "";
  }

  getBotUserId(): string {
    return this.botUserId;
  }

  async fetchMessage(threadId: string, ts: string): Promise<{ attachments?: BotAttachment[] } | null> {
    const { channel, threadTs } = splitSlackThreadId(threadId);
    const response = await this.call<{ messages?: SlackMessageEvent[] }>("conversations.replies", {
      channel,
      ts: threadTs,
      oldest: ts,
      inclusive: true,
      limit: 1,
    });
    const target = response.messages?.find((message) => message.ts === ts);
    if (!target) return null;
    return { attachments: (target.files || []).map((file) => this.createAttachment(file)) };
  }

  async fetchMessages(
    threadId: string,
    options?: { direction?: "forward" | "backward"; limit?: number },
  ): Promise<{ messages: SlackHistoryMessage[] }> {
    const { channel, threadTs } = splitSlackThreadId(threadId);
    const allMessages: SlackMessageEvent[] = [];
    const cappedForwardLimit = options?.direction === "backward" ? undefined : options?.limit;
    let cursor = "";
    while (true) {
      const remaining = cappedForwardLimit === undefined
        ? undefined
        : cappedForwardLimit - allMessages.length;
      if (remaining !== undefined && remaining <= 0) break;

      const response = await this.call<{
        messages?: SlackMessageEvent[];
        response_metadata?: { next_cursor?: string };
      }>("conversations.replies", {
        channel,
        ts: threadTs,
        limit: Math.min(remaining ?? 200, 200),
        ...(cursor ? { cursor } : {}),
      });
      allMessages.push(...(response.messages || []));

      cursor = response.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }

    const messages = await Promise.all(
      allMessages.map((message) => this.toBotMessage(threadId, message, { skipSelfMention: false })),
    ) as SlackHistoryMessage[];

    return {
      messages: options?.direction === "backward" && options.limit
        ? messages.slice(-options.limit)
        : messages,
    };
  }

  async postMessage(threadId: string, message: PostPayload): Promise<{ id: string }> {
    const { channel, threadTs } = splitSlackThreadId(threadId);
    const rendered = renderMarkdownForSlack(message.markdown);
    let ts = "";
    if (message.markdown.trim() || !message.files?.length) {
      const response = await this.call<{ ts?: string }>("chat.postMessage", {
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: rendered.text || STREAM_BOOTSTRAP_TEXT,
        ...(rendered.blocks ? { blocks: rendered.blocks } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      ts = String(response.ts || "");
    }
    for (const file of message.files || []) {
      const baseArgs = {
        channel_id: channel,
        filename: file.filename,
        title: file.filename,
        file: Buffer.from(file.data),
      };
      await this.client.filesUploadV2(
        threadTs ? { ...baseArgs, thread_ts: threadTs } : baseArgs,
      );
    }
    return { id: ts || threadTs };
  }

  async updateMessage(threadId: string, messageId: string, message: { markdown: string }): Promise<void> {
    const { channel } = splitSlackThreadId(threadId);
    const rendered = renderMarkdownForSlack(message.markdown);
    await this.call("chat.update", {
      channel,
      ts: messageId,
      text: rendered.text || STREAM_BOOTSTRAP_TEXT,
      ...(rendered.blocks ? { blocks: rendered.blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async stream(
    threadId: string,
    stream: AsyncIterable<string | StreamChunk>,
    options?: { recipientUserId?: string; recipientTeamId?: string; taskDisplayMode?: "timeline" | "plan" },
  ): Promise<{ id: string }> {
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      return this.postMessage(threadId, { markdown: "" });
    }

    const { channel, threadTs } = splitSlackThreadId(threadId);
    const firstPayload = this.streamPayloadForChunk(first.value);
    const start = await this.call<{ ts?: string }>("chat.startStream", {
      channel,
      thread_ts: threadTs,
      ...(channel.startsWith("D")
        ? {}
        : {
            recipient_user_id: options?.recipientUserId,
            recipient_team_id: options?.recipientTeamId,
          }),
      ...(options?.taskDisplayMode ? { task_display_mode: options.taskDisplayMode } : {}),
      ...firstPayload,
    });
    const ts = String(start.ts || "");

    let accumulatedChars = streamChunkTextLength(first.value);
    let accumulatedBlocks = streamChunkBlockCount(first.value);

    while (true) {
      const next = await iterator.next();
      if (next.done) break;

      const chunkChars = streamChunkTextLength(next.value);
      const chunkBlocks = streamChunkBlockCount(next.value);

      if (accumulatedChars + chunkChars > STREAM_TEXT_LIMIT
        || accumulatedBlocks + chunkBlocks > STREAM_BLOCKS_LIMIT) {
        // Approaching Slack's limit — stop stream and post overflow as follow-ups.
        log.warn("slack_stream_overflow", {
          thread_id: threadId,
          reason: "proactive_limit",
          accumulated_chars: accumulatedChars,
          accumulated_blocks: accumulatedBlocks,
        });
        await this.stopStreamForOverflow(channel, ts, threadId);
        await this.postStreamOverflow(threadId, iterator, next.value);
        return { id: ts };
      }

      try {
        await this.call("chat.appendStream", {
          channel,
          ts,
          ...this.streamPayloadForChunk(next.value),
        });
      } catch (error) {
        if (!isSlackStreamOverflowError(error)) {
          throw error;
        }
        const classified = classifySlackError(error);
        log.warn("slack_stream_overflow", {
          thread_id: threadId,
          reason: "slack_rejected",
          error: classified.message,
          error_code: classified.code,
          error_class: classified.errorClass,
        });
        await this.stopStreamForOverflow(channel, ts, threadId);
        await this.postStreamOverflow(threadId, iterator, next.value);
        return { id: ts };
      }
      accumulatedChars += chunkChars;
      accumulatedBlocks += chunkBlocks;
    }

    await this.call("chat.stopStream", { channel, ts });
    return { id: ts };
  }

  private async stopStreamForOverflow(channel: string, ts: string, threadId: string): Promise<void> {
    try {
      await this.call("chat.stopStream", { channel, ts });
    } catch (error) {
      if (!isSlackStreamAlreadyClosedError(error)) {
        throw error;
      }
      const classified = classifySlackError(error);
      log.info("slack_stream_already_closed", {
        thread_id: threadId,
        error: classified.message,
        error_code: classified.code,
        error_class: classified.errorClass,
      });
    }
  }

  private async postStreamOverflow(
    threadId: string,
    iterator: AsyncIterator<string | StreamChunk>,
    firstOverflow: string | StreamChunk,
  ): Promise<void> {
    const parts: string[] = [extractOverflowMarkdown(firstOverflow)];
    while (true) {
      const remaining = await iterator.next();
      if (remaining.done) break;
      parts.push(extractOverflowMarkdown(remaining.value));
    }
    const combined = parts.filter((p) => p.trim()).join("\n\n");
    if (!combined.trim()) return;
    for (const md of splitMarkdownForSlackMessages(combined)) {
      await this.postMessage(threadId, { markdown: md });
    }
  }

  async setAssistantTitle(channel: string, threadTs: string, title: string): Promise<void> {
    await this.call("assistant.threads.setTitle", {
      channel_id: channel,
      thread_ts: threadTs,
      title,
    });
  }

  async startTyping(threadId: string, status?: string): Promise<void> {
    const { channel, threadTs } = splitSlackThreadId(threadId);
    await this.call("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: status || "Typing...",
      loading_messages: [status || "Typing..."],
    });
  }

  async stopTyping(threadId: string): Promise<void> {
    const { channel, threadTs } = splitSlackThreadId(threadId);
    await this.call("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: "",
      loading_messages: [],
    });
  }

  async getInstallation(): Promise<{ botToken: string } | null> {
    return { botToken: this.botToken };
  }

  async withBotToken<T>(_token: string, fn: () => Promise<T> | T): Promise<T> {
    return await fn();
  }

  async toBotMessage(
    _threadId: string,
    event: SlackMessageEvent,
    options?: { skipSelfMention?: boolean },
  ): Promise<BotMessage> {
    const slackText = await this.resolveInlineMentions(event.text || "", options?.skipSelfMention ?? true);
    return {
      id: event.ts,
      text: markdownToPlainText(slackFormattedTextToMarkdown(slackText)),
      formatted: slackFormattedTextToAst(slackText),
      raw: {
        ts: event.ts,
        team_id: event.team_id ?? event.team,
        team: event.team,
      },
      author: {
        isMe: event.user === this.botUserId || event.bot_id === this.botUserId,
        isBot: Boolean(event.bot_id),
        userId: event.user || "",
      },
      attachments: (event.files || []).map((file) => this.createAttachment(file)),
    };
  }

  private async resolveInlineMentions(text: string, skipSelfMention: boolean): Promise<string> {
    const ids = [...new Set(Array.from(text.matchAll(/<@([A-Z0-9_]+)>/g)).map((match) => match[1]))];
    if (ids.length === 0) return text;

    const replacements = new Map<string, string>();
    for (const id of ids) {
      if (skipSelfMention && id === this.botUserId) continue;
      const user = await this.lookupUser(id);
      if (user.displayName) replacements.set(id, `<@${id}|${user.displayName}>`);
    }

    if (replacements.size === 0) return text;
    return text.replace(/<@([A-Z0-9_]+)>/g, (full, id: string) => replacements.get(id) || full);
  }

  private async lookupUser(userId: string): Promise<{ displayName: string; realName: string }> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.client.users.info({ user: userId });
      if (result && result.ok === false) {
        throw new SlackApiCallError("users.info", typeof result.error === "string" ? result.error : "users.info_failed", result);
      }
      const user = result.user as { name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const resolved = {
        displayName: user?.profile?.display_name || user?.profile?.real_name || user?.name || userId,
        realName: user?.profile?.real_name || user?.name || userId,
      };
      this.userCache.set(userId, resolved);
      return resolved;
    } catch (error) {
      const classified = classifySlackError(error);
      log.warn("slack_user_lookup_failed", {
        user_id: userId,
        error: classified.message,
        error_class: classified.errorClass,
        error_code: classified.code,
        retryable: classified.retryable,
      });
      return { displayName: userId, realName: userId };
    }
  }

  private createAttachment(file: SlackFile): BotAttachment {
    const url = file.url_private;
    return {
      url,
      name: file.name,
      mimeType: file.mimetype,
      fetchData: url
        ? async () => {
            const response = await fetch(url, {
              headers: { Authorization: `Bearer ${this.botToken}` },
            });
            if (!response.ok) {
              throw new Error(`Failed to fetch Slack file: ${response.status} ${response.statusText}`);
            }
            return Buffer.from(await response.arrayBuffer());
          }
        : undefined,
    };
  }

  private streamPayloadForChunk(chunk: string | StreamChunk): StreamPayload {
    if (typeof chunk === "string") {
      return { chunks: [{ type: "markdown_text", text: chunk || STREAM_BOOTSTRAP_TEXT }] };
    }
    if (chunk.type === "markdown_text") {
      return { chunks: [{ type: "markdown_text", text: chunk.text || STREAM_BOOTSTRAP_TEXT }] };
    }
    return { chunks: [chunk] };
  }

  private async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const result = await this.client.apiCall(method, params);
    if (!result || result.ok !== true) {
      const error = typeof result?.error === "string" ? result.error : `Slack ${method} failed`;
      throw new SlackApiCallError(method, error, result);
    }
    return result as T;
  }
}

export class BoltSlackApp {
  private readonly receiver = new NextSlackReceiver();

  private readonly adapter: WebClientSlackAdapter;

  private readonly bolt: App;

  private readonly bot: SlackBot;

  private readonly queue = new Map<string, Promise<void>>();

  private readonly pendingSubscriptions = new Map<string, number>();

  private readonly seenEvents = new Map<string, number>();

  private readonly seenMessages = new Map<string, number>();

  private ready: Promise<void> | null = null;

  constructor(
    private readonly botToken: string,
    private readonly signingSecret: string,
  ) {
    const client = new WebClient(botToken);
    this.adapter = new WebClientSlackAdapter(client, botToken);
    this.bot = SlackBot.createFromEnv(this.adapter);
    this.bolt = new App({
      token: botToken,
      receiver: this.receiver,
      ignoreSelf: false,
    });
    this.registerListeners();
  }

  async init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.adapter.init()
        .then(() => {
          this.bot.startFinalDeliveryWorker();
        })
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    }
    await this.ready;
  }

  async handleRequest(request: NextRequest, options?: WaitUntilOptions): Promise<NextResponse> {
    const body = await request.text();
    const requestId = request.headers.get("x-slack-request-id") || "";
    const retryNum = request.headers.get("x-slack-retry-num") || "";
    const retryReason = request.headers.get("x-slack-retry-reason") || "";
    try {
      verifySlackRequest({
        signingSecret: this.signingSecret,
        body,
        headers: {
          "x-slack-signature": request.headers.get("x-slack-signature") || "",
          "x-slack-request-timestamp": Number(request.headers.get("x-slack-request-timestamp")),
        },
      });
    } catch {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(body) as SlackEventEnvelope;
    if (payload.type === "url_verification") {
      return NextResponse.json({ challenge: payload.challenge });
    }
    if (payload.ssl_check) {
      return new NextResponse(null, { status: 200 });
    }
    if (payload.type !== "event_callback" || !payload.event) {
      return NextResponse.json({ ok: true });
    }
    if (payload.event_id && this.seenRecently(payload.event_id)) {
      log.info("slack_duplicate_event_skipped", {
        event_id: payload.event_id,
        event_type: (payload.event as SlackMessageEvent).type,
        request_id: requestId,
        retry_num: retryNum,
        retry_reason: retryReason,
      });
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const task = this.dispatchWithRetry(payload, {
      requestId,
      retryNum,
      retryReason,
    });

    if (options?.waitUntil) options.waitUntil(task);
    else void task;

    return NextResponse.json({ ok: true });
  }

  getSlackAdapter(): SlackAdapter {
    return this.adapter;
  }

  private async dispatchWithRetry(
    payload: SlackEventEnvelope,
    request: { requestId: string; retryNum: string; retryReason: string },
  ): Promise<void> {
    const eventType = (payload.event as SlackMessageEvent).type;
    for (let attempt = 0; attempt <= DISPATCH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.receiver.dispatch({
          body: payload as Record<string, unknown>,
          ack: async () => {},
          retryNum: numberHeader(request.retryNum),
          retryReason: request.retryReason || undefined,
        });
        if (attempt > 0) {
          log.info("slack_bolt_dispatch_recovered", {
            event_id: payload.event_id,
            event_type: eventType,
            request_id: request.requestId,
            attempt: attempt + 1,
          });
        }
        return;
      } catch (error) {
        const classified = classifySlackError(error);
        const shouldRetry = classified.retryable && attempt < DISPATCH_RETRY_DELAYS_MS.length;
        const logFn = classified.retryable ? log.error : log.warn;
        logFn("slack_bolt_dispatch_failed", {
          event_id: payload.event_id,
          event_type: eventType,
          request_id: request.requestId,
          retry_num: request.retryNum,
          retry_reason: request.retryReason,
          error: classified.message,
          error_class: classified.errorClass,
          error_code: classified.code,
          status: classified.status,
          retryable: classified.retryable,
          attempt: attempt + 1,
          will_retry: shouldRetry,
        });
        if (!shouldRetry) return;
        await new Promise((resolve) => setTimeout(resolve, DISPATCH_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private registerListeners(): void {
    this.bolt.event("assistant_thread_started", async ({ event }: any) => {
      log.info("slack_assistant_event_received", { event_type: event.type });
    });
    this.bolt.event("assistant_thread_context_changed", async ({ event }: any) => {
      log.info("slack_assistant_event_received", { event_type: event.type });
    });
    this.bolt.event("app_mention", async ({ event, body }: any) => {
      await this.routeSlackEvent(event as SlackMessageEvent, body?.team_id);
    });
    this.bolt.event("message", async ({ event, body }: any) => {
      await this.routeSlackEvent(event as SlackMessageEvent, body?.team_id);
    });
  }

  private async routeSlackEvent(event: SlackMessageEvent, teamId?: string): Promise<void> {
    const threadId = threadIdFromEvent(event);
    if (!threadId) return;
    await this.enqueue(threadId, () => this.processMessageEvent(event, threadId, teamId));
  }

  private async processMessageEvent(
    event: SlackMessageEvent,
    threadId: string,
    teamId?: string,
  ): Promise<void> {
    if (event.type !== "message" && event.type !== "app_mention") return;
    if (isIgnoredMessageSubtype(event.subtype)) return;
    if (event.user === this.adapter.getBotUserId()) return;

    const isPolicyTouchpoint = Boolean(event.channel === POLICY_TOUCHPOINT_CHANNEL_ID && POLICY_TOUCHPOINT_PATTERN.test(event.text || ""));
    const isDirectMessage = event.channel_type === "im";
    const isMention = event.type === "app_mention"
      || isPolicyTouchpoint
      || isDirectMessage
      || this.messageMentionsBot(event.text || "");

    // Fire typing indicator immediately on mention so the user sees instant
    // feedback while we resolve subscriptions, attachments, and history.
    if (isMention) {
      this.adapter.startTyping(threadId).catch((err) => {
        log.warn("early_typing_indicator_failed", {
          thread_id: threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const isSubscribed = await this.isSubscribedThread(threadId);

    if (!isSubscribed && !isMention) return;
    if (this.seenMessageRecently(threadId, event)) return;

    const thread = this.createThread(threadId, {
      recipientUserId: event.user,
      recipientTeamId: event.team_id ?? event.team ?? teamId,
    });
    const message = await this.adapter.toBotMessage(threadId, {
      ...event,
      team_id: event.team_id ?? teamId,
    }, { skipSelfMention: event.type !== "app_mention" });
    message.isMention = isMention;

    if (isSubscribed) {
      await this.bot.onSubscribedMessage(thread, message);
      return;
    }

    await this.bot.onNewMention(thread, message);
  }

  private createThread(threadId: string, context: ThreadContext): BotThread {
    return {
      id: threadId,
      subscribe: async () => {
        this.pendingSubscriptions.set(threadId, Date.now() + PENDING_SUBSCRIPTION_TTL_MS);
      },
      startTyping: async (status?: string) => {
        try {
          await this.adapter.startTyping(threadId, status);
        } catch (error) {
          log.warn("slack_start_typing_failed", {
            thread_id: threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      stopTyping: async () => {
        try {
          await this.adapter.stopTyping(threadId);
        } catch (error) {
          log.warn("slack_stop_typing_failed", {
            thread_id: threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      post: async (
        content: AsyncGenerator<StreamChunk> | PostPayload,
        options?: { taskDisplayMode?: "timeline" | "plan" },
      ) => {
        if ("markdown" in content) {
          const posted = await this.adapter.postMessage(threadId, content);
          return {
            id: posted.id,
            edit: async (update: { markdown: string }) => {
              await this.adapter.updateMessage(threadId, posted.id, update);
            },
          };
        }

        const streamed = await this.adapter.stream(threadId, content, {
          recipientUserId: context.recipientUserId,
          recipientTeamId: context.recipientTeamId,
          taskDisplayMode: options?.taskDisplayMode,
        });
        return {
          id: streamed.id,
          edit: async (update: { markdown: string }) => {
            await this.adapter.updateMessage(threadId, streamed.id, update);
          },
        };
      },
    };
  }

  private messageMentionsBot(text: string): boolean {
    const botUserId = this.adapter.getBotUserId();
    return Boolean(botUserId && text.includes(`<@${botUserId}>`));
  }

  private async isSubscribedThread(threadId: string): Promise<boolean> {
    const pendingUntil = this.pendingSubscriptions.get(threadId);
    if (pendingUntil && pendingUntil > Date.now()) return true;
    if (pendingUntil) this.pendingSubscriptions.delete(threadId);

    try {
      const result = await this.bot.client.getMessages(normalizeThreadKey(threadId), { limit: 1 });
      const subscribed = result.messages.length > 0;
      if (subscribed) this.pendingSubscriptions.delete(threadId);
      return subscribed;
    } catch (error) {
      log.warn("slack_subscription_lookup_failed", {
        thread_id: threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private enqueue(threadId: string, taskFactory: () => Promise<void>): Promise<void> {
    const previous = this.queue.get(threadId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(taskFactory)
      .finally(() => {
        if (this.queue.get(threadId) === next) this.queue.delete(threadId);
      });
    this.queue.set(threadId, next);
    return next;
  }

  private seenRecently(eventId: string): boolean {
    const now = Date.now();
    for (const [seenId, expiresAt] of this.seenEvents) {
      if (expiresAt <= now) this.seenEvents.delete(seenId);
    }

    const expiresAt = this.seenEvents.get(eventId);
    if (expiresAt && expiresAt > now) return true;
    this.seenEvents.set(eventId, now + SEEN_EVENT_TTL_MS);
    return false;
  }

  private seenMessageRecently(threadId: string, event: SlackMessageEvent): boolean {
    if (!event.ts) return false;
    const key = `${threadId}:${event.ts}`;
    const now = Date.now();
    for (const [seenKey, expiresAt] of this.seenMessages) {
      if (expiresAt <= now) this.seenMessages.delete(seenKey);
    }

    const expiresAt = this.seenMessages.get(key);
    if (expiresAt && expiresAt > now) {
      log.info("slack_duplicate_message_skipped", { thread_id: threadId, message_ts: event.ts });
      return true;
    }
    this.seenMessages.set(key, now + SEEN_EVENT_TTL_MS);
    return false;
  }
}

function numberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const policyTouchpointPattern = POLICY_TOUCHPOINT_PATTERN;
export const policyTouchpointChannelId = POLICY_TOUCHPOINT_CHANNEL_ID;
