import type { CanonicalEvent } from "@/lib/normalize-harness-event";

type ActiveTool = { name: string; input: Record<string, unknown>; startedAt: number };
type CompletedTool = { name: string; duration: number; isError: boolean };
type ActiveSubagent = { name: string; startedAt: number };
type CompletedSubagent = { name: string; summary: string; status: string };
type ActiveCommand = { command: string; startedAt: number };
type HandoffEntry = { goal: string; newThreadKey: string };

export class ProgressTracker {
  activeTools = new Map<string, ActiveTool>();
  completedTools: CompletedTool[] = [];
  activeSubagents = new Map<string, ActiveSubagent>();
  completedSubagents: CompletedSubagent[] = [];
  activeCommands = new Map<string, ActiveCommand>();
  handoffs: HandoffEntry[] = [];
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
    } else if (event.type === "result") {
      this.resultText = event.text;
      this.phase = "done";
      changed = true;
    } else if (event.type === "error") {
      this.phase = "done";
      changed = true;
    }

    return changed;
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
  }

  toSlackBullets(): string {
    if (this.phase === "done") {
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(0);
      const toolNames = [
        ...new Set(this.completedTools.map((t) => t.name.split(".")[0])),
      ];
      const toolSummary = toolNames.length > 0 ? ` — used ${toolNames.join(", ")}` : "";
      return `✅ Done (${elapsed}s)${toolSummary}`;
    }

    const lines: string[] = [];

    for (const ho of this.handoffs) {
      lines.push(`• 🔀 Handed off → _${ho.goal}_`);
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
      const truncated = cmd.command.length > 60 ? cmd.command.slice(0, 57) + "..." : cmd.command;
      lines.push(`• 💻 \`${truncated}\``);
    }

    // Show last few completed tools
    const recentCompleted = this.completedTools.slice(-3);
    for (const tool of recentCompleted) {
      const icon = tool.isError ? "❌" : "✅";
      lines.push(`• ${icon} ${tool.name} (${tool.duration.toFixed(1)}s)`);
    }

    for (const sub of this.completedSubagents.slice(-2)) {
      const icon = sub.status === "failed" ? "❌" : "✅";
      lines.push(`• ${icon} Subagent: _${sub.name}_`);
    }

    if (lines.length === 0) {
      return "⏳ Working...";
    }

    return lines.join("\n");
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common patterns: show the most useful parameter
  for (const key of ["query", "pattern", "command", "cmd", "prompt", "path", "url", "message"]) {
    if (typeof input[key] === "string") {
      const val = input[key] as string;
      return val.length > 50 ? `${key}: "${val.slice(0, 47)}..."` : `${key}: "${val}"`;
    }
  }

  // Fallback: show first string param
  for (const key of keys) {
    if (typeof input[key] === "string" && (input[key] as string).length > 0) {
      const val = input[key] as string;
      return val.length > 50 ? `${key}: "${val.slice(0, 47)}..."` : `${key}: "${val}"`;
    }
  }

  return "";
}
