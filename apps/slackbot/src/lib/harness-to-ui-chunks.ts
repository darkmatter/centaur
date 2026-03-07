/**
 * Convert canonical harness events into UI Message Stream protocol chunks.
 *
 * Replaces `_ui_stream_chunks_for_event()` from the Python backend
 * (`src/api/routers/threads.py`), enabling the Next.js webapp to process
 * raw harness events directly.
 */

import { asString, asRecord } from "@/lib/parse-utils";
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
        cost_usd: null,
        model: modelName,
      },
    });
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
