import * as crypto from "node:crypto";
import { Chat, parseMarkdown, type Root } from "chat";
import { generateId } from "ai";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  extractRunOptions,
  fetchThreadRuntimeConfig,
  normalizeThreadKey,
  postThreadContextMessage,
  splitThreadKey,
  type BudgetMode,
  type Engine,
  type FileAttachment,
  type Harness,
} from "./harness";
import { ApiError } from "./api-client";
import { executeStreamingWithBusyRetries, reconnectStreamingWithRetries } from "./modes";
import { truncateSlackText } from "./slack-text";
import {
  getThreadConfig,
  setThreadConfig as setThreadConfigRedis,
  type ThreadConfig,
} from "./thread-mode-store";
import { SlackLiveReply } from "./slack-live-reply";
import { ProgressTracker } from "./progress-tracker";
import { HandoffDetector } from "./handoff-detection";
import { resultToSlackMessages, type SlackReplyMetadata } from "./slack-blocks";
import { getPool } from "@/lib/db";

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

const LOW_VALUE_PATTERNS = [
  /^i('ve| have) (handed off|delegated)/i,
  /^(handing off|delegating)/i,
  /^continuing in/i,
];

function isLowValueResult(text: string): boolean {
  if (!text) return true;
  return LOW_VALUE_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * Detect if text looks like a mid-thought that was cut off.
 * Used to trigger a reconnect attempt when the stream ended prematurely.
 */
function looksIncomplete(text: string): boolean {
  if (!text || text.length < 20) return false;
  const trimmed = text.trimEnd();
  // Ends with colon (about to do something), ellipsis, or "Let me ..."
  if (/:\s*$/.test(trimmed)) return true;
  if (/\.\.\.\s*$/.test(trimmed)) return true;
  if (/\blet me\b.{0,30}$/i.test(trimmed)) return true;
  if (/\bI'll\b.{0,30}$/i.test(trimmed)) return true;
  return false;
}

const THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "https://svc-ai.paradigm.xyz";
const MAX_TRACKED_MENTION_DELIVERIES = 5000;
const MENTION_DELIVERY_TTL_MS = 10 * 60 * 1000;
const SLACK_BOT_USERNAME = process.env.SLACK_BOT_USERNAME || "paradigm-ai";

type MarkdownNode = Root | Root["children"][number];

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const REQUIRED_SLACK_ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;

export function getSlackBootstrapState(): { ready: boolean; missingEnvKeys: string[] } {
  const missingEnvKeys = REQUIRED_SLACK_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    return !value || value.trim().length === 0;
  });
  return {
    ready: missingEnvKeys.length === 0,
    missingEnvKeys: [...missingEnvKeys],
  };
}

function isPersonaHarness(harness: Harness): boolean {
  return harness === "legal" || harness === "eng";
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
    onLockConflict: "force",
  } as ConstructorParameters<typeof Chat>[0]);
  const recentMentionDeliveries = new Map<string, number>();

  function claimMentionDelivery(
    threadId: string,
    message: { ts?: string; id?: string },
  ): boolean {
    const ts = String(message.ts || "").trim();
    const deliveryId = ts || String(message.id || "").trim();
    if (!deliveryId) return true;
    const threadKey = normalizeThreadKey(threadId);
    const claimKey = `${threadKey}:${deliveryId}`;
    const now = Date.now();

    for (const [key, seenAt] of recentMentionDeliveries) {
      if (now - seenAt > MENTION_DELIVERY_TTL_MS) {
        recentMentionDeliveries.delete(key);
      }
    }

    if (recentMentionDeliveries.has(claimKey)) {
      return false;
    }

    if (recentMentionDeliveries.size >= MAX_TRACKED_MENTION_DELIVERIES) {
      const oldestKey = recentMentionDeliveries.keys().next().value as string | undefined;
      if (oldestKey) recentMentionDeliveries.delete(oldestKey);
    }

    recentMentionDeliveries.set(claimKey, now);
    return true;
  }

  function setThreadConfig(threadKey: string, config: ThreadConfig): void {
    setThreadConfigRedis(threadKey, config).catch((err) => {
      console.warn("setThreadConfig_redis_failed", { threadKey, error: String(err) });
    });
  }

  function buildSessionContext(threadId: string, requesterUserId?: string): string {
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
      "- Use standard markdown links `[Display Text](URL)` for hyperlinks",
      "- Do NOT use Slack-native `<URL|text>` link syntax",
      "- Preserve Slack user mentions (`<@UXXXXXXX>`) exactly as-is — only use these for actual Slack users",
      "- For Twitter/X handles, link to the profile: `[@handle](https://x.com/handle)`",
      "- Prefer concise, well-structured markdown; long replies may be split across multiple Slack messages",
      "- Markdown tables are allowed and may render as native Slack tables when the structure is clean",
      requesterUserId
        ? `- After completing a long task, tag the requester with their real Slack mention: <@${requesterUserId}>`
        : "- After completing a long task, tag the requester with their real Slack mention if available",
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
    slackTs?: string,
  ) {
    const requestId = generateId();
    const rawThreadKey = thread.id;
    const threadKey = normalizeThreadKey(rawThreadKey);
    const previous = await getThreadConfig(threadKey);
    const files: FileAttachment[] = (attachments || [])
      .filter((a): a is { url: string; name: string } => !!a.url && !!a.name)
      .map((a) => ({ url: a.url, name: a.name }));

    let recovered: {
      harness: Harness | null;
      engine: Engine | null;
    } | null = null;
    if (!isFirstMessage && !previous) {
      try {
        recovered = await fetchThreadRuntimeConfig(threadKey);
      } catch (error) {
        console.warn("thread_runtime_config_recovery_failed", {
          thread: threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const activeHarness = previous?.harness ?? recovered?.harness ?? null;
    const activeEngine = previous?.engine ?? recovered?.engine ?? null;
    const parsed = extractRunOptions(messageText, { activeHarness });
    const harness: Harness = isFirstMessage ? parsed.harness : (activeHarness ?? parsed.harness);
    const engine = parsed.engine ?? activeEngine ?? null;
    const model = parsed.model ?? previous?.model ?? null;
    const budgetMode = parsed.budgetMode ?? previous?.budgetMode ?? null;

    if (!isFirstMessage && !activeHarness && !parsed.harnessExplicit) {
      await thread.post(
        toSlackMessage(
          "I could not recover the active harness for this thread. Please retry with an explicit harness flag (for example `--legal`)."
        )
      );
      return;
    }

    if (
      !isFirstMessage &&
      activeHarness &&
      parsed.harnessExplicit &&
      parsed.harness !== activeHarness
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
      activeEngine &&
      parsed.engineExplicit &&
      parsed.engine &&
      parsed.engine !== activeEngine
    ) {
      await thread.post(
        toSlackMessage(
          "This thread is already running with a different engine. Start a new thread to switch."
        )
      );
      return;
    }

    if (!parsed.cleanedText && !isPersonaHarness(harness)) {
      await thread.post(
        toSlackMessage(
          "Please provide a prompt after flags. Example: `--amp build me a dashboard`."
        )
      );
      return;
    }

    setThreadConfig(threadKey, { harness, engine, model, budgetMode });

    try {
      const instruction = parsed.cleanedText || "hey";
      await thread.startTyping("Running...");
      let threadHistory = "";
      const { channel, threadTs } = splitThreadKey(threadKey);
      if (isFirstMessage) {
        threadHistory = await fetchThreadHistory(channel, threadTs);
      }

      let message = instruction;
      if (isFirstMessage) {
        const contextPrefix = buildSessionContext(threadKey, userId);
        message = contextPrefix + threadHistory + instruction;
      }

      if (budgetMode) {
        message = `[budget: ${budgetMode}]\n\n${message}`;
      }

      const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
      const liveReply = new SlackLiveReply(channel, threadTs);
      await liveReply.start("⏳ Working...", { viewerUrl });
      const tracker = new ProgressTracker();
      const executionStartedAt = Date.now();

      let streamReturn = "";

      try {
        // Track total events yielded across iterations so reconnect can skip
        // already-seen events (the API replays full stdout history on reconnect).
        let totalYieldedCount = 0;

        // Phase 1: initial execute — sends turn.start to the container.
        {
          const handoffDetector = new HandoffDetector();
          let detectedHandoff = false;

          const gen = executeStreamingWithBusyRetries({
            threadKey,
            message,
            harness,
            engine,
          });

          while (true) {
            const { done, value } = await gen.next();
            if (done) {
              if (!detectedHandoff) streamReturn = value || "";
              break;
            }
            if (detectedHandoff) continue;

            totalYieldedCount++;
            if (tracker.update(value)) {
              liveReply.queueUpdate(tracker.toSlackBullets());
            }

            const handoff = handoffDetector.processEvent(value);
            if (handoff && handoff.follow) {
              tracker.addHandoff(handoff.goal, handoff.newThreadKey);
              liveReply.queueUpdate(tracker.toSlackBullets());
              detectedHandoff = true;
            }
          }

          // Phase 2: follow handoff chain via reconnect (no turn.start).
          // After follow=true, Amp navigates to the new thread and continues
          // autonomously. We reconnect to the same container to read its output
          // instead of sending a new turn.start which would create a competing
          // turn and produce a stale "mid-reply" summary.
          while (detectedHandoff) {
            detectedHandoff = false;
            const nextHandoffDetector = new HandoffDetector();

            const reconnGen = reconnectStreamingWithRetries({
              threadKey,
              harness,
              skipCount: totalYieldedCount,
            });

            while (true) {
              const { done, value } = await reconnGen.next();
              if (done) {
                if (!detectedHandoff) streamReturn = value || "";
                break;
              }
              if (detectedHandoff) continue;

              totalYieldedCount++;
              if (tracker.update(value)) {
                liveReply.queueUpdate(tracker.toSlackBullets());
              }

              const handoff = nextHandoffDetector.processEvent(value);
              if (handoff && handoff.follow) {
                tracker.addHandoff(handoff.goal, handoff.newThreadKey);
                liveReply.queueUpdate(tracker.toSlackBullets());
                detectedHandoff = true;
              }
            }
          }
        }

        // Phase 3: incomplete-result recovery.
        // If we got no proper result event and the last assistant text looks
        // like a mid-thought (ends with colon, "Let me", etc.), the stream
        // may have ended prematurely. Try a single reconnect to capture any
        // remaining output from a still-running container.
        const prelimResult = (tracker.resultText || tracker.lastAssistantText || streamReturn).trim();
        if (!tracker.resultText && looksIncomplete(prelimResult)) {
          try {
            const recoveryGen = reconnectStreamingWithRetries({
              threadKey,
              harness,
              skipCount: totalYieldedCount,
            });
            while (true) {
              const { done, value } = await recoveryGen.next();
              if (done) {
                if (value) streamReturn = value;
                break;
              }
              totalYieldedCount++;
              if (tracker.update(value)) {
                liveReply.queueUpdate(tracker.toSlackBullets());
              }
            }
          } catch {
            // Recovery is best-effort — don't fail the whole request
          }
        }
      } catch (error) {
        liveReply.dispose();
        throw error;
      }

      const finalMessage = (tracker.resultText || tracker.lastAssistantText || streamReturn).trim();

      // Persist user + assistant messages to chat_messages for thread viewer.
      // Use the Slack message timestamp for the user message so it sorts in
      // the original conversation order. The assistant gets +1ms to sort after.
      try {
        const pool = getPool();
        const dbClient = await pool.connect();
        try {
          const slackEpoch = slackTs ? parseFloat(slackTs) : 0;
          const userEpochMs = slackEpoch > 1_000_000_000 ? Math.floor(slackEpoch * 1000) : Date.now();
          const userMsgId = `slack-user-${threadKey}-${userEpochMs}`;
          const assistantMsgId = `slack-asst-${threadKey}-${userEpochMs + 1}`;
          const userTs = new Date(userEpochMs).toISOString();
          const assistantTs = new Date(userEpochMs + 1).toISOString();
          await dbClient.query("BEGIN");
          await dbClient.query(
            `INSERT INTO chat_messages (id, thread_key, role, parts, metadata, created_at)
             VALUES ($1, $2, 'user', $3::jsonb, $4::jsonb, $5::timestamptz)
             ON CONFLICT (id) DO NOTHING`,
            [
              userMsgId,
              threadKey,
              JSON.stringify([{ type: "text", text: instruction }]),
              JSON.stringify({ harness, ...(engine ? { engine } : {}) }),
              userTs,
            ],
          );
          if (finalMessage) {
            await dbClient.query(
              `INSERT INTO chat_messages (id, thread_key, role, parts, metadata, created_at)
               VALUES ($1, $2, 'assistant', $3::jsonb, $4::jsonb, $5::timestamptz)
               ON CONFLICT (id) DO NOTHING`,
              [
                assistantMsgId,
                threadKey,
                JSON.stringify([{ type: "text", text: finalMessage }]),
                JSON.stringify({ harness, thread_name: finalMessage.slice(0, 60) }),
                assistantTs,
              ],
            );
          }
          await dbClient.query("COMMIT");
        } catch {
          await dbClient.query("ROLLBACK");
        } finally {
          dbClient.release();
        }
      } catch {
        // Best-effort — don't block Slack reply
      }

      // Single Slack message — edit the live reply in-place with the final result.
      if (isLowValueResult(finalMessage)) {
        await liveReply.finish(tracker.toSlackBullets());
      } else {
        const metadata: SlackReplyMetadata = {
          threadKey: normalizeThreadKey(threadKey),
          harness,
          durationSeconds: Math.max(0, (Date.now() - executionStartedAt) / 1000),
          sourceLabel: "Paradigm AI",
        };
        const payloads = resultToSlackMessages(finalMessage, metadata);
        if (payloads.length > 0) {
          await liveReply.finishRich(payloads);
        } else {
          await liveReply.finish(tracker.toSlackBullets());
        }
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
    if (!claimMentionDelivery(thread.id, {
      ts: (message as { ts?: string }).ts,
      id: (message as { id?: string }).id,
    })) {
      console.info("duplicate_mention_ignored", {
        thread: normalizeThreadKey(thread.id),
        handler: "onNewMention",
        ts: (message as { ts?: string }).ts || "",
      });
      return;
    }
    await thread.subscribe();
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    const mentionTs = (message as { ts?: string }).ts || "";
    await handleMessage(thread, message.text, true, attachments, message.author.userId, mentionTs);
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
      const slackTs = (message as { ts?: string }).ts || "";
      try {
        await postThreadContextMessage(threadKey, contextText, {
          source: "slack_subscribed_message",
          userId: message.author.userId,
          messageId,
          slackTs,
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
    if (!claimMentionDelivery(thread.id, {
      ts: (message as { ts?: string }).ts,
      id: (message as { id?: string }).id,
    })) {
      console.info("duplicate_mention_ignored", {
        thread: normalizeThreadKey(thread.id),
        handler: "onSubscribedMessage",
        ts: (message as { ts?: string }).ts || "",
      });
      return;
    }
    const subTs = (message as { ts?: string }).ts || "";
    await handleMessage(thread, message.text, false, attachments, message.author.userId, subTs);
  });

  return bot;
}

let _bot: ReturnType<typeof createBot> | null = null;
export function getBot() {
  if (!_bot) _bot = createBot();
  return _bot;
}
