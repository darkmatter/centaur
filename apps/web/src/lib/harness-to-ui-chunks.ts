/**
 * Convert canonical harness events into UI Message Stream protocol chunks.
 *
 * Replaces `_ui_stream_chunks_for_event()` from the Python backend
 * (`src/api/routers/threads.py`), enabling the Next.js webapp to process
 * raw harness events directly.
 */

import { asList, asString, asRecord } from "@/lib/parse-utils";
import { normalizeHarnessEvent, type CanonicalEvent } from "@/lib/normalize-harness-event";

// ---------------------------------------------------------------------------
// Chunk type — a superset of UIMessageChunk from "ai" to include custom
// data-* chunks that the thread viewer uses.
// ---------------------------------------------------------------------------

export type StreamChunk = Record<string, unknown> & { type: string };

export interface ConversionState {
  handoffToolCallIds: Set<string>;
  handoffInputs: Map<string, { follow: boolean; goal: string }>;
}

export function createConversionState(): ConversionState {
  return {
    handoffToolCallIds: new Set(),
    handoffInputs: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHandoffThreadKey(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const key =
        parsed.newThreadID ||
        parsed.new_thread_key ||
        parsed.thread_key ||
        parsed.slack_thread_key ||
        parsed.newThreadId;
      if (typeof key === "string" && key) return key;
    }
  } catch {
    // not JSON, fall through
  }
  const match = text.match(
    /(?:new_thread_key|thread_key|slack_thread_key|newThreadID|newThreadId)\s*[:=]\s*["']?([^\s"',}]+)/,
  );
  return match?.[1] || "";
}

function coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (typeof value === "number" && value >= 0) return Math.floor(value);
  return 0;
}

function normalizeSubagentActivities(value: unknown) {
  const normalized = asList(value)
    .map((entry) => {
      const record = asRecord(entry);
      const description = asString(record.description).trim();
      if (!description) return null;
      const toolName = asString(record.toolName || record.tool_name).trim();
      return toolName ? { description, toolName } : { description };
    })
    .filter((entry): entry is { description: string; toolName?: string } => entry !== null);
  return normalized.length > 0 ? normalized : null;
}

function coerceOptionalNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

function usageChunkData(
  usage: Record<string, unknown>,
  model?: string | null,
  authoritative?: boolean,
) {
  const inputTokens = coerceOptionalNonNegativeInt(usage.input_tokens);
  const outputTokens = coerceOptionalNonNegativeInt(usage.output_tokens);
  const totalTokens =
    coerceOptionalNonNegativeInt(usage.total_tokens) ??
    ((inputTokens ?? 0) + (outputTokens ?? 0) || null);
  if (!totalTokens || totalTokens <= 0) return null;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd:
      typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd)
        ? usage.cost_usd
        : null,
    quality: authoritative ? "authoritative" : "estimated",
    breakdown:
      inputTokens !== null || outputTokens !== null ? "known" : "unknown",
    models: model ? [model] : [],
  };
}

function agentStatusText(event: CanonicalEvent): string | null {
  if (event.type === "reasoning") return "Thinking";
  if (event.type === "command_execution") {
    return String(event.status).trim().toLowerCase() === "running"
      ? "Running shell command"
      : "Ran shell command";
  }
  if (event.type === "file_change") return "Applying file changes";
  if (event.type === "subagent") {
    if (event.activity?.trim()) return event.activity.trim();
    if (event.status === "started" && event.name?.trim()) {
      return `Starting ${event.name.trim()}`;
    }
    if (event.status === "working" && event.name?.trim()) {
      return `Running ${event.name.trim()}`;
    }
    if (event.status === "failed") {
      return event.error?.trim() || "Subagent failed";
    }
  }
  if (event.type === "assistant") {
    const firstToolUse = event.message?.content.find(
      (block) => block.type === "tool_use",
    );
    if (firstToolUse?.name?.trim()) {
      return `Using ${firstToolUse.name.trim().replace(/[_-]+/g, " ")}`;
    }
  }
  if (event.type === "result") return "Completed";
  return null;
}

// ---------------------------------------------------------------------------
// Core conversion: canonical event → stream chunks
// ---------------------------------------------------------------------------

export function canonicalEventToStreamChunks(
  turnId: number,
  eventIndex: number,
  event: CanonicalEvent,
  state?: ConversionState,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const rawEvent = event as unknown as Record<string, unknown>;
  const statusText = agentStatusText(event);
  if (statusText) {
    chunks.push({
      type: "data-agent-status",
      id: `turn-${turnId}-status-${eventIndex}`,
      data: { text: statusText },
    });
  }

  if (event.type === "assistant") {
    const content = event.message?.content ?? [];
    for (let ci = 0; ci < content.length; ci++) {
      const block = content[ci];
      if (block.type === "text" && block.text.trim()) {
        const textId = `turn-${turnId}-text-${eventIndex}-${ci}`;
        chunks.push({ type: "text-start", id: textId });
        chunks.push({ type: "text-delta", id: textId, delta: block.text });
        chunks.push({ type: "text-end", id: textId });
      } else if (block.type === "tool_use") {
        const toolCallId = block.id.trim() || `turn-${turnId}-tool-${eventIndex}-${ci}`;
        chunks.push({
          type: "tool-input-available",
          toolCallId,
          toolName: block.name || "tool",
          input: block.input || {},
        });
        if (block.name === "handoff" && state) {
          state.handoffToolCallIds.add(toolCallId);
          const input = block.input as { goal?: string; follow?: boolean };
          if (input.follow) {
            state.handoffInputs.set(toolCallId, {
              follow: true,
              goal: input.goal || "",
            });
          }
        }
      }
    }
    const assistantUsage = asRecord((event.message as Record<string, unknown> | undefined)?.usage);
    const assistantModel = asString(
      (event.message as Record<string, unknown> | undefined)?.model,
    ).trim();
    const assistantUsageData = usageChunkData(
      assistantUsage,
      assistantModel || null,
      false,
    );
    if (assistantUsageData) {
      chunks.push({
        type: "data-token-usage",
        id: `turn-${turnId}-usage-${eventIndex}`,
        data: assistantUsageData,
      });
    }
  } else if (event.type === "tool") {
    for (const block of event.content ?? []) {
      const toolCallId = (block.tool_use_id ?? "").toString().trim();
      if (!toolCallId) continue;
      chunks.push({
        type: "tool-output-available",
        toolCallId,
        output: block.content,
      });
      if (state?.handoffToolCallIds.has(toolCallId)) {
        const input = state.handoffInputs.get(toolCallId);
        if (input?.follow) {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          const newThreadKey = extractHandoffThreadKey(resultText);
          if (newThreadKey) {
            chunks.push({
              type: "data-handoff",
              data: {
                new_thread_key: newThreadKey,
                follow: true,
                goal: input.goal,
              },
            });
          }
        }
      }
    }
  } else if (event.type === "reasoning") {
    const reasoningId = `turn-${turnId}-reasoning-${eventIndex}`;
    chunks.push({ type: "reasoning-start", id: reasoningId });
    chunks.push({ type: "reasoning-delta", id: reasoningId, delta: event.text || "" });
    chunks.push({ type: "reasoning-end", id: reasoningId });
  } else if (event.type === "file_change") {
    chunks.push({
      type: "data-file-changes",
      id: `turn-${turnId}-file-change-${eventIndex}`,
      data: { changes: event.changes ?? [] },
    });
  } else if (event.type === "command_execution") {
    chunks.push({
      type: "data-shell-command",
      id: `turn-${turnId}-command-${eventIndex}`,
      data: {
        command: event.command || "",
        output: event.aggregated_output || "",
        exitCode: event.exit_code,
        status: event.status,
      },
    });
  } else if (event.type === "subagent") {
    const subagentId = event.subagent_id || "";
    const status = event.status || "";
    if (!status) return chunks;
    const raw = event as unknown as Record<string, unknown>;
    const inputTokensRaw = raw.input_tokens;
    const outputTokensRaw = raw.output_tokens;
    const inputTokens =
      inputTokensRaw !== undefined && inputTokensRaw !== null
        ? coerceNonNegativeInt(inputTokensRaw)
        : null;
    const outputTokens =
      outputTokensRaw !== undefined && outputTokensRaw !== null
        ? coerceNonNegativeInt(outputTokensRaw)
        : null;
    const totalTokensRaw = raw.total_tokens;
    let totalTokens: number | null;
    if (totalTokensRaw !== undefined && totalTokensRaw !== null) {
      totalTokens = coerceNonNegativeInt(totalTokensRaw);
    } else if (inputTokens !== null || outputTokens !== null) {
      totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    } else {
      totalTokens = null;
    }
    const modelName = asString(raw.model).trim() || null;
    const activity = asString(raw.activity).trim() || null;
    const activities = normalizeSubagentActivities(raw.activities);
    const stableId = subagentId || `turn-${turnId}-subagent-${eventIndex}`;
    chunks.push({
      type: "data-subagent",
      id: `turn-${turnId}-subagent-${stableId}-${status}`,
      data: {
        subagent_id: subagentId || null,
        phase: asString(raw.phase).trim() || null,
        status,
        name: raw.name ?? null,
        summary: raw.summary ?? null,
        error: raw.error ?? null,
        activity,
        activities,
        tool_name: asString(raw.tool_name || raw.toolName).trim() || null,
        branch_index: raw.branch_index ?? null,
        total_branches: raw.total_branches ?? null,
        completed: raw.completed ?? null,
        acceptable: raw.acceptable ?? null,
        failed: raw.failed ?? null,
        completed_count: raw.completed_count ?? null,
        acceptable_count: raw.acceptable_count ?? null,
        failed_count: raw.failed_count ?? null,
        is_acceptable: raw.is_acceptable ?? null,
        turns: raw.turns ?? null,
        tool_calls: raw.tool_calls ?? null,
        duration_s: raw.duration_s ?? null,
        max_parallel: raw.max_parallel ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_usd: typeof raw.cost_usd === "number" ? raw.cost_usd : null,
        model: modelName,
        event_seq:
          typeof raw.event_seq === "number" && Number.isFinite(raw.event_seq)
            ? raw.event_seq
            : null,
      },
    });
  } else if (event.type === "system") {
    const title =
      event.subtype === "init"
        ? "Session connected"
        : event.subtype.replace(/[_-]+/g, " ");
    const text =
      event.subtype === "init"
        ? event.session_id
          ? `Attached to session ${event.session_id}.`
          : "Attached to agent session."
        : `System event: ${event.subtype}`;
    chunks.push({
      type: "data-system-event",
      id: `turn-${turnId}-system-${eventIndex}`,
      data: { title, text, tone: "info" },
    });
  } else if (event.type === "usage") {
    const usageData = usageChunkData(
      asRecord(event.usage),
      event.model ?? null,
      event.authoritative,
    );
    if (usageData) {
      chunks.push({
        type: "data-token-usage",
        id: `turn-${turnId}-usage-${eventIndex}`,
        data: usageData,
      });
    }
  } else if (event.type === "error") {
    chunks.push({ type: "error", errorText: event.error || "" });
  } else if (event.type === "result") {
    const text = event.text || "";
    if (text) {
      const textId = `turn-${turnId}-result-${eventIndex}`;
      chunks.push({ type: "text-start", id: textId });
      chunks.push({ type: "text-delta", id: textId, delta: text });
      chunks.push({ type: "text-end", id: textId });
    }
  }

  const passthroughUsageData = usageChunkData(
    asRecord(rawEvent.usage),
    asString(rawEvent.model).trim() || null,
    Boolean(rawEvent.authoritative),
  );
  if (
    passthroughUsageData &&
    !chunks.some((chunk) => chunk.type === "data-token-usage")
  ) {
    chunks.push({
      type: "data-token-usage",
      id: `turn-${turnId}-usage-${eventIndex}`,
      data: passthroughUsageData,
    });
  }

  for (const chunk of chunks) {
    chunk.turnId = turnId;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// End-to-end: raw harness JSON → UI chunks
// ---------------------------------------------------------------------------

export function harnessEventToUiChunks(
  harness: string,
  rawEvent: Record<string, unknown>,
  turnId: number = 0,
  eventIndex: number = 0,
  state?: ConversionState,
): StreamChunk[] {
  const canonical = normalizeHarnessEvent(harness, rawEvent);
  const chunks: StreamChunk[] = [];
  for (let i = 0; i < canonical.length; i++) {
    const eventChunks = canonicalEventToStreamChunks(turnId, eventIndex + i, canonical[i], state);
    chunks.push(...eventChunks);
  }
  return chunks;
}
