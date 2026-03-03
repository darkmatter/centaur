import type { UIMessage } from "ai";
import type { LucideIcon } from "lucide-react";
import {
  categorizeToolCall,
  summarizeGroup,
  type ContextMessageItem,
  type Step,
  type ToolCall,
} from "@/lib/describe";
import { asString, asRecord, asNumber, asBoolean } from "@/lib/parse-utils";
import { dedupeSources, extractSourcesFromUnknown, type StepSource } from "@/lib/source-utils";

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

function asEventSeq(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function eventSeqFromId(id: string): number | undefined {
  const match = id.match(/(?:event|evt)[-_]?(\d{1,12})/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractPartEventSeq(part: Record<string, unknown>): number | undefined {
  const direct = asEventSeq(part.event_seq ?? part.eventSeq);
  if (direct !== undefined) return direct;
  const data = asRecord(part.data);
  const nested = asEventSeq(data.event_seq ?? data.eventSeq);
  if (nested !== undefined) return nested;
  const id = asString(part.id);
  if (!id) return undefined;
  return eventSeqFromId(id);
}

function parseTurnIdFromText(value: string): number | undefined {
  const match = value.match(/turn-(\d+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractPartTurnId(part: Record<string, unknown>): number | undefined {
  const direct = asNumber(part.turn_id ?? part.turnId);
  if (direct !== null && Number.isFinite(direct)) return direct;
  const data = asRecord(part.data);
  const nested = asNumber(data.turn_id ?? data.turnId);
  if (nested !== null && Number.isFinite(nested)) return nested;
  const id = asString(part.id);
  if (!id) return undefined;
  return parseTurnIdFromText(id);
}

function toolNameFromPart(part: Record<string, unknown>): string | null {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  const type = asString(part.type);
  if (type.startsWith("tool-")) return type.slice("tool-".length);
  return null;
}

function collectMessageSources(parts: unknown[]): StepSource[] {
  const sources: StepSource[] = [];
  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    const type = asString(part.type);
    if (type === "source-url") {
      const url = asString(part.url);
      if (!url) continue;
      sources.push({
        url,
        title: asString(part.title) || url,
        snippet: asString(part.description) || undefined,
      });
      continue;
    }
    if (type === "source-document") {
      const url = asString(part.sourceId);
      const title = asString(part.title);
      if (!url) continue;
      sources.push({
        url,
        title: title || url,
        snippet: asString(part.mediaType) || undefined,
      });
    }
  }
  return dedupeSources(sources);
}

function normalizeToolUiState(
  partState: string,
  hasError: boolean,
  hasOutput: boolean,
): NonNullable<ToolCall["uiState"]> {
  if (partState === "approval-requested") return "approval-requested";
  if (partState === "approval-responded") return "approval-responded";
  if (partState === "input-streaming") return "input-streaming";
  if (partState === "output-denied") return "output-denied";
  if (partState === "output-error" || hasError) return "output-error";
  if (partState === "output-available") return "output-available";
  if (partState === "input-available") return "input-available";
  return hasOutput ? "output-available" : "input-available";
}

function legacyToolState(state: NonNullable<ToolCall["uiState"]>): ToolCall["state"] {
  if (state === "output-error" || state === "output-denied") return "error";
  if (state === "output-available" || state === "approval-responded") return "done";
  return "loading";
}

export function stepsFromUiMessages(messages: UIMessage[]): Step[] {
  const steps: Step[] = [];
  const contextGroupsById = new Map<string, number>();
  let pendingGroup: {
    id: string;
    category: string;
    icon: LucideIcon;
    calls: ToolCall[];
    turnId?: number;
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

  for (const [messageIndex, message] of messages.entries()) {
    const messageId = String(message.id ?? `message-${messageIndex}`);
    const messageParts = message.parts ?? [];
    const messageSources = collectMessageSources(messageParts);
    let lastSeenTurnId: number | undefined;
    for (const [partIndex, rawPart] of messageParts.entries()) {
      const part = rawPart as Record<string, unknown>;
      const partType = asString(part.type);
      const partId = asString(part.id) || `${messageId}:${partIndex}`;
      const eventSeq = extractPartEventSeq(part);
      const explicitTurnId = extractPartTurnId(part);
      if (explicitTurnId !== undefined) {
        lastSeenTurnId = explicitTurnId;
      }
      const turnId = explicitTurnId ?? lastSeenTurnId;

      if (partType === "text") {
        if (message.role !== "assistant") continue;
        const text = asString(part.text).trim();
        if (!text) continue;
        flushGroup();
        steps.push({
          id: `result:${partId}`,
          type: "result",
          text,
          streaming: asString(part.state) === "streaming",
          sources: messageSources.length > 0 ? messageSources : undefined,
          eventSeq,
          turnId,
        });
        continue;
      }

      if (partType === "reasoning") {
        if (message.role !== "assistant") continue;
        const text = asString(part.text).trim();
        if (!text) continue;
        flushGroup();
        steps.push({
          id: `thinking:${partId}`,
          type: "thinking",
          text,
          streaming: asString(part.state) === "streaming",
          eventSeq,
          turnId,
        });
        continue;
      }

      if (partType === "data-file-changes") {
        flushGroup();
        const data = asRecord(part.data);
        const streamId = asString(part.id);
        const changesRaw = Array.isArray(data.changes) ? data.changes : [];
        const changes = changesRaw
          .map((item) => asRecord(item))
          .map((item) => ({
            path: asString(item.path),
            kind: (asString(item.kind) as "add" | "delete" | "update") || "update",
          }))
          .filter((item) => item.path);
        if (changes.length > 0) {
          steps.push({
            id: streamId || `file-changes:${partId}`,
            type: "file-changes",
            changes,
            eventSeq,
            turnId,
          });
        }
        continue;
      }

      if (partType === "data-phase-progress") {
        const data = asRecord(part.data);
        const phase = asString(data.phase);
        if (!phase) continue;
        flushGroup();
        const turnIdValue = data.turn_id === undefined || data.turn_id === null ? "" : String(data.turn_id);
        const resolvedTurnId = asNumber(data.turn_id) ?? turnId;
        steps.push({
          id: `phase:${turnIdValue || partId}:${phase}`,
          type: "phase",
          phase,
          eventSeq,
          turnId: resolvedTurnId ?? undefined,
        });
        continue;
      }

      if (partType === "data-subagent") {
        const data = asRecord(part.data);
        const status = asString(data.status);
        if (!status) continue;
        flushGroup();
        const subagentId = asString(data.subagent_id);
        const phase = asString(data.phase) || undefined;
        const streamId = asString(part.id);
        const stepId = streamId || `subagent:${subagentId || partId}:${status}`;
        const acceptableRaw = data.acceptable;
        steps.push({
          id: stepId,
          type: "subagent",
          eventSeq,
          turnId,
          subagentId: subagentId || undefined,
          phase,
          status,
          name: asString(data.name) || undefined,
          summary: asString(data.summary) || undefined,
          error: asString(data.error) || undefined,
          branchIndex: asNumber(data.branch_index) ?? undefined,
          totalBranches: asNumber(data.total_branches) ?? undefined,
          completed: asNumber(data.completed_count ?? data.completed) ?? undefined,
          acceptable:
            asNumber(data.acceptable_count ?? (typeof acceptableRaw === "number" ? acceptableRaw : undefined))
              ?? undefined,
          failed: asNumber(data.failed_count ?? data.failed) ?? undefined,
          completedCount: asNumber(data.completed_count) ?? undefined,
          acceptableCount: asNumber(data.acceptable_count) ?? undefined,
          failedCount: asNumber(data.failed_count) ?? undefined,
          isAcceptable: asBoolean(data.is_acceptable ?? acceptableRaw) ?? undefined,
          turns: asNumber(data.turns) ?? undefined,
          toolCalls: asNumber(data.tool_calls) ?? undefined,
          durationS: asNumber(data.duration_s) ?? undefined,
          maxParallel: asNumber(data.max_parallel) ?? undefined,
          inputTokens: asNumber(data.input_tokens) ?? undefined,
          outputTokens: asNumber(data.output_tokens) ?? undefined,
          totalTokens: asNumber(data.total_tokens) ?? undefined,
          costUsd: asNumber(data.cost_usd),
          model: asString(data.model) || undefined,
        });
        continue;
      }

      if (partType === "error") {
        flushGroup();
        const errorText = asString(part.errorText).trim();
        if (!errorText) continue;
        steps.push({
          id: `error:${asString(part.id) || partId}`,
          type: "error",
          message: errorText,
          eventSeq,
          turnId,
        });
        continue;
      }
      if (partType === "data-shell-command") {
        flushGroup();
        const data = asRecord(part.data);
        const streamId = asString(part.id);
        steps.push({
          id: streamId || `terminal:${partId}`,
          type: "terminal",
          description: "Ran shell command",
          command: asString(data.command),
          output: outputToText(data.output),
          exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
          eventSeq,
          turnId,
        });
        continue;
      }

      if (partType === "data-user-message") {
        flushGroup();
        const data = asRecord(part.data);
        const text = asString(data.text).trim();
        if (!text) continue;
        steps.push({
          id: asString(data.id) || `user:${partId}`,
          type: "user-message",
          text,
          source: asString(data.source) || undefined,
          userId: asString(data.user_id) || undefined,
          turnId: asNumber(data.turn_id) ?? undefined,
          eventSeq,
        });
        continue;
      }

      if (partType === "data-context-message") {
        flushGroup();
        const data = asRecord(part.data);
        const text = asString(data.text).trim();
        if (!text) continue;
        const turnIdKey = data.turn_id === undefined || data.turn_id === null ? "" : String(data.turn_id);
        const groupId = turnIdKey ? `context-group:turn-${turnIdKey}` : "context-group:thread";
        const contextTurnId = asNumber(data.turn_id) ?? turnId;
        const item: ContextMessageItem = {
          id: asString(data.id) || `context:${partId}`,
          text,
          source: asString(data.source) || undefined,
          userId: asString(data.user_id) || undefined,
          createdAt: asString(data.created_at) || undefined,
        };
        const existingIndex = contextGroupsById.get(groupId);
        if (existingIndex !== undefined) {
          const existing = steps[existingIndex];
          if (existing.type === "context-group") {
            if (!existing.items.some((contextItem) => contextItem.id === item.id)) {
              existing.items.push(item);
            }
            if (eventSeq !== undefined) {
              existing.eventSeq = Math.max(existing.eventSeq ?? 0, eventSeq);
            }
          }
        } else {
          steps.push({
            id: groupId,
            type: "context-group",
            title: "Thread discussion",
            items: [item],
            eventSeq,
            turnId: contextTurnId,
          });
          contextGroupsById.set(groupId, steps.length - 1);
        }
        continue;
      }

      if (partType === "data-system-event") {
        flushGroup();
        const data = asRecord(part.data);
        const text = asString(data.text).trim();
        if (!text) continue;
        steps.push({
          id: asString(part.id) || `system:${partId}`,
          type: "system",
          title: asString(data.title) || "System",
          text,
          tone: asString(data.tone) === "warn" ? "warn" : "info",
          eventSeq,
          turnId,
        });
        continue;
      }

      if (partType === "dynamic-tool" || partType.startsWith("tool-")) {
        if (message.role !== "assistant") continue;
        const toolName = toolNameFromPart(part);
        if (!toolName) continue;
        const toolInput = asRecord(part.input);
        const toolCallId = asString(part.toolCallId) || `${messageId}-${toolName}-${partIndex}`;
        const outputText = outputToText(part.output);
        const errorText = asString(part.errorText);
        const partState = asString(part.state);
        const hasError = Boolean(errorText) || partState === "output-error";
        const sourceCandidates = extractSourcesFromUnknown(part.output);
        if (toolName === "web_fetch") {
          const toolUrl = asString(toolInput.url);
          if (toolUrl) {
            sourceCandidates.push({ url: toolUrl, title: toolUrl });
          }
        }
        const uiState = normalizeToolUiState(partState, hasError, Boolean(outputText));
        const call: ToolCall = {
          id: toolCallId,
          name: toolName,
          input: toolInput,
          output: hasError ? undefined : outputText,
          errorText: errorText || undefined,
          uiState,
          state: legacyToolState(uiState),
          sources: sourceCandidates.length > 0 ? dedupeSources(sourceCandidates) : undefined,
        };

        if (toolName === "str_replace") {
          flushGroup();
          const path = asString(toolInput.path);
          const ext = path.split(".").pop()?.toLowerCase();
          steps.push({
            id: `diff:${toolCallId}`,
            type: "diff",
            file: path,
            lang: ext || "txt",
            oldStr: asString(toolInput.old ?? toolInput.old_str),
            newStr: asString(toolInput.new ?? toolInput.new_str),
            result: call.output ?? call.errorText,
            eventSeq,
            turnId,
          });
          continue;
        }

        if (toolName === "shell" || toolName === "bash") {
          flushGroup();
          steps.push({
            id: `terminal:${toolCallId}`,
            type: "terminal",
            description: "Ran shell command",
            command: asString(toolInput.command),
            output: call.output ?? call.errorText,
            streaming: uiState === "input-available" || uiState === "input-streaming",
            eventSeq,
            turnId,
          });
          continue;
        }

        const { icon, category } = categorizeToolCall(toolName);
        if (pendingGroup && pendingGroup.category === category && pendingGroup.turnId === turnId) {
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
  }

  flushGroup();
  stableSortStepsBySequence(steps);
  const byId = new Map<string, number>();
  const stable: Step[] = [];
  for (const step of steps) {
    const existingIndex = byId.get(step.id);
    if (existingIndex === undefined) {
      byId.set(step.id, stable.length);
      stable.push(step);
      continue;
    }
    const existing = stable[existingIndex];
    if (existing.type === "context-group" && step.type === "context-group") {
      const existingItems = new Set(existing.items.map((item) => item.id));
      const merged = [...existing.items];
      for (const item of step.items) {
        if (!existingItems.has(item.id)) {
          merged.push(item);
        }
      }
      stable[existingIndex] = { ...existing, items: merged };
      continue;
    }
    if (existing.type === "result" && step.type === "result") {
      stable[existingIndex] = {
        ...existing,
        text: step.text || existing.text,
        streaming: existing.streaming && !step.streaming ? false : step.streaming,
      };
      continue;
    }
    stable[existingIndex] = step;
  }

  return stable;
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
