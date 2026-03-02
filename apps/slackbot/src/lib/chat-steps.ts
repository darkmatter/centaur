import type { UIMessage } from "ai";
import type { LucideIcon } from "lucide-react";
import {
  categorizeToolCall,
  summarizeGroup,
  type ContextMessageItem,
  type Step,
  type ToolCall,
} from "@/lib/describe";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function outputToText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function toolNameFromPart(part: Record<string, unknown>): string | null {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  const type = asString(part.type);
  if (type.startsWith("tool-")) return type.slice("tool-".length);
  return null;
}

export function stepsFromUiMessages(messages: UIMessage[]): Step[] {
  const steps: Step[] = [];
  let pendingGroup: { id: string; category: string; icon: LucideIcon; calls: ToolCall[] } | null =
    null;

  const flushGroup = () => {
    if (!pendingGroup || pendingGroup.calls.length === 0) return;
    steps.push({
      id: pendingGroup.id,
      type: "tool-group",
      icon: pendingGroup.icon,
      category: pendingGroup.category,
      summary: summarizeGroup(pendingGroup.category, pendingGroup.calls),
      calls: pendingGroup.calls,
    });
    pendingGroup = null;
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    const messageId = `${String(message.id ?? "message")}-${messageIndex}`;
    for (const [partIndex, rawPart] of (message.parts ?? []).entries()) {
      const part = rawPart as Record<string, unknown>;
      const partType = asString(part.type);
      const partId = `${messageId}:${partIndex}`;

      if (partType === "text") {
        const text = asString(part.text).trim();
        if (!text) continue;
        flushGroup();
        steps.push({
          id: `result:${partId}`,
          type: "result",
          text,
          streaming: asString(part.state) === "streaming",
        });
        continue;
      }

      if (partType === "reasoning") {
        const text = asString(part.text).trim();
        if (!text) continue;
        flushGroup();
        steps.push({ id: `thinking:${partId}`, type: "thinking", text });
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
          steps.push({ id: streamId || `file-changes:${partId}`, type: "file-changes", changes });
        }
        continue;
      }

      if (partType === "data-phase-progress") {
        const data = asRecord(part.data);
        const phase = asString(data.phase);
        if (!phase) continue;
        flushGroup();
        const turnId = data.turn_id === undefined || data.turn_id === null ? "" : String(data.turn_id);
        steps.push({ id: `phase:${turnId || partId}:${phase}`, type: "phase", phase });
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
        steps.push({ id: `error:${asString(part.id) || partId}`, type: "error", message: errorText });
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
        });
        continue;
      }

      if (partType === "data-context-message") {
        flushGroup();
        const data = asRecord(part.data);
        const text = asString(data.text).trim();
        if (!text) continue;
        const turnId = data.turn_id === undefined || data.turn_id === null ? "" : String(data.turn_id);
        const groupId = turnId ? `context-group:${turnId}` : "context-group:thread";
        const item: ContextMessageItem = {
          id: asString(data.id) || `context:${partId}`,
          text,
          source: asString(data.source) || undefined,
          userId: asString(data.user_id) || undefined,
          createdAt: asString(data.created_at) || undefined,
        };
        const existingIndex = steps.findIndex((step) => step.id === groupId);
        if (existingIndex >= 0) {
          const existing = steps[existingIndex];
          if (existing.type === "context-group") {
            if (!existing.items.some((contextItem) => contextItem.id === item.id)) {
              existing.items.push(item);
            }
          }
        } else {
          steps.push({
            id: groupId,
            type: "context-group",
            title: "Thread discussion",
            items: [item],
          });
        }
        continue;
      }

      if (partType === "dynamic-tool" || partType.startsWith("tool-")) {
        const toolName = toolNameFromPart(part);
        if (!toolName) continue;
        const toolInput = asRecord(part.input);
        const toolCallId = asString(part.toolCallId) || `${messageId}-${toolName}-${partIndex}`;
        const outputText = outputToText(part.output);
        const errorText = asString(part.errorText);
        const partState = asString(part.state);
        const call: ToolCall = {
          id: toolCallId,
          name: toolName,
          input: toolInput,
          output: outputText ?? (errorText || undefined),
          state:
            partState === "output-error"
              ? "error"
              : partState === "output-available"
                ? "done"
                : "loading",
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
            result: call.output,
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
            output: call.output,
          });
          continue;
        }

        const { icon, category } = categorizeToolCall(toolName);
        if (pendingGroup && pendingGroup.category === category) {
          pendingGroup.calls.push(call);
        } else {
          flushGroup();
          pendingGroup = { id: `tool-group:${toolCallId}:${category}`, category, icon, calls: [call] };
        }
      }
    }
  }

  flushGroup();
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

  const deduped: Step[] = [];
  for (const step of stable) {
    if (step.type === "result" && deduped.length > 0) {
      const previous = deduped[deduped.length - 1];
      if (previous.type === "result" && previous.text === step.text) {
        // Preserve completion if a replayed duplicate carries non-streaming state.
        if (previous.streaming && !step.streaming) {
          previous.streaming = false;
        }
        continue;
      }
    }
    deduped.push(step);
  }
  return deduped;
}
