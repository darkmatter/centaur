import crypto from "node:crypto";
import { Chat, parseMarkdown, type Root } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  execute,
  extractRunOptions,
  interrupt,
  normalizeThreadKey,
  postThreadContextMessage,
  spawn,
  splitThreadKey,
  watchProgress,
  type BudgetMode,
  type Engine,
  type FileAttachment,
  type Harness,
} from "./harness";
import { ApiError } from "./api-client";
import { truncateSlackText } from "./slack-text";

function formatErrorForSlack(error: unknown, context: string): string {
  if (error instanceof ApiError) {
    if (error.retryable && error.status === null) {
      return `${context}: API is unreachable (retried ${RETRY_DEFAULTS_MAX} times). The service may be restarting — try again in ~30s.`;
    }
    if (error.status && error.status >= 500) {
      return `${context}: API returned ${error.status}. The service may be overloaded — try again shortly.`;
    }
    return `${context}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }
  return `${context}: unknown error`;
}

const RETRY_DEFAULTS_MAX = 4;

const THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "https://svc-ai.paradigm.xyz";
const MAX_TRACKED_THREAD_MODES = 500;
const SLACK_BOT_USERNAME = process.env.SLACK_BOT_USERNAME || "paradigm-ai";

type MarkdownNode = Root | Root["children"][number];
type ThreadConfig = {
  harness: Harness;
  engine: Engine | null;
  model: string | null;
  budgetMode: BudgetMode | null;
};

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SlackReply = {
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
};

async function fetchThreadHistory(
  channel: string,
  threadTs: string,
  botUserId?: string,
): Promise<string> {
  if (!SLACK_BOT_TOKEN) return "";
  try {
    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: "50",
      inclusive: "true",
    });
    const res = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
    );
    const data = (await res.json()) as {
      ok: boolean;
      messages?: SlackReply[];
    };
    if (!data.ok || !data.messages || data.messages.length <= 1) return "";

    const prior = data.messages.slice(0, -1).filter((m) => {
      if (m.bot_id) return false;
      if (botUserId && m.user === botUserId) return false;
      return true;
    });
    if (prior.length === 0) return "";

    const lines = prior.map((m) => {
      const user = m.user ? `<@${m.user}>` : "Unknown";
      return `${user}: ${m.text || "(no text)"}`;
    });

    return [
      "## Prior Thread Messages",
      "",
      "The following messages were posted in this Slack thread before you were mentioned. Use them as context:",
      "",
      ...lines,
      "",
      "---",
      "",
    ].join("\n");
  } catch (error) {
    console.warn("fetch_thread_history_failed", {
      channel,
      threadTs,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

function messageIdentifier(message: {
  ts?: string;
  userId?: string;
  text?: string;
  threadId?: string;
}): string {
  const ts = String(message.ts || "").trim();
  if (ts) return ts;
  const raw = `${message.threadId || ""}:${message.userId || ""}:${message.text || ""}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function isBusyRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("already in progress") || normalized.includes("run is already in progress");
}

function preprocessSlackLinks(text: string): string {
  let result = text;
  result = result.replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+)&gt;/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  return result;
}

function preprocessMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|.*\|\s*$/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      const parseRow = (row: string): string[] =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());

      const dataRows = tableLines.filter(
        (l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)
      );
      if (dataRows.length === 0) {
        result.push(...tableLines);
        continue;
      }

      const headers = parseRow(dataRows[0]);
      const bodyRows = dataRows.slice(1);

      if (bodyRows.length === 0) {
        result.push(headers.map((h) => `*${h}*`).join("  ·  "));
        result.push("");
      } else {
        for (const row of bodyRows) {
          const cells = parseRow(row);
          const label = cells[0] || "";
          result.push(`*${label}*`);
          for (let c = 1; c < cells.length; c++) {
            const headerLabel = headers[c] || `Col ${c}`;
            result.push(`• *${headerLabel}:* ${cells[c] || "—"}`);
          }
          result.push("");
        }
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function renderSlackMessage(markdown: string) {
  const ast = parseMarkdown(preprocessMarkdownTables(preprocessSlackLinks(markdown)));
  const escapeLiteralTildes = (
    node: MarkdownNode,
    inDelete = false
  ): void => {
    const insideDelete = inDelete || node.type === "delete";

    if (node.type === "text" && !insideDelete) {
      node.value = node.value.replace(/~/g, "\\~");
    }

    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Root["children"]) {
        escapeLiteralTildes(child, insideDelete);
      }
    }
  };

  escapeLiteralTildes(ast);

  return { ast };
}

function toSlackMessage(markdown: string) {
  return renderSlackMessage(truncateSlackText(markdown));
}

function createBot() {
  const hasSlackCreds =
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET;

  const bot = new Chat({
    userName: SLACK_BOT_USERNAME,
    adapters: hasSlackCreds ? { slack: createSlackAdapter() } : {},
    state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
  });
  const threadConfigs = new Map<string, ThreadConfig>();

  function setThreadConfig(threadKey: string, config: ThreadConfig): void {
    if (threadConfigs.has(threadKey)) {
      threadConfigs.delete(threadKey);
    }
    if (!threadConfigs.has(threadKey) && threadConfigs.size >= MAX_TRACKED_THREAD_MODES) {
      const oldestKey = threadConfigs.keys().next().value as string | undefined;
      if (oldestKey) threadConfigs.delete(oldestKey);
    }
    threadConfigs.set(threadKey, config);
  }

  function buildSessionContext(threadId: string): string {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    return [
      "# Session Context",
      "",
      `- **Date/Time**: ${now} UTC`,
      `- **Thread ID**: ${threadId}`,
      `- **Platform**: Slack`,
      "",
      "## Slack Formatting Rules",
      "",
      "- Use standard markdown links `[Display Text](URL)` for all hyperlinks — they are auto-converted to Slack format",
      "- Do NOT use Slack-native `<URL|text>` link syntax — it breaks the rendering pipeline",
      "- Preserve Slack user mentions (`<@UXXXXXXX>`) exactly as-is — only use these for actual Slack users",
      "- For Twitter/X handles, always link to the profile: `[@handle](https://x.com/handle)` — bare @handle gets auto-converted to a broken Slack mention",
      "- Slack enforces a 4,000 character limit per message — split long responses across multiple messages or summarize",
      "- Markdown tables are auto-converted — use standard `| col1 | col2 |` markdown tables freely",
      "- After completing a long task, tag the requester with `@username`",
      "",
      "---",
      "",
    ].join("\n");
  }

  async function handleMessage(
    thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
    messageText: string,
    isFirstMessage: boolean,
    attachments?: Array<{ url?: string; name?: string }>,
    userId?: string,
  ) {
    const parsed = extractRunOptions(messageText);
    const requestId = crypto.randomUUID().slice(0, 8);
    const rawThreadKey = thread.id;
    const threadKey = normalizeThreadKey(rawThreadKey);
    const previous = threadConfigs.get(threadKey);
    const files: FileAttachment[] = (attachments || [])
      .filter((a): a is { url: string; name: string } => !!a.url && !!a.name)
      .map((a) => ({ url: a.url, name: a.name }));

    const harness: Harness = isFirstMessage
      ? parsed.harness
      : (previous?.harness ?? parsed.harness);
    const engine = parsed.engine ?? previous?.engine ?? null;
    const model = parsed.model ?? previous?.model ?? null;
    const budgetMode = parsed.budgetMode ?? previous?.budgetMode ?? null;

    if (
      !isFirstMessage &&
      previous &&
      parsed.harnessExplicit &&
      parsed.harness !== previous.harness
    ) {
      await thread.post(
        toSlackMessage(
          "This thread is already running with a different harness. Start a new thread to switch."
        )
      );
      return;
    }
    if (
      !isFirstMessage &&
      previous &&
      parsed.engineExplicit &&
      parsed.engine &&
      parsed.engine !== previous.engine
    ) {
      await thread.post(
        toSlackMessage(
          "This thread is already running with a different engine. Start a new thread to switch."
        )
      );
      return;
    }

    if (!parsed.cleanedText) {
      await thread.post(
        toSlackMessage(
          "Please provide a prompt after flags. Example: `--eng implement retry logic` (after mentioning the bot)."
        )
      );
      return;
    }

    setThreadConfig(threadKey, { harness, engine, model, budgetMode });

    try {
      const instruction = parsed.cleanedText;
      if (!isFirstMessage) {
        try {
          await interrupt(threadKey, requestId);
        } catch (error) {
          console.warn("agent_interrupt_failed", {
            thread: threadKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await thread.startTyping("Spawning agent...");
      await spawn(threadKey, harness, engine, undefined, requestId);

      await thread.startTyping("Running...");
      let threadHistory = "";
      if (isFirstMessage) {
        const { channel, threadTs } = splitThreadKey(threadKey);
        threadHistory = await fetchThreadHistory(channel, threadTs);
      }

      let message = isFirstMessage
        ? buildSessionContext(threadKey) + threadHistory + instruction
        : instruction;

      if (budgetMode) {
        message = `[budget: ${budgetMode}]\n\n${message}`;
      }

      const stopProgress = watchProgress(threadKey, (status) => {
        thread.startTyping(status).catch(() => {});
      });

      let result = "";
      try {
        const maxAttempts = 6;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            result = await execute(
              threadKey,
              message,
              harness,
              requestId,
              files.length > 0 ? files : undefined,
              userId,
              "slack",
              model,
              engine,
            );
            break;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const shouldRetry = isBusyRunError(detail) && attempt < maxAttempts;
            if (!shouldRetry) {
              throw error;
            }
            await sleep(Math.min(500 * Math.pow(2, attempt - 1), 5000));
          }
        }
      } finally {
        stopProgress();
      }
      let finalMessage = result;
      if (isFirstMessage) {
        const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
        finalMessage = `[Thread Viewer](${viewerUrl})\n\n` + finalMessage;
      }
      if (finalMessage.trim()) {
        await thread.post(toSlackMessage(finalMessage));
      }
    } catch (error) {
      await thread.post(
        toSlackMessage(formatErrorForSlack(error, "Agent request failed"))
      );
    }
  }

  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    await thread.subscribe();
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    await handleMessage(thread, message.text, true, attachments, message.author.userId);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    if (!message.isMention) {
      const text = (message.text || "").trim();
      const threadKey = normalizeThreadKey(thread.id);
      const files: FileAttachment[] = (attachments || [])
        .filter((a): a is { url: string; name: string } => !!a.url && !!a.name)
        .map((a) => ({ url: a.url, name: a.name }));
      if (!text && files.length === 0) return;
      const messageId = messageIdentifier({
        ts: (message as { ts?: string }).ts || (message as { id?: string }).id,
        userId: message.author.userId,
        text,
        threadId: thread.id,
      });

      const contextText = text || "Shared attachment in thread.";
      try {
        await postThreadContextMessage(threadKey, contextText, {
          source: "slack_subscribed_message",
          userId: message.author.userId,
          messageId,
          attachments: files.length > 0 ? files : undefined,
        });
      } catch (error) {
        console.warn("thread_context_post_failed", {
          thread: threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    await handleMessage(thread, message.text, false, attachments, message.author.userId);
  });

  return bot;
}

let _bot: ReturnType<typeof createBot> | null = null;
export function getBot() {
  if (!_bot) _bot = createBot();
  return _bot;
}
