import type { CanonicalEvent } from "@centaur/harness-events";
import type { StreamChunk } from "chat";

type ActiveTool = { name: string; input: Record<string, unknown>; startedAt: number };

export class ProgressTracker {
  lastAssistantText = "";
  resultText = "";
  private activeTools = new Map<string, ActiveTool>();
  private _pendingChunks: StreamChunk[] = [];
  private initCompleted = false;

  update(event: CanonicalEvent): boolean {
    // Complete the "Starting…" task on the first real event
    if (!this.initCompleted) {
      this.initCompleted = true;
      this._pendingChunks.push({
        type: "task_update",
        id: "init",
        title: "Started",
        status: "complete",
      });
    }
    if (event.type === "assistant" && event.message?.content) {
      let changed = false;
      let textInThisEvent = "";
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          // A tool is starting — any preceding assistant text (in this event
          // or a prior one) was just preamble (e.g. "Let me look at…") and
          // should not be posted as the final Slack message if the stream
          // ends before the tool completes.
          this.lastAssistantText = "";
          this.activeTools.set(block.id, {
            name: block.name,
            input: block.input,
            startedAt: Date.now(),
          });
          changed = true;
          this._pendingChunks.push({
            type: "task_update",
            id: block.id,
            title: friendlyToolLabel(block.name, block.input),
            status: "in_progress",
          });
        } else if (block.type === "text" && block.text) {
          textInThisEvent = block.text;
        }
      }
      // Only set lastAssistantText if this event had no tool_use blocks.
      // When tools are active, text after all tools complete will set it.
      if (textInThisEvent && this.activeTools.size === 0) {
        this.lastAssistantText = textInThisEvent;
      }
      return changed;
    }

    if (event.type === "tool" && event.content) {
      let changed = false;
      for (const block of event.content) {
        const active = this.activeTools.get(block.tool_use_id);
        if (active) {
          this.activeTools.delete(block.tool_use_id);
          changed = true;
          const isDone = !block.is_error;
          this._pendingChunks.push({
            type: "task_update",
            id: block.tool_use_id,
            title: friendlyToolLabel(active.name, active.input, isDone),
            status: block.is_error ? "error" : "complete",
          });
        }
      }
      return changed;
    }

    if (event.type === "reasoning") {
      // No-op: tool calls already provide real progress indicators
      return false;
    }

    if (event.type === "subagent") {
      const label = `Subagent: ${event.name || "Subagent"}`;
      if (event.status === "started") {
        this._pendingChunks.push({
          type: "task_update",
          id: event.subagent_id,
          title: label,
          status: "in_progress",
        });
        return true;
      }
      if (event.status === "completed" || event.status === "failed") {
        this._pendingChunks.push({
          type: "task_update",
          id: event.subagent_id,
          title: label,
          status: event.status === "completed" ? "complete" : "error",
        });
        return true;
      }
      return false;
    }

    if (event.type === "result") {
      this.resultText = event.text;
      return true;
    }

    if (event.type === "error") {
      this._pendingChunks.push({
        type: "markdown_text",
        text: `Error: ${event.error || "Unknown error"}`,
      });
      return true;
    }

    // command_execution, file_change, usage, system — no visual update
    return false;
  }

  addHandoff(goal: string, _newThreadKey: string): void {
    this.activeTools.clear();
    this.lastAssistantText = "";
    this.resultText = "";
    this._pendingChunks.push({
      type: "task_update",
      id: `handoff-${Date.now()}`,
      title: `Handed off → ${goal}`,
      status: "complete",
    });
  }

  pendingChunks(): StreamChunk[] {
    const chunks = this._pendingChunks;
    this._pendingChunks = [];
    return chunks;
  }
}

const TOOL_VERBS: Record<string, [active: string, done: string]> = {
  Read: ["Reading", "Read"],
  Bash: ["Running", "Ran"],
  Grep: ["Searching", "Searched"],
  glob: ["Finding files", "Found files"],
  finder: ["Searching codebase", "Searched codebase"],
  edit_file: ["Editing", "Edited"],
  create_file: ["Creating file", "Created file"],
  Task: ["Running subtask", "Ran subtask"],
  web_search: ["Searching the web", "Searched the web"],
  read_web_page: ["Reading webpage", "Read webpage"],
  librarian: ["Researching codebase", "Researched codebase"],
  oracle: ["Consulting oracle", "Consulted oracle"],
  mermaid: ["Drawing diagram", "Drew diagram"],
  look_at: ["Analyzing file", "Analyzed file"],
  skill: ["Loading skill", "Loaded skill"],
};

function friendlyToolLabel(
  name: string,
  input: Record<string, unknown>,
  done?: boolean,
): string {
  const pair = TOOL_VERBS[name];
  const verb = pair ? pair[done ? 1 : 0] : name;
  const ctx = friendlyToolContext(name, input);
  return ctx ? `${verb} — ${ctx}` : verb;
}

function friendlyToolContext(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");

  switch (name) {
    case "Read":
    case "edit_file":
    case "create_file":
    case "look_at":
      return shortPath(str("path"));
    case "Bash":
      return friendlyBashContext(str("cmd"));
    case "Grep":
      return truncate(str("pattern"), 50);
    case "glob":
      return truncate(str("filePattern"), 50);
    case "finder":
      return truncate(str("query"), 60);
    case "web_search":
      return truncate(str("objective"), 60);
    case "read_web_page":
      return truncate(str("url"), 60);
    case "Task":
      return truncate(str("description"), 60);
    case "skill":
      return str("name");
    default:
      return summarizeInput(input);
  }
}

function friendlyBashContext(cmd: string): string {
  if (!cmd) return "";
  const trimmed = cmd.trim();
  // Parse `call search <query>`, `call sql <query>`, `call discover <tool>`
  const callBuiltin = trimmed.match(/^call\s+(search|sql|discover)\s+(.*)/s);
  if (callBuiltin) {
    return `${callBuiltin[1]}: ${truncate(callBuiltin[2], 50)}`;
  }
  // Parse `call <tool> <method> [json]` → "tool.method"
  const callMatch = trimmed.match(/^call\s+(\S+)\s+(\S+)/);
  if (callMatch) {
    return `${callMatch[1]}.${callMatch[2]}`;
  }
  return truncate(trimmed, 60);
}

function shortPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  // Collapse to single line
  const line = s.replace(/\n/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
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
