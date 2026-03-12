import * as crypto from "node:crypto";
import { Chat, type StreamChunk } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  extractRunOptions,
  executeStreamingWithBusyRetries,
  fetchThreadHarness,
  normalizeThreadKey,
  postThreadContextMessage,
  reconnectStreamingWithRetries,
  type Harness,
} from "./harness";
import { splitThreadKey, type CanonicalEvent } from "@centaur/harness-events";
import { log } from "@/lib/logger";
import { ApiError } from "./api-client";
import { truncateSlackText } from "./slack-text";
import { ProgressTracker } from "./progress-tracker";
import { HandoffDetector, type HandoffResult } from "./handoff-detection";
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

const THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "";
const SLACK_BOT_USERNAME = process.env.SLACK_BOT_USERNAME || "ai-agent";
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

async function fetchThreadHistory(
  thread: { allMessages: AsyncIterable<{ author: { isBot: boolean | "unknown"; isMe: boolean; userId: string }; text: string; id: string }> ; id: string },
  currentTs?: string,
): Promise<string> {
  try {
    const prior: Array<{ userId: string; text: string }> = [];
    for await (const msg of thread.allMessages) {
      if (msg.author.isBot || msg.author.isMe) continue;
      if (currentTs && msg.id === currentTs) continue;
      prior.push({ userId: msg.author.userId, text: msg.text });
    }
    if (prior.length === 0) return "";

    const lines = prior.map((m) => {
      const user = m.userId ? `<@${m.userId}>` : "Unknown";
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
    log.warn("fetch_thread_history_failed", {
      thread: thread.id,
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


function createBot() {
  const hasSlackCreds =
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET;

  const bot = new Chat({
    userName: SLACK_BOT_USERNAME,
    adapters: hasSlackCreds ? { slack: createSlackAdapter() } : {},
    state: createPostgresState({ client: getPool() }),
    onLockConflict: "force",
  } as ConstructorParameters<typeof Chat>[0]);

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

  async function* drainStreamChunks(
    gen: AsyncGenerator<CanonicalEvent, string, undefined>,
    tracker: ProgressTracker,
    handoffDetector?: HandoffDetector,
  ): AsyncGenerator<StreamChunk, { streamReturn: string; yieldedCount: number; handoff: HandoffResult | null }, undefined> {
    let yieldedCount = 0;
    let detectedHandoff = false;
    let handoff: HandoffResult | null = null;
    let streamReturn = "";

    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        if (!detectedHandoff) streamReturn = value || "";
        break;
      }
      if (detectedHandoff) continue;

      yieldedCount++;
      if (tracker.update(value)) {
        const chunks = tracker.pendingChunks();
        for (const chunk of chunks) yield chunk;
      }

      if (handoffDetector) {
        const result = handoffDetector.processEvent(value);
        if (result && result.follow) {
          tracker.addHandoff(result.goal, result.newThreadKey);
          const chunks = tracker.pendingChunks();
          for (const chunk of chunks) yield chunk;
          handoff = result;
          detectedHandoff = true;
        }
      }
    }

    return { streamReturn, yieldedCount, handoff };
  }

  async function* streamProgress(
    threadKey: string,
    message: string,
    harness: Harness,
    tracker: ProgressTracker,
    executionStartedAt: number,
  ): AsyncGenerator<StreamChunk> {
    let totalYieldedCount = 0;

    // Yield immediately so the user sees the stream open right away.
    yield { type: "task_update", id: "init", title: "Starting…", status: "in_progress" };

    // Phase 1: initial execute — sends turn.start to the container.
    const phase1 = drainStreamChunks(
      executeStreamingWithBusyRetries(threadKey, message, harness),
      tracker, new HandoffDetector(),
    );
    let phase1Result: { streamReturn: string; yieldedCount: number; handoff: HandoffResult | null };
    while (true) {
      const { done, value } = await phase1.next();
      if (done) {
        phase1Result = value;
        break;
      }
      yield value;
    }
    totalYieldedCount += phase1Result.yieldedCount;

    // Phase 2: follow handoff chain via reconnect (no turn.start).
    let lastHandoff = phase1Result.handoff;
    while (lastHandoff) {
      const phase = drainStreamChunks(
        reconnectStreamingWithRetries(threadKey, harness, totalYieldedCount),
        tracker, new HandoffDetector(),
      );
      let phaseResult: typeof phase1Result;
      while (true) {
        const { done, value } = await phase.next();
        if (done) {
          phaseResult = value;
          break;
        }
        yield value;
      }
      totalYieldedCount += phaseResult.yieldedCount;
      lastHandoff = phaseResult.handoff;
    }

    // Phase 3: incomplete-result recovery.
    const prelimResult = (tracker.resultText || tracker.lastAssistantText).trim();
    if (!tracker.resultText && looksIncomplete(prelimResult)) {
      try {
        const phase3 = drainStreamChunks(
          reconnectStreamingWithRetries(threadKey, harness, totalYieldedCount),
          tracker,
        );
        while (true) {
          const { done, value } = await phase3.next();
          if (done) break;
          yield value;
        }
      } catch {
        // Recovery is best-effort
      }
    }

    // Yield the final result as the last streamed chunk so everything
    // appears in a single Slack message instead of a separate follow-up.
    const finalMessage = (tracker.resultText || tracker.lastAssistantText).trim();
    if (finalMessage && !isLowValueResult(finalMessage)) {
      const durationSeconds = Math.max(0, (Date.now() - executionStartedAt) / 1000);
      const durationStr = durationSeconds < 10 ? `${durationSeconds.toFixed(1)}s` : `${Math.round(durationSeconds)}s`;
      const metaParts = [
        process.env.APP_NAME || "Centaur",
        harness,
        durationStr,
      ].filter(Boolean);
      const parts: string[] = [`_${metaParts.join(" · ")}_\n\n`, finalMessage];
      if (THREAD_VIEWER_URL) {
        const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
        parts.push(`\n\n[Thread Viewer](${viewerUrl})`);
      }
      yield { type: "markdown_text", text: parts.join("") };
    }
  }

  async function handleMessage(
    thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
    messageText: string,
    isFirstMessage: boolean,
    attachments?: Array<{ url?: string; name?: string }>,
    userId?: string,
    slackTs?: string,
  ) {
    const rawThreadKey = thread.id;
    const threadKey = normalizeThreadKey(rawThreadKey);
    let activeHarness: Harness | null = null;
    if (!isFirstMessage) {
      try {
        activeHarness = await fetchThreadHarness(threadKey);
      } catch (error) {
        log.warn("thread_harness_recovery_failed", {
          thread: threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const parsed = extractRunOptions(messageText);
    const harness: Harness = isFirstMessage ? parsed.harness : (activeHarness ?? parsed.harness);
    const budgetMode = parsed.budgetMode;

    if (!isFirstMessage && !activeHarness && !parsed.harnessExplicit) {
      await thread.post(
        truncateSlackText(
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
        truncateSlackText(
          "This thread is already running with a different harness. Start a new thread to switch."
        )
      );
      return;
    }

    if (!parsed.cleanedText) {
      await thread.post(
        truncateSlackText(
          "Please provide a prompt after flags. Example: `--amp build me a dashboard`."
        )
      );
      return;
    }

    try {
      const instruction = parsed.cleanedText || "hey";
      let threadHistory = "";
      if (isFirstMessage) {
        threadHistory = await fetchThreadHistory(thread, slackTs);
      }

      let message = instruction;
      if (isFirstMessage) {
        const contextPrefix = buildSessionContext(threadKey, userId);
        message = contextPrefix + threadHistory + instruction;
      }

      if (budgetMode) {
        message = `[budget: ${budgetMode}]\n\n${message}`;
      }

      const tracker = new ProgressTracker();
      const executionStartedAt = Date.now();

      // Stream progress via SDK — uses Slack's native chat.startStream/appendStream/stopStream
      // The final result + thread viewer link are yielded as the last chunk so
      // everything appears in a single Slack message (no duplicate follow-up).
      await thread.post(streamProgress(threadKey, message, harness, tracker, executionStartedAt));

      const finalMessage = (tracker.resultText || tracker.lastAssistantText).trim();

      // Update thread_name in sandbox_sessions + set Slack assistant thread title
      if (finalMessage) {
        const titleText = finalMessage.slice(0, 60);
        try {
          const pool = getPool();
          await pool.query(
            `UPDATE sandbox_sessions SET thread_name = $1, updated_at = NOW() WHERE thread_key = $2`,
            [titleText, threadKey],
          );
        } catch {
          // Best-effort
        }
        try {
          const slack = bot.getAdapter("slack") as SlackAdapter;
          const { channel, threadTs } = splitThreadKey(rawThreadKey);
          await slack.setAssistantTitle(channel, threadTs, titleText);
        } catch {
          // Best-effort — only works in assistant threads (DMs)
        }
      }
    } catch (error) {
      await thread.post(
        truncateSlackText(formatErrorForSlack(error, "Agent request failed"))
      );
    }
  }

  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    await thread.subscribe();
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    const mentionTs = (message as { ts?: string }).ts || "";
    await handleMessage(thread, message.text, true, attachments, message.author.userId, mentionTs);
  });

  // --- Slack AI Assistant events ---

  const DEFAULT_PROMPTS = [
    { title: "Research a topic", message: "Research the latest developments on..." },
    { title: "Analyze data", message: "Analyze the following data and summarize key findings:" },
    { title: "Draft a document", message: "Draft a brief document about..." },
    { title: "Explain code", message: "Explain how this part of the codebase works:" },
  ];

  bot.onAssistantThreadStarted(async (event) => {
    try {
      const slack = bot.getAdapter("slack") as SlackAdapter;
      const prompts = [...DEFAULT_PROMPTS];
      if (event.context.channelId) {
        prompts.unshift({
          title: "Summarize this channel",
          message: "Summarize the recent activity in this channel.",
        });
      }
      await slack.setSuggestedPrompts(
        event.channelId,
        event.threadTs,
        prompts.slice(0, 4),
        "What can I help with?",
      );
    } catch (error) {
      log.warn("assistant_thread_started_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  bot.onAssistantContextChanged(async (event) => {
    try {
      const slack = bot.getAdapter("slack") as SlackAdapter;
      const prompts = event.context.channelId
        ? [
            { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
            ...DEFAULT_PROMPTS.slice(0, 3),
          ]
        : DEFAULT_PROMPTS.slice(0, 4);
      await slack.setSuggestedPrompts(
        event.channelId,
        event.threadTs,
        prompts,
      );
    } catch (error) {
      log.warn("assistant_context_changed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    const attachments = message.attachments?.map((a) => ({ url: a.url, name: a.name }));
    if (!message.isMention) {
      const text = (message.text || "").trim();
      const threadKey = normalizeThreadKey(thread.id);
      const files = (attachments || [])
        .filter((a): a is { url: string; name: string } => !!a.url && !!a.name);
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
        log.warn("thread_context_post_failed", {
          thread: threadKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
