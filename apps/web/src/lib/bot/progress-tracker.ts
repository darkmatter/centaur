import type { CanonicalEvent } from "@/lib/normalize-harness-event";

type ActiveTool = { name: string; input: Record<string, unknown>; startedAt: number };
type CompletedTool = { name: string; duration: number; isError: boolean };
type ActiveSubagent = { name: string; startedAt: number };
type CompletedSubagent = { name: string; summary: string; status: string };
type ActiveCommand = { command: string; startedAt: number };
type HandoffEntry = { goal: string; newThreadKey: string };
type FileChange = { file: string; action: string };
type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
};

export class ProgressTracker {
  activeTools = new Map<string, ActiveTool>();
  completedTools: CompletedTool[] = [];
  activeSubagents = new Map<string, ActiveSubagent>();
  completedSubagents: CompletedSubagent[] = [];
  activeCommands = new Map<string, ActiveCommand>();
  handoffs: HandoffEntry[] = [];
  fileChanges: FileChange[] = [];
  reasoningText = "";
  usage: UsageInfo = { inputTokens: 0, outputTokens: 0, model: null };
  errorText = "";
  lastAssistantText = "";
  resultText = "";
  phase: "starting" | "working" | "done" = "starting";
  private startedAt = Date.now();

  update(event: CanonicalEvent): boolean {
    let changed = false;

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          this.activeTools.set(block.id, {
            name: block.name,
            input: block.input,
            startedAt: Date.now(),
          });
          this.phase = "working";
          changed = true;
        } else if (block.type === "text" && block.text) {
          this.lastAssistantText = block.text;
        }
      }
      if (event.message.usage) {
        this.mergeUsage(event.message.usage, event.message.model);
      }
    } else if (event.type === "tool" && event.content) {
      for (const block of event.content) {
        const active = this.activeTools.get(block.tool_use_id);
        if (active) {
          this.activeTools.delete(block.tool_use_id);
          this.completedTools.push({
            name: active.name,
            duration: (Date.now() - active.startedAt) / 1000,
            isError: block.is_error,
          });
          changed = true;
        }
      }
    } else if (event.type === "reasoning") {
      this.reasoningText = event.text || "";
      this.phase = "working";
      changed = true;
    } else if (event.type === "subagent") {
      if (event.status === "started") {
        this.activeSubagents.set(event.subagent_id, {
          name: event.name || "Subagent",
          startedAt: Date.now(),
        });
        this.phase = "working";
        changed = true;
      } else if (event.status === "completed" || event.status === "failed") {
        this.activeSubagents.delete(event.subagent_id);
        this.completedSubagents.push({
          name: event.name || "Subagent",
          summary: event.summary || "",
          status: event.status,
        });
        changed = true;
      }
    } else if (event.type === "command_execution") {
      const id = `cmd-${Date.now()}`;
      this.activeCommands.set(id, {
        command: event.command,
        startedAt: Date.now(),
      });
      this.phase = "working";
      // Commands are instant (we get them completed), so move immediately
      setTimeout(() => this.activeCommands.delete(id), 100);
      changed = true;
    } else if (event.type === "file_change") {
      for (const change of event.changes ?? []) {
        const c = change as Record<string, unknown>;
        const file = String(c.file || c.path || c.filename || "");
        const action = String(c.action || c.type || c.status || "modified");
        if (file) {
          this.fileChanges.push({ file, action });
        }
      }
      this.phase = "working";
      changed = true;
    } else if (event.type === "usage") {
      this.mergeUsage(event.usage, event.model);
      changed = true;
    } else if (event.type === "result") {
      this.resultText = event.text;
      this.phase = "done";
      changed = true;
    } else if (event.type === "error") {
      this.errorText = event.error || "";
      this.phase = "done";
      changed = true;
    }
    // system events are session metadata (init) — no visual update needed

    return changed;
  }

  private mergeUsage(usage: Record<string, unknown>, model?: string | null): void {
    const input = toNonNegativeInt(usage.input_tokens);
    const output = toNonNegativeInt(usage.output_tokens);
    if (input > 0) this.usage.inputTokens += input;
    if (output > 0) this.usage.outputTokens += output;
    if (model) this.usage.model = model;
  }

  addHandoff(goal: string, newThreadKey: string): void {
    this.handoffs.push({ goal, newThreadKey });
    this.phase = "working";
    // Reset transient state — new thread starts fresh
    this.activeTools.clear();
    this.activeCommands.clear();
    this.activeSubagents.clear();
    this.lastAssistantText = "";
    this.resultText = "";
    this.reasoningText = "";
    this.errorText = "";
  }

  toSlackBullets(): string {
    if (this.phase === "done") {
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(0);
      const parts: string[] = [];
      const toolNames = [
        ...new Set(this.completedTools.map((t) => t.name.split(".")[0])),
      ];
      if (toolNames.length > 0) parts.push(`used ${toolNames.join(", ")}`);
      if (this.fileChanges.length > 0) {
        parts.push(`${this.fileChanges.length} file ${this.fileChanges.length === 1 ? "change" : "changes"}`);
      }
      if (this.usage.inputTokens + this.usage.outputTokens > 0) {
        parts.push(formatTokens(this.usage.inputTokens + this.usage.outputTokens));
      }
      const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
      if (this.errorText) {
        return `❌ Failed (${elapsed}s)${suffix}\n• ${this.errorText}`;
      }
      return `✅ Done (${elapsed}s)${suffix}`;
    }

    const lines: string[] = [];

    for (const ho of this.handoffs) {
      lines.push(`• 🔀 Handed off → _${ho.goal}_`);
    }

    if (this.reasoningText) {
      lines.push(`• 💭 _Thinking…_`);
    }

    for (const [, tool] of this.activeTools) {
      const inputSummary = summarizeInput(tool.input);
      const suffix = inputSummary ? ` — ${inputSummary}` : "";
      lines.push(`• 🔧 *${tool.name}*${suffix}`);
    }

    for (const [, sub] of this.activeSubagents) {
      const elapsed = ((Date.now() - sub.startedAt) / 1000).toFixed(0);
      lines.push(`• 🧵 Subagent: _${sub.name}_ (running ${elapsed}s)`);
    }

    for (const [, cmd] of this.activeCommands) {
      lines.push(`• 💻 \`${cmd.command}\``);
    }

    for (const tool of this.completedTools) {
      const icon = tool.isError ? "❌" : "✅";
      lines.push(`• ${icon} ${tool.name} (${tool.duration.toFixed(1)}s)`);
    }

    for (const sub of this.completedSubagents) {
      const icon = sub.status === "failed" ? "❌" : "✅";
      lines.push(`• ${icon} Subagent: _${sub.name}_`);
    }

    if (this.fileChanges.length > 0) {
      const actionCounts = new Map<string, number>();
      for (const fc of this.fileChanges) {
        actionCounts.set(fc.action, (actionCounts.get(fc.action) || 0) + 1);
      }
      const summary = [...actionCounts.entries()]
        .map(([action, count]) => `${count} ${action}`)
        .join(", ");
      lines.push(`• 📝 ${summary}`);
    }

    if (lines.length === 0) {
      return "⏳ Working...";
    }

    return lines.join("\n");
  }
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && value >= 0) return Math.floor(value);
  return 0;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tokens`;
  return `${total} tokens`;
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common patterns: show the most useful parameter
  for (const key of ["query", "pattern", "command", "cmd", "prompt", "path", "url", "message"]) {
    if (typeof input[key] === "string") {
      return `${key}: "${input[key]}"`;
    }
  }

  // Fallback: show first string param
  for (const key of keys) {
    if (typeof input[key] === "string" && (input[key] as string).length > 0) {
      return `${key}: "${input[key]}"`;
    }
  }

  return "";
}
