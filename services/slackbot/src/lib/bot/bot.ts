import { normalizeThreadKey, splitThreadKey } from "@centaur/harness-events";
import { CentaurClient } from "@centaur/api-client";
import type { InputContentBlock } from "@centaur/api-client";
import { AxiosError } from "axios";
import type { StreamChunk } from "chat";
import { log } from "@/lib/logger";
import { ProgressTracker } from "./progress-tracker";

// ── Types — mirrors Chat SDK shapes but doesn't import them ───────────────

export interface BotThread {
  id: string;
  subscribe(): Promise<void>;
  post(content: AsyncGenerator<StreamChunk> | { markdown: string }): Promise<{ edit(content: { markdown: string }): Promise<void> }>;
}

export interface BotMessage {
  text: string;
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
  setAssistantTitle(channel: string, threadTs: string, title: string): Promise<void>;
}

// ── Bot ───────────────────────────────────────────────────────────────────

export class SlackBot {
  constructor(
    readonly client: CentaurClient,
    private viewerUrl = "",
    private slack?: SlackAdapter,
  ) {}

  static createFromEnv(slack?: SlackAdapter): SlackBot {
    return new SlackBot(
      new CentaurClient({
        apiUrl: process.env.CENTAUR_API_URL || "http://api:8000",
        apiKey: process.env.SLACKBOT_API_KEY || "",
        logger: log,
      }),
      process.env.THREAD_VIEWER_URL || "",
      slack,
    );
  }

  // ── Handlers (wire these to Chat SDK externally) ────────────────────────

  async onNewMention(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;
    await thread.subscribe();
    const attachments = await this.loadAttachments(thread.id, msg);
    await this.executeTurn(thread, msg.text, attachments, msg.author.userId);
  }

  async onSubscribedMessage(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;

    if (msg.isMention) {
      await this.executeTurn(thread, msg.text, msg.attachments || [], msg.author.userId);
      return;
    }

    const text = (msg.text || "").trim();
    const files = (msg.attachments || [])
      .filter((a) => !!a.url && !!a.name)
      .map((a) => ({ url: a.url!, name: a.name!, mimeType: a.mimeType }));
    if (!text && files.length === 0) return;

    try {
      await this.client.postContext({
        threadKey: normalizeThreadKey(thread.id),
        text: text || "Shared attachment in thread.",
        userId: msg.author.userId,
        attachments: files.length > 0 ? files : undefined,
      });
    } catch (err) {
      log.warn("thread_context_post_failed", {
        thread: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Core ─────────────────────────────────────────────────────────────────

  async executeTurn(thread: BotThread, text: string, attachments: BotAttachment[], userId?: string) {
    const threadKey = normalizeThreadKey(thread.id);
    const input = await this.buildInput(text, attachments);
    const tracker = new ProgressTracker();
    const startTime = Date.now();

    log.info("execute_start", { thread_key: threadKey, user_id: userId });

    try {
      const sent = await thread.post(this.streamTurn(threadKey, input, tracker, userId));

      const harness = (tracker as any).harness || "agent";
      const finalText = (tracker.resultText || tracker.lastAssistantText).trim();
      log.info("execute_complete", {
        thread_key: threadKey,
        duration_s: Math.round((Date.now() - startTime) / 100) / 10,
        result_length: finalText.length,
      });

      if (finalText) {
        const dur = (Date.now() - startTime) / 1000;
        const durStr = dur < 10 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`;
        const hLabel = tracker.agentThreadId
          ? `[${harness}](https://ampcode.com/threads/${tracker.agentThreadId})`
          : harness;
        const meta = [process.env.APP_NAME || "Centaur", hLabel, durStr].filter(Boolean);
        let md = `_${meta.join(" · ")}_\n\n${finalText}`;
        if (this.viewerUrl) md += `\n\n[Thread Viewer](${this.viewerUrl}/${encodeURIComponent(threadKey)})`;
        try { await sent.edit({ markdown: md }); } catch {}
      }

      if (finalText && this.slack) {
        try {
          const { channel, threadTs } = splitThreadKey(thread.id);
          await this.slack.setAssistantTitle(channel, threadTs, finalText.slice(0, 60));
        } catch {}
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("message_not_in_streaming_state")) {
        log.warn("slack_stream_expired", { thread_key: threadKey });
        await this.recoverExpired(thread, threadKey);
        return;
      }
      log.error("execute_error", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
      await thread.post(async function* () {
        yield { type: "task_update" as const, id: "init", title: "Failed", status: "error" as const };
        yield { type: "markdown_text" as const, text: formatError(err, "Agent request failed") };
      }());
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async *streamTurn(
    threadKey: string, input: string | InputContentBlock[], tracker: ProgressTracker, userId?: string,
  ): AsyncGenerator<StreamChunk> {
    if (this.viewerUrl) {
      yield { type: "markdown_text", text: `[Thread Viewer](${this.viewerUrl}/${encodeURIComponent(threadKey)})` };
    }
    yield { type: "task_update", id: "init", title: "Starting…", status: "in_progress" };

    for await (const event of this.client.execute({ threadKey, message: input, platform: "slack", userId })) {
      if (tracker.update(event)) {
        for (const chunk of tracker.pendingChunks()) yield chunk;
      }
    }

    if (!tracker.initCompleted) {
      yield { type: "task_update", id: "init", title: "Started", status: "complete" };
    }
  }

  private async loadAttachments(threadId: string, msg: BotMessage): Promise<BotAttachment[]> {
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

  async buildInput(text: string, attachments: BotAttachment[]): Promise<string | InputContentBlock[]> {
    const blocks: InputContentBlock[] = [];
    for (const att of attachments) {
      if (!att.fetchData || !att.mimeType) continue;
      try {
        const data = await att.fetchData();
        const b64 = data.toString("base64");
        const source = { type: "base64" as const, media_type: att.mimeType, data: b64 };
        blocks.push(att.mimeType.startsWith("image/") ? { type: "image", source } : { type: "document", source });
      } catch (err) {
        log.warn("attachment_fetch_failed", { name: att.name || "unknown", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return blocks.length > 0 ? [{ type: "text", text }, ...blocks] : text;
  }

  private async recoverExpired(thread: BotThread, threadKey: string) {
    try {
      const status = await this.client.getStatus(threadKey);
      const result = typeof status.last_result === "string" ? status.last_result.trim() : "";
      if (result) {
        await thread.post({ markdown: result });
      } else if (this.viewerUrl) {
        await thread.post({ markdown: `Agent completed. [View full output](${this.viewerUrl}/${encodeURIComponent(threadKey)})` });
      }
    } catch {
      if (this.viewerUrl) {
        await thread.post({ markdown: `Agent completed. [View full output](${this.viewerUrl}/${encodeURIComponent(threadKey)})` });
      }
    }
  }
}

function formatError(err: unknown, context: string): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    if (!status) return `${context}: API is unreachable. Try again in ~30s.`;
    if (status >= 500) return `${context}: API returned ${status}. Try again shortly.`;
    return `${context}: ${err.message}`;
  }
  return `${context}: ${err instanceof Error ? err.message : "unknown error"}`;
}
