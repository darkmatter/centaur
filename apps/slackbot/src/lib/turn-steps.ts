/**
 * Convert Postgres turns directly into Step[] for rendering in ActivityFeed.
 *
 * This avoids the SSE round-trip for historical/idle threads — we interpret
 * turn.events client-side using the same logic the backend uses when building
 * UI stream chunks.
 */
import type { LucideIcon } from "lucide-react";
import {
  categorizeToolCall,
  summarizeGroup,
  type ContextMessageItem,
  type Step,
  type ToolCall,
} from "@/lib/describe";
import { asBoolean, asNumber } from "@/lib/parse-utils";
import { dedupeSources, extractSourcesFromUnknown, type StepSource } from "@/lib/source-utils";
import type { Turn } from "@/lib/types";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outputToText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const textParts = output
      .map((item) => asRecord(item))
      .filter((item) => asString(item.type) === "text" && asString(item.text))
      .map((item) => asString(item.text));
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function toolFingerprint(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableSerialize(input)}`;
}

function eventSeqFromEvent(event: Record<string, unknown>): number | undefined {
  const direct = asNumber(event.event_seq ?? event.eventSeq);
  if (direct !== null && direct > 0) return direct;
  return undefined;
}

function normalizeToolUiState(
  hasError: boolean,
  hasOutput: boolean,
): NonNullable<ToolCall["uiState"]> {
  if (hasError) return "output-error";
  if (hasOutput) return "output-available";
  return "input-available";
}

function legacyToolState(state: NonNullable<ToolCall["uiState"]>): ToolCall["state"] {
  if (state === "output-error" || state === "output-denied") return "error";
  if (state === "output-available" || state === "approval-responded") return "done";
  return "loading";
}

/** Parse a "[phase]" label from the beginning of a user message. */
function parsePhaseLabel(message: string): string | null {
  if (!message.startsWith("[")) return null;
  const closing = message.indexOf("]");
  if (closing <= 1) return null;
  return message.slice(1, closing).trim().toLowerCase() || null;
}

/** Strip internal context headers from user messages for display. */
function displayUserMessage(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) return "";
  const contextHeader =
    "Additional Slack thread context since the last AI instruction (ambient discussion from humans):";
  const contextIdx = cleaned.indexOf(contextHeader);
  if (contextIdx >= 0) {
    cleaned = cleaned.slice(0, contextIdx).trimEnd();
    if (cleaned.endsWith("---")) {
      cleaned = cleaned.slice(0, -3).trimEnd();
    }
  }
  if (cleaned.includes("# Session Context") && cleaned.includes("---")) {
    const tail = cleaned.split("---").pop()?.trim();
    if (tail) return tail;
  }
  if (cleaned.includes("---")) {
    cleaned = cleaned.split("---")[0].trim();
  }
  return cleaned;
}

export function stepsFromTurns(turns: Turn[]): Step[] {
  const steps: Step[] = [];
  let pendingGroup: {
    id: string;
    category: string;
    icon: LucideIcon;
    calls: ToolCall[];
    turnId: number;
  } | null = null;

  const flushGroup = () => {
    if (!pendingGroup || pendingGroup.calls.length === 0) return;
    steps.push({
      id: pendingGroup.id,
      type: "tool-group",
      icon: pendingGroup.icon,
      category: pendingGroup.category,
      summary: summarizeGroup(pendingGroup.category, pendingGroup.calls),
      calls: pendingGroup.calls,
      turnId: pendingGroup.turnId,
    });
    pendingGroup = null;
  };

  // O(1) lookups for tool call tracking and step-by-id updates
  const toolInputById = new Map<string, ToolCall>();
  const pendingToolIdsByFingerprint = new Map<string, string[]>();
  const terminalStepById = new Map<string, Step & { type: "terminal" }>();
  const diffStepById = new Map<string, Step & { type: "diff" }>();
  const contextGroupById = new Map<string, Step & { type: "context-group" }>();

  for (const turn of turns) {
    const turnId = turn.turn_id;
    flushGroup();
    const turnStartIndex = steps.length;
    const turnSources: StepSource[] = [];

    // Phase label from user message
    const phase = parsePhaseLabel(turn.user_message || "");
    if (phase) {
      flushGroup();
      steps.push({ id: `phase:turn-${turnId}:${phase}`, type: "phase", phase, turnId });
    }

    // Process events
    const events = turn.events || [];

    // User message — prefer the thread.message command event in the events array
    // (it has source/userId metadata). Only emit from turn.user_message as fallback.
    const hasCommandEvent = events.some(
      (e) => asRecord(e).type === "thread.message" && asRecord(e).message_type === "command",
    );
    if (!hasCommandEvent) {
      const userText = displayUserMessage(turn.user_message || "");
      if (userText) {
        flushGroup();
        steps.push({
          id: `user:turn-${turnId}`,
          type: "user-message",
          text: userText,
          userId: turn.user_id,
          turnId,
        });
      }
    }

    // Pre-scan: check if this turn has assistant text so we can skip
    // duplicate result events (the harness emits both).
    const turnHasAssistantText = events.some((raw) => {
      const e = asRecord(raw);
      if (asString(e.type) !== "assistant") return false;
      const content = (asRecord(e.message).content as unknown[]) || [];
      return content.some((b) => {
        const block = asRecord(b);
        return asString(block.type) === "text" && asString(block.text).trim();
      });
    });

    const findPendingToolCallIdByName = (toolName: string): string => {
      const calls = Array.from(toolInputById.values());
      for (let idx = calls.length - 1; idx >= 0; idx -= 1) {
        const call = calls[idx];
        if (call.name === toolName && (call.state === "loading" || !call.state)) {
          return call.id;
        }
      }
      return "";
    };

    for (let ei = 0; ei < events.length; ei++) {
      const event = asRecord(events[ei]);
      const eventType = asString(event.type);
      const eventSeq = eventSeqFromEvent(event);

      if (eventType === "assistant") {
        const content = (asRecord(event.message).content as unknown[]) || [];
        for (let ci = 0; ci < content.length; ci++) {
          const block = asRecord(content[ci]);
          const blockType = asString(block.type);

          if (blockType === "text") {
            const text = asString(block.text).trim();
            if (!text) continue;
            flushGroup();
            steps.push({
              id: `result:turn-${turnId}-${ei}-${ci}`,
              type: "result",
              text,
              streaming: false,
              sources: turnSources.length > 0 ? dedupeSources(turnSources) : undefined,
              eventSeq,
              turnId,
            });
          } else if (blockType === "thinking") {
            const text = asString(block.thinking).trim();
            if (!text) continue;
            flushGroup();
            steps.push({
              id: `thinking:turn-${turnId}-${ei}-${ci}`,
              type: "thinking",
              text,
              streaming: false,
              eventSeq,
              turnId,
            });
          } else if (blockType === "tool_use") {
            const toolCallId =
              asString(block.id).trim() || `turn-${turnId}-tool-${ei}-${ci}`;
            const toolName = asString(block.name) || "tool";
            const input = asRecord(block.input);

            if (toolName === "str_replace") {
              flushGroup();
              const path = asString(input.path);
              const ext = path.split(".").pop()?.toLowerCase();
              const diffStep: Step & { type: "diff" } = {
                id: `diff:${toolCallId}`,
                type: "diff",
                file: path,
                lang: ext || "txt",
                oldStr: asString(input.old ?? input.old_str),
                newStr: asString(input.new ?? input.new_str),
                eventSeq,
                turnId,
              };
              steps.push(diffStep);
              diffStepById.set(toolCallId, diffStep);
              // Track for potential output
              toolInputById.set(toolCallId, {
                id: toolCallId,
                name: toolName,
                input,
                uiState: "input-available",
                state: "loading",
              });
              continue;
            }

            if (toolName === "shell" || toolName === "bash") {
              flushGroup();
              const termStep = {
                id: `terminal:${toolCallId}`,
                type: "terminal" as const,
                description: "Ran shell command",
                command: asString(input.command),
                eventSeq,
                streaming: true,
                turnId,
              };
              steps.push(termStep);
              terminalStepById.set(toolCallId, termStep);
              toolInputById.set(toolCallId, {
                id: toolCallId,
                name: toolName,
                input,
                uiState: "input-available",
                state: "loading",
              });
              continue;
            }

            const call: ToolCall = {
              id: toolCallId,
              name: toolName,
              input,
              uiState: "input-available",
              state: "loading",
            };
            if (toolName === "web_fetch") {
              const inputUrl = asString(input.url);
              if (inputUrl) {
                call.sources = [{ url: inputUrl, title: inputUrl }];
                turnSources.push({ url: inputUrl, title: inputUrl });
              }
            }
            toolInputById.set(toolCallId, call);

            const { icon, category } = categorizeToolCall(toolName);
            if (pendingGroup && pendingGroup.category === category) {
              pendingGroup.calls.push(call);
            } else {
              flushGroup();
              pendingGroup = {
                id: `tool-group:${toolCallId}:${category}`,
                category,
                icon,
                calls: [call],
                turnId,
              };
            }
          }
        }
      } else if (eventType === "tool") {
        const blocks = (event.content as unknown[]) || [];
        for (const rawBlock of blocks) {
          const block = asRecord(rawBlock);
          const toolCallId = asString(block.tool_use_id).trim();
          if (!toolCallId) continue;
          const tracked = toolInputById.get(toolCallId);
          const isError = asBoolean(block.is_error) === true;
          const blockOutput = outputToText(block.content);
          const extractedSources = extractSourcesFromUnknown(block.content);
          if (extractedSources.length > 0) {
            turnSources.push(...extractedSources);
          }
          if (tracked) {
            tracked.output = isError ? undefined : blockOutput;
            tracked.errorText = isError ? blockOutput : undefined;
            tracked.uiState = normalizeToolUiState(isError, Boolean(blockOutput));
            tracked.state = legacyToolState(tracked.uiState);
            tracked.sources = extractedSources.length > 0 ? dedupeSources(extractedSources) : tracked.sources;
            const diffStep = diffStepById.get(toolCallId);
            if (diffStep) {
              diffStep.result = tracked.output ?? tracked.errorText;
            }
            const terminalStep = terminalStepById.get(toolCallId);
            if (terminalStep) {
              terminalStep.output = tracked.output ?? tracked.errorText;
              terminalStep.streaming = false;
            }
          }
        }
      } else if (eventType === "reasoning") {
        const text = asString(event.text).trim();
        if (!text) continue;
        flushGroup();
        steps.push({
          id: `thinking:turn-${turnId}-${ei}`,
          type: "thinking",
          text,
          streaming: false,
          eventSeq,
          turnId,
        });
      } else if (eventType === "file_change") {
        flushGroup();
        const changesRaw = Array.isArray(event.changes) ? (event.changes as unknown[]) : [];
        const changes: Array<{ path: string; kind: "add" | "delete" | "update" }> = [];
        for (const raw of changesRaw) {
          const c = asRecord(raw);
          const path = asString(c.path);
          if (path) {
            changes.push({ path, kind: (asString(c.kind) as "add" | "delete" | "update") || "update" });
          }
        }
        if (changes.length > 0) {
          steps.push({
            id: `file-changes:turn-${turnId}-${ei}`,
            type: "file-changes",
            changes,
            eventSeq,
            turnId,
          });
        }
      } else if (eventType === "command_execution") {
        flushGroup();
        steps.push({
          id: `terminal:turn-${turnId}-${ei}`,
          type: "terminal",
          description: "Ran shell command",
          command: asString(event.command),
          output: asString(event.aggregated_output || event.output),
          exitCode: typeof event.exit_code === "number" ? (event.exit_code as number) : undefined,
          streaming: false,
          eventSeq,
          turnId,
        });
      } else if (eventType === "thread.message") {
        const messageType = asString(event.message_type);
        const text = asString(event.text).trim();
        if (!text) continue;

        if (messageType === "context") {
          flushGroup();
          const groupId = `context-group:${turnId}`;
          const item: ContextMessageItem = {
            id: asString(event.message_id) || `context:turn-${turnId}-${ei}`,
            text,
            source: asString(event.source) || undefined,
            userId: asString(event.user_id) || undefined,
            createdAt: asString(event.created_at) || undefined,
          };
          const existing = contextGroupById.get(groupId);
          if (existing) {
            if (!existing.items.some((existingItem) => existingItem.id === item.id)) {
              existing.items.push(item);
            }
            if (eventSeq !== undefined) {
              existing.eventSeq = Math.max(existing.eventSeq ?? 0, eventSeq);
            }
          } else {
            const group = {
              id: `context-group:turn-${turnId}`,
              type: "context-group" as const,
              title: "Thread discussion",
              items: [item],
              eventSeq,
              turnId,
            };
            steps.push(group);
            contextGroupById.set(groupId, group);
          }
        } else if (messageType === "command") {
          flushGroup();
          steps.push({
            id: asString(event.message_id) || `user:turn-${turnId}-${ei}`,
            type: "user-message",
            text,
            source: asString(event.source) || undefined,
            userId: asString(event.user_id) || undefined,
            turnId,
            eventSeq,
          });
        }
      } else if (eventType === "subagent") {
        const status = asString(event.status);
        if (!status) continue;
        flushGroup();
        const subagentId = asString(event.subagent_id);
        const acceptableRaw = event.acceptable;
        steps.push({
          id: `subagent:turn-${turnId}:${ei}:${subagentId || "unknown"}:${status}`,
          type: "subagent",
          eventSeq,
          turnId,
          subagentId: subagentId || undefined,
          phase: asString(event.phase) || undefined,
          status,
          name: asString(event.name) || undefined,
          summary: asString(event.summary) || undefined,
          error: asString(event.error) || undefined,
          branchIndex: asNumber(event.branch_index) ?? undefined,
          totalBranches: asNumber(event.total_branches) ?? undefined,
          completed:
            asNumber(event.completed_count ?? event.completed) ?? undefined,
          acceptable:
            asNumber(
              event.acceptable_count ?? (typeof acceptableRaw === "number" ? acceptableRaw : undefined),
            ) ?? undefined,
          failed: asNumber(event.failed_count ?? event.failed) ?? undefined,
          completedCount: asNumber(event.completed_count) ?? undefined,
          acceptableCount: asNumber(event.acceptable_count) ?? undefined,
          failedCount: asNumber(event.failed_count) ?? undefined,
          isAcceptable: asBoolean(event.is_acceptable ?? acceptableRaw) ?? undefined,
          turns: asNumber(event.turns) ?? undefined,
          toolCalls: asNumber(event.tool_calls) ?? undefined,
          durationS: asNumber(event.duration_s) ?? undefined,
          maxParallel: asNumber(event.max_parallel) ?? undefined,
          inputTokens: asNumber(event.input_tokens) ?? undefined,
          outputTokens: asNumber(event.output_tokens) ?? undefined,
          totalTokens: asNumber(event.total_tokens) ?? undefined,
          costUsd: asNumber(event.cost_usd),
          model: asString(event.model) || undefined,
        });
      } else if (eventType === "error") {
        flushGroup();
        steps.push({
          id: `error:turn-${turnId}-${ei}`,
          type: "error",
          message: asString(event.error || event.message),
          eventSeq,
          turnId,
        });
      } else if (eventType === "result") {
        // Skip result events when assistant text blocks already cover the same content.
        if (turnHasAssistantText) continue;
        const text = asString(event.result);
        if (text) {
          flushGroup();
          steps.push({
            id: `result:turn-${turnId}-${ei}`,
            type: "result",
            text,
            streaming: false,
            sources: turnSources.length > 0 ? dedupeSources(turnSources) : undefined,
            eventSeq,
            turnId,
          });
        }
      } else if (
        eventType === "item.started" ||
        eventType === "item.updated" ||
        eventType === "item.completed"
      ) {
        const item = asRecord(event.item);
        const itemType = asString(item.type);

        if (
          itemType === "mcp_tool_call" ||
          itemType === "tool_call" ||
          itemType === "function_call" ||
          itemType === "custom_tool_call"
        ) {
          const toolName =
            asString(item.tool || item.name || item.tool_name) || "tool";
          const toolInput = asRecord(item.arguments || item.input || item.args);
          const fingerprint = toolFingerprint(toolName, toolInput);
          const explicitItemId = asString(item.id || item.tool_call_id || item.call_id);
          const fingerprintQueue = pendingToolIdsByFingerprint.get(fingerprint) ?? [];
          const pendingByFingerprint = fingerprintQueue[0] ?? "";
          const pendingItemId = !explicitItemId
            ? pendingByFingerprint || findPendingToolCallIdByName(toolName)
            : "";
          const itemId =
            explicitItemId ||
            pendingItemId ||
            `turn-${turnId}-item-${ei}`;

          if (eventType === "item.started") {
            const call: ToolCall = {
              id: itemId,
              name: toolName,
              input: toolInput,
              uiState: "input-available",
              state: "loading",
            };
            if (toolName === "web_fetch") {
              const inputUrl = asString(toolInput.url);
              if (inputUrl) {
                call.sources = [{ url: inputUrl, title: inputUrl }];
                turnSources.push({ url: inputUrl, title: inputUrl });
              }
            }
            toolInputById.set(itemId, call);
            const queue = pendingToolIdsByFingerprint.get(fingerprint) ?? [];
            queue.push(itemId);
            pendingToolIdsByFingerprint.set(fingerprint, queue);

            if (toolName === "str_replace") {
              flushGroup();
              const path = asString(toolInput.path);
              const ext = path.split(".").pop()?.toLowerCase();
              const diffStep: Step & { type: "diff" } = {
                id: `diff:${itemId}`,
                type: "diff",
                file: path,
                lang: ext || "txt",
                oldStr: asString(toolInput.old ?? toolInput.old_str),
                newStr: asString(toolInput.new ?? toolInput.new_str),
                eventSeq,
                turnId,
              };
              steps.push(diffStep);
              diffStepById.set(itemId, diffStep);
              continue;
            }

            if (toolName === "shell" || toolName === "bash") {
              flushGroup();
              const termStep = {
                id: `terminal:${itemId}`,
                type: "terminal" as const,
                description: "Ran shell command",
                command: asString(toolInput.command),
                eventSeq,
                streaming: true,
                turnId,
              };
              steps.push(termStep);
              terminalStepById.set(itemId, termStep);
              continue;
            }

            const { icon, category } = categorizeToolCall(toolName);
            if (pendingGroup && pendingGroup.category === category && pendingGroup.turnId === turnId) {
              pendingGroup.calls.push(call);
            } else {
              flushGroup();
              pendingGroup = {
                id: `tool-group:${itemId}:${category}`,
                category,
                icon,
                calls: [call],
                turnId,
              };
            }
          } else if (eventType === "item.completed") {
            let output = item.result;
            const hasError = item.error !== undefined && item.error !== null;
            if (output === undefined && hasError) output = item.error;
            const outputText = outputToText(output);
            const extractedSources = extractSourcesFromUnknown(output);
            if (extractedSources.length > 0) {
              turnSources.push(...extractedSources);
            }
            let tracked = toolInputById.get(itemId);
            if (!tracked) {
              tracked = {
                id: itemId,
                name: toolName,
                input: toolInput,
                uiState: "input-available",
                state: "loading",
              };
              toolInputById.set(itemId, tracked);
            }
            if (tracked) {
              tracked.output = hasError ? undefined : outputText;
              tracked.errorText = hasError ? outputText : undefined;
              tracked.uiState = normalizeToolUiState(hasError, Boolean(outputText));
              tracked.state = legacyToolState(tracked.uiState);
              tracked.sources = extractedSources.length > 0 ? dedupeSources(extractedSources) : tracked.sources;
              const diffStep = diffStepById.get(itemId);
              if (diffStep) {
                diffStep.result = tracked.output ?? tracked.errorText;
              }
            }
            const queue = pendingToolIdsByFingerprint.get(fingerprint);
            if (queue && queue.length > 0) {
              if (!explicitItemId && queue[0] === itemId) {
                queue.shift();
              } else {
                const index = queue.indexOf(itemId);
                if (index >= 0) {
                  queue.splice(index, 1);
                }
              }
              if (queue.length === 0) {
                pendingToolIdsByFingerprint.delete(fingerprint);
              } else {
                pendingToolIdsByFingerprint.set(fingerprint, queue);
              }
            }
            const terminalStep = terminalStepById.get(itemId);
            if (terminalStep) {
              terminalStep.output = outputText;
              terminalStep.streaming = false;
            }
          }
        } else if (itemType === "command_execution" && eventType === "item.completed") {
          flushGroup();
          steps.push({
            id: `terminal:turn-${turnId}-item-${ei}`,
            type: "terminal",
            description: "Ran shell command",
            command: asString(item.command),
            output: asString(item.aggregated_output || item.output),
            exitCode: typeof item.exit_code === "number" ? (item.exit_code as number) : undefined,
            streaming: false,
            eventSeq,
            turnId,
          });
        } else if (
          itemType === "reasoning" &&
          (eventType === "item.updated" || eventType === "item.completed")
        ) {
          const text = asString(item.text || item.thinking);
          if (text) {
            flushGroup();
            steps.push({
              id: `thinking:turn-${turnId}-item-${ei}`,
              type: "thinking",
              text,
              streaming: eventType !== "item.completed",
              eventSeq,
              turnId,
            });
          }
        } else if (eventType === "item.completed") {
          const text = asString(item.text);
          if (text) {
            flushGroup();
            steps.push({
              id: `result:turn-${turnId}-item-${ei}`,
              type: "result",
              text,
              streaming: false,
              sources: turnSources.length > 0 ? dedupeSources(turnSources) : undefined,
              eventSeq,
              turnId,
            });
          }
        }
      } else if (
        eventType === "system" ||
        eventType === "status" ||
        eventType === "raw" ||
        eventType === "turn.completed"
      ) {
        const detail =
          asString(event.message) ||
          asString(event.text) ||
          asString(event.status) ||
          asString(event.phase) ||
          asString(event.type) ||
          "System update";
        flushGroup();
        steps.push({
          id: `system:turn-${turnId}-${ei}`,
          type: "system",
          title: eventType.replace(/\./g, " "),
          text: detail,
          tone: eventType === "raw" ? "warn" : "info",
          eventSeq,
          turnId,
        });
      }
    }

    // Turn result as a final step (if not already captured by an event)
    if (turn.result) {
      const resultText = turn.result.trim();
      const alreadyHasResult = steps.slice(turnStartIndex).some(
        (s) =>
          s.type === "result" &&
          s.text.trim() === resultText,
      );
      if (!alreadyHasResult) {
        flushGroup();
        steps.push({
          id: `result:turn-${turnId}-final`,
          type: "result",
          text: turn.result,
          streaming: false,
          sources: turnSources.length > 0 ? dedupeSources(turnSources) : undefined,
          turnId,
        });
      }
    }
  }

  flushGroup();
  stableSortStepsBySequence(steps);
  return steps;
}

function stableSortStepsBySequence(steps: Step[]): void {
  const indexed = steps.map((step, index) => ({ step, index }));
  indexed.sort((a, b) => {
    const seqA = a.step.eventSeq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.step.eventSeq ?? Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return a.index - b.index;
  });
  for (let i = 0; i < indexed.length; i += 1) {
    steps[i] = indexed[i].step;
  }
}
