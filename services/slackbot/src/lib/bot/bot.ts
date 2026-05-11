import { normalizeThreadKey, splitThreadKey } from "@centaur/harness-events";
import type { CanonicalEvent } from "@centaur/harness-events";
import { CentaurClient } from "@centaur/api-client";
import type { InputContentBlock } from "@centaur/api-client";

import { log } from "@/lib/logger";
import {
  stringifyMarkdown,
  renderMarkdownForSlack,
  splitMarkdownForSlackMessages,
  SLACK_BLOCKS_PER_MESSAGE,
  type Root,
} from "@/lib/slack/markdown";
import { classifySlackError } from "@/lib/slack/errors";
import {
  buildRuntimeErrorDetail,
  flattenMarkdownTables,
  isCancellationTerminalState,
  isSlackInvalidBlocksError,
  normalizedTerminalString,
  renderTerminalResultCopy,
  shouldNotifyRuntimeErrorChannel,
  splitSlackMessage,
} from "@/lib/slack/delivery";
import type { SlackBlock, StreamChunk } from "@/lib/slack/types";
import { ProgressTracker } from "./progress-tracker";
import { convertDashboardBlocks, type ChartRenderer, type DashboardFileUpload } from "./dashboard-to-slack";
import { createChartRenderer } from "./chart-renderer";

const KEEPALIVE_MS = 30_000; // 30s — Slack expires streaming state after ~5 min; aggressive keepalive prevents placeholder death on long-running turns
const STREAM_EXPIRED_POLL_INTERVAL_MS = 3_000;
const STREAM_EXPIRED_POLL_MAX_MS = 5 * 60_000;
const SLACK_STREAM_MARKDOWN_CHUNK_CHARS = 12_000;
const SLACK_CONTENT_BLOCKS_WITH_CONTEXT = SLACK_BLOCKS_PER_MESSAGE - 1;
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
/**
 * Exhaustive allowlist of valid prompt selectors (harnesses + personas + aliases).
 * Only `--flag` tokens matching this set trigger persona/harness routing.
 * Unrecognised flags (e.g. `--rpc-url`, `--installed`) are left in the message
 * text as regular user content instead of causing an `unknown persona_id` error.
 *
 * Update this set when a new persona or harness is added.
 */
const KNOWN_PROMPT_SELECTORS = new Set([
  // harnesses
  ...EXECUTION_HARNESSES,
  // aliases (pre-resolution)
  ...PROMPT_FLAG_ALIASES.keys(),
  // personas
  "eng",
  "invest",
]);

type SlackRepoContext = {
  cwd?: string;
  repoOwner?: string;
  repoName?: string;
  gitRef?: string;
  gitCommit?: string;
};

function normalizeRepoContext(raw: unknown): SlackRepoContext {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const context: SlackRepoContext = {};
  if (typeof source.cwd === "string" && source.cwd.trim()) context.cwd = source.cwd.trim();
  if (typeof source.repo_owner === "string" && source.repo_owner.trim()) context.repoOwner = source.repo_owner.trim();
  if (typeof source.repo_name === "string" && source.repo_name.trim()) context.repoName = source.repo_name.trim();
  if (typeof source.git_ref === "string" && source.git_ref.trim()) context.gitRef = source.git_ref.trim();
  if (typeof source.git_commit === "string" && source.git_commit.trim()) context.gitCommit = source.git_commit.trim();
  return context;
}

function resolveRepoRef(repoContext?: SlackRepoContext): string {
  return repoContext?.gitCommit?.trim() || repoContext?.gitRef?.trim() || "";
}

function buildGitHubBlobUrl(
  owner: string,
  repo: string,
  ref: string,
  relativePath: string,
  hash: string,
): string {
  const encodedPath = relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(ref)}/${encodedPath}${hash}`;
}

function fileUrlToGitHubUrl(href: string, repoContext?: SlackRepoContext): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "file:") return null;

  const path = decodeURIComponent(url.pathname);
  const repoRef = resolveRepoRef(repoContext);
  const workspaceMatch = path.match(/^\/home\/agent\/workspace\/(.+)$/);
  if (workspaceMatch) {
    if (!repoContext?.repoOwner || !repoContext.repoName || !repoRef) return null;
    return buildGitHubBlobUrl(repoContext.repoOwner, repoContext.repoName, repoRef, workspaceMatch[1], url.hash);
  }

  const match = path.match(/^\/home\/agent\/(?:github|branches)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;

  const [, owner, repo, relPath] = match;
  const ref = repoContext?.repoOwner === owner && repoContext?.repoName === repo && repoRef
    ? repoRef
    : "main";
  return buildGitHubBlobUrl(owner, repo, ref, relPath, url.hash);
}

export function rewriteSlackFileLinks(markdown: string, repoContext?: SlackRepoContext): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label: string, href: string) => {
    const githubUrl = fileUrlToGitHubUrl(href, repoContext);
    return githubUrl ? `[${label}](${githubUrl})` : full;
  });
}

export { splitSlackMessage } from "@/lib/slack/delivery";

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

type SlackHistoryWorkflowMessage = {
  message_id: string;
  parts: InputContentBlock[];
  user_id?: string;
  metadata?: Record<string, unknown>;
};

const PROMPT_FLAG_RE = /(?:^|\s)--([a-z][a-z0-9-]*)(?=\s|$)/gi;
const PROMPT_FLAG_SKIP = new Set(["engine", "model", "opus", "sonnet", "haiku"]);

/**
 * Extract recognised `--flag` tokens for persona/harness routing.
 *
 * Only flags that match KNOWN_PROMPT_SELECTORS (after alias resolution and
 * skip-list filtering) are treated as routing directives; all other `--word`
 * tokens are left in the message text untouched. This prevents user content
 * like `--rpc-url` or `--installed` from being misinterpreted as persona
 * switches and causing `unknown persona_id` errors.
 */
export function extractFlagSelector(text: string): { selector?: string; cleaned: string } {
  const re = new RegExp(PROMPT_FLAG_RE.source, PROMPT_FLAG_RE.flags);
  let selector: string | undefined;
  const recognisedOffsets: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const flag = match[1].toLowerCase();
    if (PROMPT_FLAG_SKIP.has(flag)) {
      recognisedOffsets.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }
    const resolved = PROMPT_FLAG_ALIASES.get(flag) || flag;
    if (KNOWN_PROMPT_SELECTORS.has(resolved) || KNOWN_PROMPT_SELECTORS.has(flag)) {
      selector = resolved;
      recognisedOffsets.push({ start: match.index, end: match.index + match[0].length });
    }
    // Unknown flags: leave in text, do not set selector
  }
  // Strip only recognised flag tokens from the text
  let cleaned = text;
  for (let i = recognisedOffsets.length - 1; i >= 0; i--) {
    const { start, end } = recognisedOffsets[i];
    cleaned = cleaned.slice(0, start) + " " + cleaned.slice(end);
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return { selector, cleaned };
}

/** Backwards-compat wrapper: the raw selector string only. */
export function parsePromptSelectorFlag(text: string): string | undefined {
  return extractFlagSelector(text).selector;
}

/**
 * Strip residual mention tokens (`<@U...>`) so we can detect a truly empty
 * payload after flag removal. Used by the bare-trigger short-circuit.
 */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Persona-specific canned responses for bare-flag invocations (e.g. just
 * `@centaur_ai --invest`). The LLM's compliance with prompt-level "respond
 * with exactly this line" rules is unreliable for empty-payload turns, so
 * we short-circuit at the slackbot to guarantee the persona identifier
 * appears and to save a sandbox round-trip.
 */
const BARE_FLAG_GREETINGS: Record<string, string> = {
  invest: "Spock — Paradigm's investment agent. What are we looking at?",
};

/** Return the canned greeting for a bare `--<persona>` mention with no other content. */
export function bareFlagGreeting(
  selector: string | undefined,
  cleanedText: string,
  attachmentCount: number,
): string | undefined {
  if (!selector) return undefined;
  if (attachmentCount > 0) return undefined;
  if (stripMentions(cleanedText).length > 0) return undefined;
  return BARE_FLAG_GREETINGS[selector];
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

function compareSlackMessageIds(a: string, b: string): number {
  const aTs = Number(a.replace(/^slack:/, ""));
  const bTs = Number(b.replace(/^slack:/, ""));
  if (Number.isFinite(aTs) && Number.isFinite(bTs)) return aTs - bTs;
  return a.localeCompare(b);
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

function executionIdFromError(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const executionId = (err as Error & { executionId?: unknown }).executionId;
  return typeof executionId === "string" ? executionId : "";
}

function conflictCode(err: unknown): string | undefined {
  const resp = (err as { response?: { status?: number; data?: { code?: string; detail?: { code?: string } } } })?.response;
  if (resp?.status !== 409) return undefined;
  return resp?.data?.code ?? resp?.data?.detail?.code ?? "UNKNOWN_409";
}

function isIdempotencyMismatch(err: unknown): boolean {
  const code = conflictCode(err);
  return code === "IDEMPOTENCY_PAYLOAD_MISMATCH";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function repoContextFromExecutionRecord(value: unknown): SlackRepoContext {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  return normalizeRepoContext(record.repo_context ?? metadata.repo_context);
}

function agentThreadIdFromRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  const agentThreadId = record.agent_thread_id;
  return typeof agentThreadId === "string" && agentThreadId.trim() ? agentThreadId.trim() : undefined;
}

function slackAdapterThreadId(threadKey: string): string {
  return threadKey.startsWith("slack:") ? threadKey : `slack:${threadKey}`;
}

function slackDeliveryThreadId(threadKey: string, delivery: Record<string, unknown>): string {
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim() : "";
  const threadTs = typeof delivery.thread_ts === "string" ? delivery.thread_ts.trim() : "";
  if (channel && threadTs) {
    return `slack:${channel}:${threadTs}`;
  }
  return slackAdapterThreadId(threadKey);
}

function invalidWorkflowSlackDestination(
  threadKey: string,
  delivery: Record<string, unknown>,
): string | null {
  if (!threadKey.startsWith("workflow:")) return null;
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim() : "";
  const threadTs = typeof delivery.thread_ts === "string" ? delivery.thread_ts.trim() : "";
  if (!channel) return "workflow Slack delivery is missing delivery.channel";
  if (!/^(C|G|D)[A-Z0-9]+$/.test(channel)) {
    return `workflow Slack delivery must use a Slack channel id, got ${JSON.stringify(channel)}`;
  }
  if (!threadTs) return "workflow Slack delivery is missing delivery.thread_ts";
  return null;
}

function buildResponseFooter(
  ampThreadId: string | undefined,
  commitSha: string | undefined,
): string {
  const parts: string[] = [];
  if (ampThreadId) {
    parts.push(`[View in Amp](https://ampcode.com/threads/${encodeURIComponent(ampThreadId)})`);
    parts.push(`\`amp threads continue ${ampThreadId}\``);
  }
  if (commitSha) parts.push(`\`${commitSha.slice(0, 8)}\``);
  return parts.length ? `\n\n${parts.join(" · ")}` : "";
}

function buildResponseMetadataBlock(
  appName: string,
  ampThreadId: string | undefined,
  durStr: string,
): SlackBlock {
  return {
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [
        { type: "text", text: `${appName} · ` },
        ...(ampThreadId
          ? [{
              type: "link",
              url: `https://ampcode.com/threads/${encodeURIComponent(ampThreadId)}`,
              text: "agent",
            }]
          : [{ type: "text", text: "agent" }]),
        { type: "text", text: ` · ${durStr}` },
      ],
    }],
  };
}

type SlackBlocks = Extract<StreamChunk, { type: "blocks" }>["blocks"];

function splitSlackBlocks(blocks: SlackBlocks): SlackBlocks[] {
  return blocks.length ? [blocks] : [];
}

function expectedSlackFallbackReason(error: unknown): string | null {
  const classified = classifySlackError(error);
  if (
    !classified.retryable
    && (classified.errorClass === "invalid_destination" || classified.errorClass === "restricted_destination")
  ) {
    return classified.errorClass;
  }

  const errMsg = classified.message;
  if (errMsg.includes("message_not_in_streaming_state")) return "message_not_in_streaming_state";
  if (errMsg.includes("message_not_found")) return "message_not_found";
  if (errMsg.includes("msg_too_long")) return "msg_too_long";
  if (errMsg.includes("msg_blocks_too_long")) return "msg_blocks_too_long";
  if (errMsg.includes("streaming_mode_mismatch")) return "streaming_mode_mismatch";
  if (errMsg.includes("cannot_provide_both_markdown_text_and_chunks")) {
    return "streaming_payload_conflict";
  }
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface BotThread {
  id: string;
  subscribe(): Promise<void>;
  startTyping(status?: string): Promise<void>;
  stopTyping?(): Promise<void>;
  post(content: AsyncGenerator<StreamChunk> | PostPayload, options?: { taskDisplayMode?: "timeline" | "plan" }): Promise<{ id: string; edit(content: { markdown: string }): Promise<void> }>;
}

export interface PostPayload {
  markdown: string;
  files?: DashboardFileUpload[];
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
  postMessage(threadId: string, message: PostPayload): Promise<{ id: string }>;
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

  private readonly chartRenderer: ChartRenderer;

  private readonly assistantTitleUnsupported = new Set<string>();

  constructor(
    readonly client: CentaurClient,
    private viewerUrl = "",
    private slack?: SlackAdapter,
    private runtimeErrorChannelId = "",
  ) {
    this.chartRenderer = createChartRenderer(client);
  }

  static createFromEnv(slack?: SlackAdapter): SlackBot {
    return new SlackBot(
      new CentaurClient({
        apiUrl: process.env.CENTAUR_API_URL || "http://api:8000",
        apiKey: process.env.SLACKBOT_API_KEY || process.env.API_SECRET_KEY || "",
        logger: log,
      }),
      process.env.THREAD_VIEWER_URL || "",
      slack,
      process.env.RUNTIME_ERROR_ALERT_CHANNEL || "",
    );
  }

  startFinalDeliveryWorker() {
    if (!this.slack || this.finalDeliveryLoop) return;
    this.finalDeliveryLoop = this.runFinalDeliveryLoop();
  }

  hasInFlightExecution(threadId: string): boolean {
    return this.inFlightExecutions.has(normalizeThreadKey(threadId));
  }

  async waitForInFlightExecution(threadId: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.hasInFlightExecution(threadId)) return true;
      await sleep(50);
    }
    return this.hasInFlightExecution(threadId);
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
    const { selector: promptSelector, cleaned } = extractFlagSelector(richText);
    // If flag-stripping leaves only the bot mention or nothing, the agent gets
    // an empty text — never `--invest`. The bare-flag short-circuit below
    // catches the empty case before we reach the agent.
    const agentText = cleaned;

    // Bare-flag short-circuit: respond with the canned persona greeting
    // without spinning up an LLM. Guarantees the persona identifier appears
    // and saves a ~6s round-trip + token cost.
    const attachments = await this.resolveAttachments(thread.id, msg);
    const greeting = bareFlagGreeting(promptSelector, cleaned, attachments.length);
    if (greeting) {
      log.info("bare_flag_greeting", { thread_key: threadKey, selector: promptSelector });
      await thread.post({ markdown: greeting });
      return;
    }

    const messageId = stableSlackMessageId(msg);
    const historyMessages = await this.collectThreadHistory(thread.id, messageId);

    const parts = await this.toParts(agentText, attachments);
    await this.bufferAndExecuteSafely(thread, agentText, parts, {
      messageId,
      userId: msg.author.userId,
      teamId: slackTeamId(msg),
    }, promptSelector, historyMessages);
  }

  async onSubscribedMessage(thread: BotThread, msg: BotMessage) {
    if (msg.author.isMe || msg.author.isBot) return;

    const attachments = msg.isMention ? await this.resolveAttachments(thread.id, msg) : (msg.attachments || []);
    const text = richTextFromMessage(msg);
    if (!text && !attachments.length) return;

    if (msg.isMention) {
      const { selector: promptSelector, cleaned } = extractFlagSelector(text);
      const greeting = bareFlagGreeting(promptSelector, cleaned, attachments.length);
      if (greeting) {
        log.info("bare_flag_greeting", { thread_key: normalizeThreadKey(thread.id), selector: promptSelector, is_new_thread: false });
        await thread.post({ markdown: greeting });
        return;
      }
      const agentText = cleaned;
      const parts = await this.toParts(agentText || "Shared attachment in thread.", attachments);
      log.info("mention_received", { thread_key: normalizeThreadKey(thread.id), user_id: msg.author.userId, is_new_thread: false });
      thread.startTyping().catch(() => {});
      await this.bufferAndExecuteSafely(thread, agentText, parts, {
        messageId: stableSlackMessageId(msg),
        userId: msg.author.userId,
        teamId: slackTeamId(msg),
      }, promptSelector);
      return;
    }

    const parts = await this.toParts(text || "Shared attachment in thread.", attachments);

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

  private async bufferAndExecuteSafely(
    thread: BotThread,
    text: string,
    parts: InputContentBlock[],
    delivery: DeliveryContext,
    promptSelectorOverride?: string,
    historyMessages?: SlackHistoryWorkflowMessage[],
  ) {
    try {
      await this.bufferAndExecute(thread, text, parts, delivery, promptSelectorOverride, historyMessages);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const executionId = executionIdFromError(err);
      const code = conflictCode(err);
      log.error("execute_start_failed", {
        thread_key: normalizeThreadKey(thread.id),
        error,
        execution_id: executionId || undefined,
        conflict_code: code,
      });
      await thread.stopTyping?.();

      const executionStatus = executionId
        ? await this.getExecutionStatus(executionId)
        : null;
      if (executionStatus) {
        log.warn("execute_start_failure_suppressed", {
          thread_key: normalizeThreadKey(thread.id),
          execution_id: executionId,
          execution_status: executionStatus,
        });
        return;
      }

      await thread.post({ markdown: "Agent request failed before execution started. Please retry." });
    }
  }

  private async bufferAndExecute(
    thread: BotThread,
    text: string,
    parts: InputContentBlock[],
    delivery: DeliveryContext,
    promptSelectorOverride?: string,
    historyMessages?: SlackHistoryWorkflowMessage[],
  ) {
    const threadKey = normalizeThreadKey(thread.id);
    const promptSelector = promptSelectorOverride ?? parsePromptSelectorFlag(text);
    if (promptSelector) {
      await this.releaseForPromptSwitch(threadKey, delivery.messageId);
    } else {
      const steerResult = await this.steerOrCancelInflightExecution(threadKey, parts, delivery);
      if (steerResult === "steered" || steerResult === "cancelled") return;
    }
    const { channel, threadTs } = splitThreadKey(thread.id);
    const workflowInput = {
      thread_key: threadKey,
      parts,
      user_id: delivery.userId,
      message_id: delivery.messageId,
      history_messages: historyMessages || [],
      prompt_selector: promptSelector,
      delivery: {
        channel,
        thread_ts: threadTs,
        platform: "slack",
        recipient_user_id: delivery.userId,
        recipient_team_id: delivery.teamId,
      },
    };
    const triggerKey = delivery.messageId ? `slack-thread-turn:${threadKey}:${delivery.messageId}` : undefined;
    let accepted: Awaited<ReturnType<CentaurClient["startWorkflowRun"]>>;
    try {
      accepted = await this.client.startWorkflowRun({
        workflowName: "slack_thread_turn",
        triggerKey,
        eagerStart: true,
        input: workflowInput,
      });
    } catch (err) {
      if (triggerKey && isIdempotencyMismatch(err)) {
        log.warn("idempotency_mismatch_retry", {
          thread_key: threadKey,
          trigger_key: triggerKey,
        });
        accepted = await this.client.startWorkflowRun({
          workflowName: "slack_thread_turn",
          eagerStart: true,
          input: workflowInput,
        });
      } else {
        throw err;
      }
    }
    if (!accepted.execution_id) {
      const errorText = typeof accepted.error_text === "string"
        ? accepted.error_text.trim()
        : "";
      throw new Error(errorText || "workflow did not enqueue an execution");
    }
    try {
      await this.execute(thread, threadKey, {
        executionId: accepted.execution_id,
        userId: delivery.userId,
        teamId: delivery.teamId,
      });
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      (wrapped as Error & { executionId?: string }).executionId = accepted.execution_id;
      throw wrapped;
    }
  }

  private async releaseForPromptSwitch(threadKey: string, messageId?: string): Promise<void> {
    try {
      const releaseId = messageId
        ? `prompt-switch:${messageId}`
        : `prompt-switch:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      await this.client.releaseThread(threadKey, {
        releaseId,
        cancelInflight: true,
      });
      log.info("prompt_switch_released_assignment", {
        thread_key: threadKey,
        release_id: releaseId,
      });
    } catch (err) {
      log.warn("prompt_switch_release_failed", {
        thread_key: threadKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async execute(thread: BotThread, threadKey: string, opts: { assignmentGeneration?: number; executionId?: string; userId?: string; teamId?: string }) {
    const ac = new AbortController();

    const tracker = new ProgressTracker();
    const t0 = Date.now();
    let executionId = typeof opts.executionId === "string" ? opts.executionId : "";
    try {
      if (!executionId) {
        if (typeof opts.assignmentGeneration !== "number") {
          throw new Error("missing assignmentGeneration for direct execute path");
        }
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
      }
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

    let deliveredToSlack = false;
    let streamedReply: Awaited<ReturnType<BotThread["post"]>> | undefined;
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
          streamedReply = await thread.post(
            (async function* () {
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
        const classified = classifySlackError(err);

        // Slack killed the streaming state before we called stop() (long-running turn),
        // or the accumulated streamed text exceeded Slack's message length limit.
        // Some destinations also reject Slack's AI streaming APIs even though
        // plain chat.postMessage delivery still succeeds.
        // Fall back to posting a plain message with whatever result we accumulated,
        // or poll the API for the final result if we don't have one yet.
        const fallbackReason = expectedSlackFallbackReason(err);
        if (fallbackReason) {
          log.info("slack_stream_fallback", {
            thread_key: threadKey,
            reason: fallbackReason,
            error: classified.message,
            error_class: classified.errorClass,
            error_code: classified.code,
            status: classified.status,
            retryable: classified.retryable,
            execution_id: executionId,
          });
          let converted = await convertDashboardBlocks((tracker.resultText || tracker.lastAssistantText).trim(), { renderChart: this.chartRenderer });
          let fallback = rewriteSlackFileLinks(converted.markdown, tracker.repoContext);
          let footer = buildResponseFooter(tracker.agentThreadId, tracker.repoContext?.gitCommit);

          if (!fallback) {
            const polled = await this.pollForResult(executionId);
            converted = await convertDashboardBlocks(polled.text, { renderChart: this.chartRenderer });
            fallback = rewriteSlackFileLinks(converted.markdown, polled.repoContext);
            footer = buildResponseFooter(polled.agentThreadId, polled.repoContext?.gitCommit);
          }

          try {
            if (fallback) {
              const chunks = splitMarkdownForSlackMessages(`${fallback}${footer}`);
              for (let i = 0; i < chunks.length; i += 1) {
                const files = i === chunks.length - 1 && converted.files.length ? converted.files : undefined;
                await thread.post({ markdown: chunks[i], ...(files ? { files } : {}) });
              }
              deliveredToSlack = true;
            } else if (this.viewerUrl) {
              const viewerLink = `${this.viewerUrl}/${encodeURIComponent(normalizeThreadKey(threadKey))}`;
              await thread.post({ markdown: `Agent completed. [View full output](${viewerLink})` });
              deliveredToSlack = true;
            }
          } catch (fallbackErr) {
            const fallbackClassified = classifySlackError(fallbackErr);
            log.warn("slack_stream_fallback_post_failed", {
              thread_key: threadKey,
              execution_id: executionId,
              error: fallbackClassified.message,
              error_class: fallbackClassified.errorClass,
              error_code: fallbackClassified.code,
              status: fallbackClassified.status,
              retryable: fallbackClassified.retryable,
            });
          }
          if (deliveredToSlack) {
            await this.ackFinalDelivery(executionId, threadKey, { requireLease: false });
          }
          return;
        }

        log.error("execute_error", {
          thread_key: threadKey,
          error: classified.message,
          error_class: classified.errorClass,
          error_code: classified.code,
          status: classified.status,
          retryable: classified.retryable,
          execution_id: executionId,
        });
        try {
          await thread.post({ markdown: `Agent request failed: ${classified.message}` });
        } catch (postErr) {
          log.error("error_post_failed", { thread_key: threadKey, error: postErr instanceof Error ? postErr.message : String(postErr) });
        }
        return;
      }

      // Post any overflow chunks that didn't fit in the streaming message.
      for (let i = 0; i < tracker.overflowChunks.length; i += 1) {
        const chunk = tracker.overflowChunks[i];
        try {
          const files = i === tracker.overflowChunks.length - 1 && tracker.pendingFiles.length
            ? tracker.pendingFiles
            : undefined;
          await thread.post({ markdown: chunk, ...(files ? { files } : {}) });
          if (i === tracker.overflowChunks.length - 1) tracker.pendingFiles = [];
        } catch (err) {
          log.warn("overflow_post_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (tracker.pendingFiles.length > 0) {
        await thread.post({ markdown: " ", files: tracker.pendingFiles });
        tracker.pendingFiles = [];
      }

      const finalText = (tracker.resultText || tracker.lastAssistantText).trim();
      log.info("execute_complete", { thread_key: threadKey, duration_s: Math.round((Date.now() - t0) / 100) / 10, result_length: finalText.length, overflow_chunks: tracker.overflowChunks.length });

      if (streamedReply) {
        const streamedMarkdown = await this.renderStreamedExecutionMarkdown(finalText, tracker.agentThreadId, tracker.repoContext);
        const streamedBlocks = renderMarkdownForSlack(streamedMarkdown).blocks;
        if (streamedBlocks && tracker.overflowChunks.length === 0) {
          try {
            await streamedReply.edit({ markdown: streamedMarkdown });
          } catch (err) {
            const classified = classifySlackError(err);
            const expected = classified.errorClass === "invalid_payload"
              || classified.message.includes("msg_too_long")
              || classified.message.includes("msg_blocks_too_long");
            const logFn = expected ? log.info.bind(log) : log.warn.bind(log);
            logFn("streamed_reply_block_upgrade_failed", {
              thread_key: threadKey,
              execution_id: executionId,
              error: classified.message,
              error_class: classified.errorClass,
              error_code: classified.code,
              retryable: classified.retryable,
            });
          }
        }
      }

      if (deliveredToSlack) {
        await this.ackFinalDelivery(executionId, threadKey, { requireLease: false });
      }

      await this.setAssistantTitle(threadKey, {}, finalText);
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

  private async pollForResult(executionId: string): Promise<{ text: string; agentThreadId?: string; repoContext?: SlackRepoContext }> {
    const deadline = Date.now() + STREAM_EXPIRED_POLL_MAX_MS;
    while (Date.now() < deadline) {
      try {
        const data = await this.client.getExecution(executionId);
        const status = String(data.status || "");
        const agentThreadId = agentThreadIdFromRecord(data);
        const repoContext = repoContextFromExecutionRecord(data);
        const text = renderTerminalResultCopy({
          status,
          terminalReason: data.terminal_reason,
          resultText: data.result_text,
          errorText: data.error_text,
        });
        if (text) {
          return { text, agentThreadId, repoContext };
        }
      } catch {
        // best-effort — keep polling
      }
      await new Promise((r) => setTimeout(r, STREAM_EXPIRED_POLL_INTERVAL_MS));
    }
    return { text: "" };
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
      tracker.observeRepoContext(repoContextFromExecutionRecord(data));
      tracker.agentThreadId = agentThreadIdFromRecord(data) || tracker.agentThreadId;
      tracker.resultText = renderTerminalResultCopy({
        status,
        terminalReason,
        resultText: result,
        errorText: error,
      });
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

    const converted = await convertDashboardBlocks((tracker.resultText || tracker.lastAssistantText).trim(), {
      renderChart: this.chartRenderer,
    });
    const finalText = rewriteSlackFileLinks(converted.markdown, tracker.repoContext);
    tracker.pendingFiles = converted.files;
    if (finalText) {
      const dur = (Date.now() - t0) / 1000;
      const durStr = dur < 10 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`;
      const suffix = buildResponseFooter(tracker.agentThreadId, tracker.repoContext?.gitCommit);
      const fullMd = `${finalText}${suffix}`;
      yield {
        type: "blocks",
        blocks: [buildResponseMetadataBlock(process.env.APP_NAME || "Centaur", tracker.agentThreadId, durStr)],
      };

      const [firstMessageMarkdown, ...overflowMarkdown] = splitMarkdownForSlackMessages(fullMd, {
        firstMaxBlocks: SLACK_CONTENT_BLOCKS_WITH_CONTEXT,
      });
      const rendered = renderMarkdownForSlack(firstMessageMarkdown || fullMd);
      if (rendered.blocks) {
        for (const blocks of splitSlackBlocks(rendered.blocks)) {
          yield { type: "blocks", blocks };
        }
        tracker.overflowChunks = overflowMarkdown;
      } else {
        for (const chunk of splitSlackMessage(firstMessageMarkdown || fullMd, SLACK_STREAM_MARKDOWN_CHUNK_CHARS)) {
          yield { type: "markdown_text", text: chunk };
        }
        tracker.overflowChunks = overflowMarkdown;
      }
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
            // Keep Slack's stream alive without appending invisible markdown to
            // the assistant body. Slack renders repeated zero-width text
            // keepalives as blank lines on queued/long-running turns.
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
            tracker.observeRepoContext(normalizeRepoContext(payload));
            tracker.agentThreadId = agentThreadIdFromRecord(payload) || tracker.agentThreadId;
            const result = String(payload.result || "").trim();
            const errorText = String(payload.error || "").trim();
            const rendered = renderTerminalResultCopy({
              resultText: result,
              errorText,
              isError: payload.is_error,
            });
            if (rendered) tracker.resultText = rendered;
            terminal = true;
            break;
          }

          if (eventType === "execution.state") {
            const status = String(payload.status || "");
            tracker.agentThreadId = agentThreadIdFromRecord(payload) || tracker.agentThreadId;
            tracker.observeRepoContext(normalizeRepoContext(payload.repo_context));
            if (["completed", "failed_permanent", "cancelled"].includes(status)) {
              const rendered = renderTerminalResultCopy({
                status,
                terminalReason: payload.terminal_reason,
                resultText: payload.result_text,
                errorText: payload.error_text,
              });
              if (rendered) tracker.resultText = rendered;
              if (shouldNotifyRuntimeErrorChannel({
                status,
                terminalReason: payload.terminal_reason,
                resultText: payload.result_text,
                errorText: payload.error_text,
              })) {
                this.notifyRuntimeErrorChannel({
                  threadKey,
                  executionId,
                  status,
                  terminalReason: typeof payload.terminal_reason === "string" ? payload.terminal_reason : "",
                  errorText: typeof payload.error_text === "string" ? payload.error_text : "",
                  resultText: typeof payload.result_text === "string" ? payload.result_text : "",
                }).catch((err) => {
                  log.warn("runtime_error_alert_failed", {
                    thread_key: threadKey,
                    execution_id: executionId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              }
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

  private async getExecutionStatus(executionId: string): Promise<string | null> {
    try {
      const execution = await this.client.getExecution(executionId);
      const status = typeof execution.status === "string" ? execution.status.trim() : "";
      return status || "unknown";
    } catch {
      return null;
    }
  }

  private async failFinalDelivery(
    executionId: string,
    threadKey: string,
    error: string,
    opts?: { nonRetryable?: boolean; errorClass?: string },
  ): Promise<void> {
    try {
      await this.client.markFinalFailed(executionId, error, {
        consumerId: this.deliveryConsumerId,
        nonRetryable: opts?.nonRetryable,
        errorClass: opts?.errorClass,
      });
    } catch (err) {
      log.warn("final_delivery_fail_mark_failed", {
        thread_key: threadKey,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async steerOrCancelInflightExecution(
    threadKey: string,
    parts: InputContentBlock[],
    delivery: DeliveryContext,
  ): Promise<"none" | "steered" | "cancelled"> {
    const current = this.inFlightExecutions.get(threadKey);
    if (!current) return "none";

    // Try to steer the execution first — this preserves conversation context
    try {
      const result = await this.client.steerExecution(current.executionId, {
        contentBlocks: parts,
        messageId: delivery.messageId,
        userId: delivery.userId,
        metadata: {
          platform: "slack",
          ...(delivery.teamId ? { team_id: delivery.teamId } : {}),
        },
      });
      if (result.status === "steered") {
        log.info("steered_previous_execution", {
          thread_key: threadKey,
          execution_id: current.executionId,
          message_id: delivery.messageId,
        });
        return "steered";
      }
    } catch (err) {
      log.warn("steer_previous_execution_failed", {
        thread_key: threadKey,
        execution_id: current.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Abort the local SSE stream reader only when steering failed and we are
    // replacing the execution with a new workflow.
    this.inFlightExecutions.delete(threadKey);
    current.abortController.abort();

    // Fall back to hard cancel
    try {
      await this.client.cancelExecution(current.executionId);
    } catch (err) {
      log.warn("cancel_previous_execution_failed", {
        thread_key: threadKey,
        execution_id: current.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return "cancelled";
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
      try {
        await this.client.renewFinalDeliveryLease(executionId, {
          consumerId: this.deliveryConsumerId,
          leaseSeconds: FINAL_DELIVERY_LEASE_SECONDS,
        });
      } catch (err) {
        log.warn("final_delivery_defer_lease_refresh_failed", {
          execution_id: executionId,
          thread_key: threadKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Keep the claimed lease intact so the live stream can ack the same
      // outbox row on completion instead of racing a retry into a duplicate post.
      return;
    }

    if (await this.shouldSuppressFinalDelivery(threadKey, executionId, finalPayload)) {
      log.info("final_delivery_suppressed", {
        execution_id: executionId,
        thread_key: threadKey,
        status: finalPayload.status,
        terminal_reason: finalPayload.terminal_reason,
      });
      await this.ackFinalDelivery(executionId, threadKey);
      return;
    }

    const invalidDestination = invalidWorkflowSlackDestination(threadKey, delivery);
    if (invalidDestination) {
      log.warn("final_delivery_invalid_destination_config", {
        execution_id: executionId,
        thread_key: threadKey,
        error: invalidDestination,
        channel: delivery.channel,
      });
      await this.failFinalDelivery(executionId, threadKey, invalidDestination, {
        nonRetryable: true,
        errorClass: "invalid_destination",
      });
      return;
    }

    const { markdown, files } = await this.renderFinalDeliveryMarkdown(threadKey, finalPayload);

    // Notify runtime error alert channel (fire-and-forget)
    const fpStatus = typeof finalPayload.status === "string" ? finalPayload.status : "";
    const fpTerminalReason = typeof finalPayload.terminal_reason === "string" ? finalPayload.terminal_reason : "";
    const fpErrorText = typeof finalPayload.error_text === "string" ? finalPayload.error_text : "";
    const fpResultText = typeof finalPayload.result_text === "string" ? finalPayload.result_text : "";
    if (shouldNotifyRuntimeErrorChannel({
      status: fpStatus,
      terminalReason: fpTerminalReason,
      resultText: fpResultText,
      errorText: fpErrorText,
    })) {
      this.notifyRuntimeErrorChannel({
        threadKey,
        executionId,
        status: fpStatus,
        terminalReason: fpTerminalReason,
        errorText: fpErrorText,
        resultText: fpResultText,
      }).catch((err) => {
        log.warn("runtime_error_alert_failed", {
          thread_key: threadKey,
          execution_id: executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    try {
      await this.postSlackMarkdown(threadKey, delivery, markdown, files);
      await this.ackFinalDelivery(executionId, threadKey);
      await this.setAssistantTitle(threadKey, delivery, markdown);
      log.info("final_delivery_completed", { thread_key: threadKey, execution_id: executionId });
    } catch (err) {
      let error = err instanceof Error ? err.message : String(err);
      if (isSlackInvalidBlocksError(error)) {
        const fallbackMarkdown = flattenMarkdownTables(markdown);
        if (fallbackMarkdown !== markdown) {
          try {
            log.info("final_delivery_retry_plaintext", {
              execution_id: executionId,
              thread_key: threadKey,
            });
            await this.postSlackMarkdown(threadKey, delivery, fallbackMarkdown, files);
            await this.ackFinalDelivery(executionId, threadKey);
            await this.setAssistantTitle(threadKey, delivery, fallbackMarkdown);
            log.info("final_delivery_completed", {
              thread_key: threadKey,
              execution_id: executionId,
              downgraded_tables: true,
            });
            return;
          } catch (fallbackErr) {
            error = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          }
        }
      }
      const classified = classifySlackError(error);
      log.warn("final_delivery_post_failed", {
        execution_id: executionId,
        thread_key: threadKey,
        error: classified.message,
        error_class: classified.errorClass,
        error_code: classified.code,
        status: classified.status,
        retryable: classified.retryable,
      });
      await this.failFinalDelivery(executionId, threadKey, classified.message, {
        nonRetryable: !classified.retryable,
        errorClass: classified.errorClass,
      });
    }
  }

  private async notifyRuntimeErrorChannel(opts: {
    threadKey: string;
    executionId: string;
    status: string;
    terminalReason: string;
    errorText: string;
    resultText: string;
  }): Promise<void> {
    if (!this.runtimeErrorChannelId || !this.slack) return;
    try {
      const summary = `⚠️ Agent hit a runtime issue before finishing\n*Thread:* \`${opts.threadKey}\`  |  *Execution:* \`${opts.executionId}\``;
      const { id: alertTs } = await this.slack.postMessage(
        `slack:${this.runtimeErrorChannelId}`,
        { markdown: summary },
      );
      const detail = buildRuntimeErrorDetail(opts);
      if (detail) {
        await this.slack.postMessage(
          `slack:${this.runtimeErrorChannelId}:${alertTs}`,
          { markdown: detail },
        );
      }
    } catch (err) {
      log.warn("runtime_error_channel_post_failed", {
        thread_key: opts.threadKey,
        execution_id: opts.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
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

  private async shouldSuppressFinalDelivery(
    threadKey: string,
    executionId: string,
    finalPayload: Record<string, unknown>,
  ): Promise<boolean> {
    const status = typeof finalPayload.status === "string" ? finalPayload.status : "";
    const terminalReason = typeof finalPayload.terminal_reason === "string"
      ? finalPayload.terminal_reason
      : "";
    const resultText = normalizedTerminalString(finalPayload.result_text);
    const errorText = normalizedTerminalString(finalPayload.error_text);
    if (!isCancellationTerminalState(status, terminalReason, resultText, errorText)) {
      return false;
    }

    const current = this.inFlightExecutions.get(threadKey);
    if (current && current.executionId !== executionId && !current.abortController.signal.aborted) {
      return true;
    }

    try {
      const { executions } = await this.client.listExecutions(threadKey, 2);
      const latestExecutionId = Array.isArray(executions) && typeof executions[0]?.execution_id === "string"
        ? executions[0].execution_id
        : "";
      return Boolean(latestExecutionId && latestExecutionId !== executionId);
    } catch (err) {
      log.warn("final_delivery_suppress_lookup_failed", {
        thread_key: threadKey,
        execution_id: executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async renderFinalDeliveryMarkdown(threadKey: string, finalPayload: Record<string, unknown>): Promise<{ markdown: string; files: DashboardFileUpload[] }> {
    const status = typeof finalPayload.status === "string" ? finalPayload.status : "";
    const terminalReason = typeof finalPayload.terminal_reason === "string"
      ? finalPayload.terminal_reason
      : "";
    const resultText = typeof finalPayload.result_text === "string" ? finalPayload.result_text.trim() : "";
    const errorText = typeof finalPayload.error_text === "string" ? finalPayload.error_text.trim() : "";
    const converted = await convertDashboardBlocks(renderTerminalResultCopy({
      status,
      terminalReason,
      resultText,
      errorText,
    }), { renderChart: this.chartRenderer });
    const repoCtx = normalizeRepoContext(finalPayload.repo_context);
    const rendered = rewriteSlackFileLinks(converted.markdown, repoCtx);
    const viewerSuffix = buildResponseFooter(agentThreadIdFromRecord(finalPayload), repoCtx.gitCommit);

    if (rendered) {
      return { markdown: `${rendered}${viewerSuffix}`, files: converted.files };
    }

    if (this.viewerUrl) {
      return { markdown: `Agent completed. [View full output](${this.viewerUrl}/${encodeURIComponent(threadKey)})`, files: converted.files };
    }

    return { markdown: "Agent completed with no output.", files: converted.files };
  }

  private async renderStreamedExecutionMarkdown(
    text: string,
    ampThreadId: string | undefined,
    repoContext?: SlackRepoContext,
  ): Promise<string> {
    const converted = await convertDashboardBlocks(text.trim());
    const rendered = rewriteSlackFileLinks(
      converted.markdown,
      repoContext,
    );
    if (!rendered) return "";
    const viewerSuffix = buildResponseFooter(ampThreadId, repoContext?.gitCommit);
    return `${rendered}${viewerSuffix}`;
  }

  private async postSlackMarkdown(
    threadKey: string,
    delivery: Record<string, unknown>,
    markdown: string,
    files: DashboardFileUpload[] = [],
  ): Promise<void> {
    const targetThreadId = slackDeliveryThreadId(threadKey, delivery);
    await this.withSlackDeliveryContext(delivery, async () => {
      const chunks = splitMarkdownForSlackMessages(markdown, { maxBlocks: 49 });
      for (let i = 0; i < chunks.length; i += 1) {
        const chunkFiles = i === chunks.length - 1 && files.length ? files : undefined;
        const chunkMarkdown = chunks.length > 1
          ? `Part ${i + 1}/${chunks.length}\n\n${chunks[i]}`
          : chunks[i];
        await this.slack!.postMessage(targetThreadId, {
          markdown: chunkMarkdown,
          ...(chunkFiles ? { files: chunkFiles } : {}),
        });
      }
    });
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

  private async setAssistantTitle(
    threadKey: string,
    delivery: Record<string, unknown>,
    title: string,
  ): Promise<void> {
    if (!this.slack || !title.trim()) return;

    const targetThreadId = slackDeliveryThreadId(threadKey, delivery);
    const { channel, threadTs } = splitThreadKey(targetThreadId);
    const unsupportedKey = `${channel}:${threadTs}`;
    if (this.assistantTitleUnsupported.has(unsupportedKey)) {
      return;
    }

    try {
      await this.slack.setAssistantTitle(channel, threadTs, title.slice(0, 60));
    } catch (err) {
      const classified = classifySlackError(err);
      if (!classified.retryable && classified.errorClass === "restricted_destination") {
        this.assistantTitleUnsupported.add(unsupportedKey);
        log.info("set_title_skipped", {
          thread_key: threadKey,
          error: classified.message,
          error_class: classified.errorClass,
          error_code: classified.code,
          status: classified.status,
          retryable: classified.retryable,
        });
        return;
      }
      log.warn("set_title_failed", {
        thread_key: threadKey,
        error: classified.message,
        error_class: classified.errorClass,
        error_code: classified.code,
        status: classified.status,
        retryable: classified.retryable,
      });
    }
  }

  /** Fetch prior thread messages for workflow-owned durable backfill. */
  private async collectThreadHistory(threadId: string, currentMessageId?: string): Promise<SlackHistoryWorkflowMessage[]> {
    if (!this.slack) return [];
    const threadKey = normalizeThreadKey(threadId);
    try {
      const { messages } = await this.slack.fetchMessages(threadId, { direction: "forward" });
      const history: SlackHistoryWorkflowMessage[] = [];
      for (const m of messages) {
        if (m.author.isMe || m.author.isBot) continue;
        const messageId = stableSlackMessageId(m);
        if (!messageId || messageId === currentMessageId) continue;
        if (currentMessageId && compareSlackMessageIds(messageId, currentMessageId) >= 0) continue;
        const text = richTextFromMessage(m);
        const attachments = m.attachments || [];
        if (!text && !attachments.length) continue;
        const parts = await this.toParts(text || "Shared attachment in thread.", attachments);
        history.push({
          message_id: messageId,
          parts,
          user_id: m.author.userId,
          metadata: { platform: "slack", history_backfill: true },
        });
      }
      if (history.length) {
        log.info("thread_history_collected", { thread_key: threadKey, count: history.length });
      }
      return history;
    } catch (err) {
      log.warn("thread_history_collect_failed", { thread_key: threadKey, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  async resolveAttachments(threadId: string, msg: BotMessage): Promise<BotAttachment[]> {
    if (msg.attachments?.length) return [...msg.attachments];
    const ts = msg.id || msg.raw?.ts || "";
    if (!ts || !this.slack) return [];
    // Slack's app_mention event doesn't include files. The file may not be
    // available on the message immediately, so retry with backoff to allow
    // Slack to finish processing the upload.
    const delays = [1_000, 2_000];
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) await sleep(delays[attempt - 1]);
      try {
        const refetched = await this.slack.fetchMessage(threadId, ts);
        if (refetched?.attachments?.length) {
          log.info("mention_files_refetched", { thread_key: normalizeThreadKey(threadId), count: refetched.attachments.length, attempt: attempt + 1 });
          return [...refetched.attachments];
        }
      } catch (err) {
        log.warn("mention_files_refetch_failed", { thread_key: normalizeThreadKey(threadId), error: err instanceof Error ? err.message : String(err), attempt: attempt + 1 });
      }
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
