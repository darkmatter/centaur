import * as crypto from "node:crypto";
import { Chat, type StreamChunk } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  extractRunOptions,
  executeStreamingWithBusyRetries,
  fetchThreadHarness,
  normalizeThreadKey,
  postMessages,
  postThreadContextMessage,
  reconnectStreamingWithRetries,
  type ContentBlock,
  type Harness,
} from "./harness";
import { splitThreadKey, type CanonicalEvent } from "@centaur/harness-events";
import { log } from "@/lib/logger";
import { ApiError, API_URL, resilientFetch } from "./api-client";

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

/**
 * Poll GET /agent/status until the agent is idle, then return last_result.
 * Used as a fallback when Slack streaming expires before the agent finishes.
 */
async function pollForLastResult(threadKey: string, maxWaitMs = 5 * 60_000): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  const interval = 3_000;
  while (Date.now() < deadline) {
    try {
      const res = await resilientFetch(
        `${API_URL}/agent/status?key=${encodeURIComponent(threadKey)}`,
        { timeoutMs: 10_000, maxAttempts: 1 },
      );
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (!data.busy) {
          const result = data.last_result;
          if (typeof result === "string" && result.trim()) return result.trim();
          return "";
        }
      }
    } catch {
      // best-effort — keep polling
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return "";
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

    // Backfill prior messages via POST /agent/messages
    try {
      const backfillMessages = prior.map((m) => ({
        role: "user" as const,
        parts: [{ type: "text" as const, text: m.text || "(no text)" }],
        user_id: m.userId || undefined,
        metadata: { source: "slack_backfill" },
      }));
      if (backfillMessages.length > 0) {
        const normalizedKey = normalizeThreadKey(thread.id);
        await postMessages(normalizedKey, backfillMessages);
      }
    } catch (err) {
      log.warn("backfill_messages_failed", {
        thread: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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



  async function* drainStreamChunks(
    gen: AsyncGenerator<CanonicalEvent, string, undefined>,
    tracker: ProgressTracker,
    handoffDetector?: HandoffDetector,
  ): AsyncGenerator<StreamChunk, { streamReturn: string; yieldedCount: number; handoff: HandoffResult | null }, undefined> {
    let yieldedCount = 0;
    let detectedHandoff = false;
    let handoff: HandoffResult | null = null;
    let streamReturn = "";

    // Slack's streaming API times out if no appends are sent for too long.
    // Race gen.next() against a keepalive timer to prevent stream expiry.
    const KEEPALIVE_INTERVAL_MS = 60_000;
    let keepaliveId = 0;

    while (true) {
      let result: IteratorResult<CanonicalEvent, string>;
      const nextP = gen.next();
      // Race between next event and keepalive timeout
      const winner = await Promise.race([
        nextP.then((r) => ({ kind: "event" as const, result: r })),
        new Promise<{ kind: "keepalive" }>((resolve) =>
          setTimeout(() => resolve({ kind: "keepalive" }), KEEPALIVE_INTERVAL_MS),
        ),
      ]);

      if (winner.kind === "keepalive") {
        // Yield a keepalive task_update to keep the Slack stream alive
        yield {
          type: "task_update" as const,
          id: `keepalive-${keepaliveId++}`,
          title: "Working…",
          status: "in_progress" as const,
        };
        // Now await the actual event
        result = await nextP;
      } else {
        result = winner.result;
      }

      if (result.done) {
        if (!detectedHandoff) streamReturn = result.value || "";
        break;
      }
      if (detectedHandoff) continue;

      yieldedCount++;
      if (tracker.update(result.value)) {
        const chunks = tracker.pendingChunks();
        for (const chunk of chunks) yield chunk;
      }

      if (handoffDetector) {
        const hResult = handoffDetector.processEvent(result.value);
        if (hResult && hResult.follow) {
          tracker.addHandoff(hResult.goal, hResult.newThreadKey);
          const chunks = tracker.pendingChunks();
          for (const chunk of chunks) yield chunk;
          handoff = hResult;
          detectedHandoff = true;
        }
      }
    }

    return { streamReturn, yieldedCount, handoff };
  }

  async function* streamProgress(
    threadKey: string,
    message: string | ContentBlock[],
    harness: Harness,
    tracker: ProgressTracker,
    executionStartedAt: number,
    options?: { platform?: string; userId?: string },
  ): AsyncGenerator<StreamChunk> {
    let totalYieldedCount = 0;

    // Yield the thread viewer link immediately so it's clickable from the start.
    if (THREAD_VIEWER_URL) {
      const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
      yield { type: "markdown_text", text: `[Thread Viewer](${viewerUrl})` };
    }
    yield { type: "task_update", id: "init", title: "Starting…", status: "in_progress" };

    // Phase 1: initial execute — sends turn.start to the container.
    const phase1 = drainStreamChunks(
      executeStreamingWithBusyRetries(threadKey, message, harness, options),
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
    // skip_done_count=1 tells the API to skip the old turn's turn.done during
    // stdout replay so we keep streaming until the followed thread finishes.
    let lastHandoff = phase1Result.handoff;
    let handoffDepth = 0;
    while (lastHandoff) {
      handoffDepth++;
      const phase = drainStreamChunks(
        reconnectStreamingWithRetries(threadKey, harness, totalYieldedCount, handoffDepth),
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

    // Ensure the "Starting…" init step is marked complete before the stream
    // ends. If no canonical events arrived (e.g. empty response or error before
    // first event), Slack would otherwise render the stuck in_progress step as
    // failed (red).
    if (!tracker.initCompleted) {
      yield { type: "task_update", id: "init", title: "Started", status: "complete" };
    }

    // Yield the final result as the last streamed chunk so everything
    // appears in a single Slack message instead of a separate follow-up.
    const finalMessage = (tracker.resultText || tracker.lastAssistantText).trim();
    if (finalMessage && !isLowValueResult(finalMessage)) {
      const durationSeconds = Math.max(0, (Date.now() - executionStartedAt) / 1000);
      const durationStr = durationSeconds < 10 ? `${durationSeconds.toFixed(1)}s` : `${Math.round(durationSeconds)}s`;
      const harnessLabel = tracker.agentThreadId
        ? `[${harness}](https://ampcode.com/threads/${tracker.agentThreadId})`
        : harness;
      const metaParts = [
        process.env.APP_NAME || "Centaur",
        harnessLabel,
        durationStr,
      ].filter(Boolean);
      const parts: string[] = [`_${metaParts.join(" · ")}_\n\n`, finalMessage];
      yield { type: "markdown_text", text: parts.join("") };
    }
  }

  async function resolveAttachmentBlocks(
    attachments: Array<{ url?: string; name?: string; mimeType?: string; fetchData?: () => Promise<Buffer> }>,
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      if (!att.fetchData || !att.mimeType) continue;
      try {
        const data = await att.fetchData();
        const b64 = data.toString("base64");
        if (att.mimeType.startsWith("image/")) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: att.mimeType, data: b64 },
            ...(att.name ? { name: att.name } : {}),
          } as ContentBlock);
        } else {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: att.mimeType, data: b64 },
            ...(att.name ? { name: att.name } : {}),
          } as ContentBlock);
        }
      } catch (err) {
        log.warn("attachment_fetch_failed", {
          name: att.name || "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return blocks;
  }

  async function handleMessage(
    thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
    messageText: string,
    isFirstMessage: boolean,
    attachments?: Array<{ url?: string; name?: string; mimeType?: string; fetchData?: () => Promise<Buffer> }>,
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

    log.info("message_received", {
      thread_key: threadKey,
      harness,
      is_first_message: isFirstMessage,
      has_attachments: Boolean(attachments?.length),
      user_id: userId,
    });

    if (!isFirstMessage && !activeHarness && !parsed.harnessExplicit) {
      await thread.post(
        "I could not recover the active harness for this thread. Please retry with an explicit harness flag (for example `--legal`)."
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
        "This thread is already running with a different harness. Start a new thread to switch."
      );
      return;
    }

    if (!parsed.cleanedText) {
      await thread.post(
        "Please provide a prompt after flags. Example: `--amp build me a dashboard`."
      );
      return;
    }

    try {
      const instruction = parsed.cleanedText || "hey";
      let threadHistory = "";
      if (isFirstMessage) {
        threadHistory = await fetchThreadHistory(thread, slackTs);
      }

      let textMessage = isFirstMessage ? threadHistory + instruction : instruction;

      if (budgetMode) {
        textMessage = `[budget: ${budgetMode}]\n\n${textMessage}`;
      }

      // Resolve file attachments into Anthropic content blocks (base64-encoded).
      // The Chat SDK's fetchData() handles Slack auth + redirects natively.
      const contentBlocks = await resolveAttachmentBlocks(attachments || []);
      const message: string | ContentBlock[] = contentBlocks.length > 0
        ? [{ type: "text" as const, text: textMessage }, ...contentBlocks]
        : textMessage;

      // Buffer the message via POST /agent/messages
      try {
        const parts: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [
          { type: "text", text: textMessage },
        ];
        for (const block of contentBlocks) {
          parts.push(block as any);
        }
        await postMessages(threadKey, [{
          role: "user",
          parts,
          user_id: userId,
          metadata: { slack_ts: slackTs, source: "slack" },
        }]);
      } catch (err) {
        log.warn("message_buffer_failed", {
          thread: threadKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const tracker = new ProgressTracker();
      const executionStartedAt = Date.now();

      log.info("execute_start", { thread_key: threadKey, harness });

      // Stream progress via SDK — uses Slack's native chat.startStream/appendStream/stopStream
      // The final result + thread viewer link are yielded as the last chunk so
      // everything appears in a single Slack message (no duplicate follow-up).
      let sentMessage: Awaited<ReturnType<typeof thread.post>> | null = null;
      try {
        sentMessage = await thread.post(streamProgress(threadKey, message, harness, tracker, executionStartedAt, { platform: "slack", userId }));
      } catch (streamErr) {
        // Slack killed the streaming state before we called stop() (long-running turn).
        // Fall back to posting a plain message with whatever result we accumulated,
        // or poll the API for the final result if we don't have one yet.
        const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        if (errMsg.includes("message_not_in_streaming_state")) {
          log.warn("slack_stream_expired", { thread_key: threadKey, error: errMsg });
          let fallback = (tracker.resultText || tracker.lastAssistantText).trim();
          log.warn("stream_expired_fallback", { thread_key: threadKey, had_result: Boolean(fallback) });

          // If we don't have the final answer yet, poll the API until the agent
          // finishes (it's still running — Slack just expired the stream).
          if (!fallback || isLowValueResult(fallback)) {
            fallback = await pollForLastResult(normalizeThreadKey(threadKey));
          }

          if (fallback && !isLowValueResult(fallback)) {
            await thread.post({ markdown: fallback });
          } else if (THREAD_VIEWER_URL) {
            const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
            await thread.post({ markdown: `Agent completed. [View full output](${viewerUrl})` });
          }
          // Mark as delivered so the orphan checker doesn't repost
          try {
            await resilientFetch(`${API_URL}/agent/mark-delivered`, {
              method: "POST",
              body: JSON.stringify({ thread_key: threadKey }),
            });
          } catch {
            // Best-effort
          }
          return;
        }
        throw streamErr;
      }

      const finalMessage = (tracker.resultText || tracker.lastAssistantText).trim();

      const durationS = (Date.now() - executionStartedAt) / 1000;
      log.info("execute_complete", {
        thread_key: threadKey,
        harness,
        duration_s: Math.round(durationS * 10) / 10,
        result_length: finalMessage.length,
      });

      // One-time edit: replace the streamed message (which includes tool progress
      // tasks like "Starting…", "Reading — file.ts", etc.) with just the clean
      // final answer. This removes all tool-call noise from the Slack thread.
      if (finalMessage && !isLowValueResult(finalMessage)) {
        try {
          const durationSeconds = Math.max(0, (Date.now() - executionStartedAt) / 1000);
          const durationStr = durationSeconds < 10 ? `${durationSeconds.toFixed(1)}s` : `${Math.round(durationSeconds)}s`;
          const harnessLabel = tracker.agentThreadId
            ? `[${harness}](https://ampcode.com/threads/${tracker.agentThreadId})`
            : harness;
          const metaParts = [
            process.env.APP_NAME || "Centaur",
            harnessLabel,
            durationStr,
          ].filter(Boolean);
          const parts: string[] = [`_${metaParts.join(" · ")}_\n\n`, finalMessage];
          if (THREAD_VIEWER_URL) {
            const viewerUrl = `${THREAD_VIEWER_URL}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
            parts.push(`\n\n[Thread Viewer](${viewerUrl})`);
          }
          await sentMessage.edit({ markdown: parts.join("") });
          log.info("slack_edit_complete", { thread_key: threadKey });
        } catch {
          // Best-effort — the streamed message already has the final text
        }
      }

      // Mark as delivered so orphan recovery won't re-post
      try {
        await resilientFetch(`${API_URL}/agent/mark-delivered`, {
          method: "POST",
          body: JSON.stringify({ thread_key: threadKey }),
        });
      } catch {
        // Best-effort
      }

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
      log.error("execute_error", {
        thread_key: threadKey,
        error: error instanceof Error ? error.message : String(error),
      });
      await thread.post(formatErrorForSlack(error, "Agent request failed"));
    }
  }

  bot.onNewMention(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    await thread.subscribe();
    let attachments = message.attachments ? [...message.attachments] : [];
    const mentionTs = (message as { ts?: string }).ts || "";

    // Slack app_mention events don't include files — re-fetch the message to get them
    if (attachments.length === 0 && mentionTs) {
      try {
        const slack = bot.getAdapter("slack") as SlackAdapter;
        const refetched = await slack.fetchMessage(thread.id, mentionTs);
        if (refetched?.attachments && refetched.attachments.length > 0) {
          attachments = [...refetched.attachments];
          log.info("mention_files_refetched", { thread: thread.id, count: attachments.length });
        }
      } catch (err) {
        log.warn("mention_files_refetch_failed", {
          thread: thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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

  // ── Orphaned completion recovery ──────────────────────────────────────────
  // When the slackbot crashes mid-execution, the agent's response is persisted
  // in chat_messages but never posted to Slack. This polls for such orphans and
  // delivers them retroactively.

  const ORPHAN_CHECK_INTERVAL_MS = 60_000;

  async function checkOrphanedCompletions() {
    if (!hasSlackCreds) return;
    try {
      const res = await resilientFetch(`${API_URL}/agent/orphaned?max_age_s=300`, {
        timeoutMs: 10_000,
        maxAttempts: 1,
      });
      if (!res.ok) return;
      const orphans = (await res.json()) as Array<{
        thread_key: string;
        text: string;
        updated_at: string | null;
      }>;
      if (orphans.length === 0) return;
      log.info("orphan_check_found", { count: orphans.length });

      const slack = bot.getAdapter("slack") as SlackAdapter;

      for (const orphan of orphans) {
        if (!orphan.text) continue;
        // Only handle Slack thread keys (channel:thread_ts format)
        let channel: string;
        let threadTs: string;
        try {
          ({ channel, threadTs } = splitThreadKey(orphan.thread_key));
        } catch {
          continue;
        }
        // Slack channel IDs start with C, D, or G
        if (!/^[CDG]/.test(channel)) continue;

        // Atomically claim this orphan (idle → delivering) to prevent duplicates
        try {
          const claimRes = await resilientFetch(`${API_URL}/agent/claim-delivery`, {
            method: "POST",
            body: JSON.stringify({ thread_key: orphan.thread_key }),
            maxAttempts: 1,
          });
          if (claimRes.ok) {
            const claimData = (await claimRes.json()) as { claimed: boolean };
            if (!claimData.claimed) continue; // Another process already claimed it
          } else {
            continue;
          }
        } catch {
          continue;
        }

        try {
          const slackThreadId = `slack:${channel}:${threadTs}`;
          await slack.postMessage(slackThreadId, orphan.text);
          log.info("orphan_delivered", { thread_key: orphan.thread_key });
          await resilientFetch(`${API_URL}/agent/mark-delivered`, {
            method: "POST",
            body: JSON.stringify({ thread_key: orphan.thread_key }),
          });
        } catch (err) {
          log.warn("orphan_delivery_failed", {
            thread_key: orphan.thread_key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn("orphan_check_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Run first check after a short delay (let bot finish initializing), then periodically
  setTimeout(checkOrphanedCompletions, 10_000);
  setInterval(checkOrphanedCompletions, ORPHAN_CHECK_INTERVAL_MS);

  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe) return;
    if (message.author.isBot) return;
    const rawAttachments = message.attachments || [];
    if (!message.isMention) {
      const text = (message.text || "").trim();
      const threadKey = normalizeThreadKey(thread.id);
      const files = rawAttachments
        .filter((a) => !!a.url && !!a.name)
        .map((a) => ({ url: a.url!, name: a.name!, mimeType: a.mimeType }));
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
    await handleMessage(thread, message.text, false, rawAttachments, message.author.userId, subTs);
  });

  return bot;
}

let _bot: ReturnType<typeof createBot> | null = null;
export function getBot() {
  if (!_bot) _bot = createBot();
  return _bot;
}
