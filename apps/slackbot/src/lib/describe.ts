import type { LucideIcon } from "lucide-react";
import {
  FilePlus,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Replace,
  SearchCode,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  state?: "loading" | "done" | "error";
};

export type ContextMessageItem = {
  id: string;
  text: string;
  source?: string;
  userId?: string;
  createdAt?: string;
};

export type Step =
  | { id: string; type: "phase"; phase: string }
  | {
      id: string;
      type: "subagent";
      subagentId?: string;
      phase?: string;
      status: string;
      name?: string;
      summary?: string;
      error?: string;
      branchIndex?: number;
      totalBranches?: number;
      completed?: number;
      acceptable?: number;
      completedCount?: number;
      acceptableCount?: number;
      failedCount?: number;
      isAcceptable?: boolean;
      failed?: number;
      turns?: number;
      toolCalls?: number;
      durationS?: number;
      maxParallel?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number | null;
      model?: string;
    }
  | { id: string; type: "tool-group"; icon: LucideIcon; summary: string; category: string; calls: ToolCall[] }
  | { id: string; type: "diff"; file: string; lang: string; oldStr: string; newStr: string; result?: string }
  | { id: string; type: "terminal"; command: string; output?: string; exitCode?: number; description: string }
  | { id: string; type: "thinking"; text: string; durationS?: number }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "result"; text: string; streaming?: boolean }
  | { id: string; type: "file-changes"; changes: Array<{ path: string; kind: "add" | "delete" | "update" }> }
  | { id: string; type: "user-message"; text: string; source?: string; userId?: string; turnId?: number }
  | { id: string; type: "context-group"; title: string; items: ContextMessageItem[] };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getPathBasename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function truncatePreview(value: string, maxChars = 32): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function commandPreview(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) return null;
  const firstSegment = normalized.split(/&&|\|\||;/)[0]?.trim() || normalized;
  return truncatePreview(firstSegment.replace(/\s+/g, " "), 56);
}

function firstNonEmpty(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(input[key]);
    if (value) return value;
  }
  return "";
}

function parseHost(urlText: string): string {
  try {
    const parsed = new URL(urlText);
    return parsed.host || parsed.href;
  } catch {
    return urlText;
  }
}

function lineRangeLabel(input: Record<string, unknown>): string {
  const offset = asNumber(input.offset);
  const limit = asNumber(input.limit);
  if (offset === null && limit === null) return "";
  if (offset !== null && limit !== null && offset > 0 && limit > 0) {
    const end = offset + limit - 1;
    return `lines ${offset}-${end}`;
  }
  if (offset !== null && offset > 0) return `from line ${offset}`;
  if (offset !== null && offset < 0 && limit !== null && limit > 0) return `last ${limit} lines`;
  if (limit !== null && limit > 0) return `${limit} lines`;
  return "";
}

function describePathAction(action: string, input: Record<string, unknown>): string {
  const path = firstNonEmpty(input, ["path", "target_directory", "working_directory"]);
  const target = getPathBasename(path) || "target";
  const range = lineRangeLabel(input);
  if (range) return `${action} ${target} (${range})`;
  return `${action} ${target}`;
}

function primitiveInputPreview(input: Record<string, unknown>): string {
  const preferredKeys = [
    "path",
    "query",
    "pattern",
    "command",
    "url",
    "search_term",
    "target_directories",
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${truncatePreview(value, 20)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    } else if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === "string" && first.trim()) {
        parts.push(`${key}=${truncatePreview(first, 20)}`);
      }
    }
    if (parts.length >= 2) break;
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function normalizeToolName(name: string): string {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (normalized === "readfile") return "read_file";
  if (normalized === "writefile") return "write_file";
  if (normalized === "deletefile") return "delete_file";
  if (normalized === "grepsearch") return "grep_search";
  if (normalized === "listdir") return "list_dir";
  if (normalized === "strreplace") return "str_replace";
  return normalized;
}

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  const normalized = normalizeToolName(name);

  if (normalized === "read_file" || normalized === "read") {
    return describePathAction("Read", input);
  }
  if (normalized === "write_file" || normalized === "write" || normalized === "create_file") {
    const content = firstNonEmpty(input, ["content", "new_string"]);
    const target = getPathBasename(asString(input.path)) || "file";
    if (content) return `Created ${target} (${content.length.toLocaleString()} chars)`;
    return `Created ${target}`;
  }
  if (normalized === "str_replace") {
    const target = getPathBasename(asString(input.path)) || "file";
    const oldStr = firstNonEmpty(input, ["old", "old_str"]);
    const newStr = firstNonEmpty(input, ["new", "new_str"]);
    if (oldStr || newStr) {
      const oldPreview = oldStr ? `"${truncatePreview(oldStr, 18)}"` : "text";
      const newPreview = newStr ? `"${truncatePreview(newStr, 18)}"` : "text";
      return `Edited ${target} (${oldPreview} -> ${newPreview})`;
    }
    return `Edited ${target}`;
  }
  if (normalized === "apply_patch") {
    return "Applied patch";
  }
  if (normalized === "delete_file" || normalized === "delete") {
    return `Deleted ${getPathBasename(asString(input.path)) || "file"}`;
  }
  if (normalized === "grep_search" || normalized === "grep") {
    const query = firstNonEmpty(input, ["pattern", "query"]);
    const targetPath = firstNonEmpty(input, ["path", "glob", "type"]);
    if (query && targetPath) {
      return `Searched "${truncatePreview(query, 30)}" in ${truncatePreview(targetPath, 28)}`;
    }
    return query ? `Searched "${truncatePreview(query, 34)}"` : "Searched codebase";
  }
  if (normalized === "semantic_search") {
    const query = firstNonEmpty(input, ["query"]);
    const scope = firstNonEmpty(input, ["target_directories"]);
    if (query && scope) return `Semantically searched "${truncatePreview(query, 30)}" in ${scope}`;
    return query ? `Semantically searched "${truncatePreview(query, 34)}"` : "Semantically searched code";
  }
  if (normalized === "shell" || normalized === "bash" || normalized === "command_execution") {
    const command = commandPreview(asString(input.command));
    const cwd = asString(input.working_directory);
    if (command && cwd) return `Ran ${command} in ${truncatePreview(cwd, 22)}`;
    return command ? `Ran ${command}` : "Ran command";
  }
  if (normalized === "list_dir" || normalized === "glob" || normalized === "list") {
    const glob = firstNonEmpty(input, ["glob_pattern", "glob"]);
    if (glob) return `Listed ${truncatePreview(glob, 34)}`;
    const target = firstNonEmpty(input, ["path", "target_directory"]);
    return target ? `Listed ${truncatePreview(target, 34)}` : "Listed directory contents";
  }
  if (normalized === "web_search") {
    const term = firstNonEmpty(input, ["search_term"]);
    return term ? `Searched web for "${truncatePreview(term, 32)}"` : "Searched web";
  }
  if (normalized === "web_fetch") {
    const urlText = firstNonEmpty(input, ["url"]);
    return urlText ? `Fetched ${truncatePreview(parseHost(urlText), 32)}` : "Fetched webpage";
  }
  if (normalized === "subagent") {
    const description = firstNonEmpty(input, ["description"]);
    const task = firstNonEmpty(input, ["prompt"]);
    if (description && task) {
      return `Delegated ${truncatePreview(description, 22)}: ${truncatePreview(task, 28)}`;
    }
    return description ? `Delegated ${truncatePreview(description, 28)}` : "Delegated subagent task";
  }
  if (normalized === "ask_question") {
    const title = firstNonEmpty(input, ["title"]);
    return title ? `Asked: ${truncatePreview(title, 34)}` : "Asked follow-up question";
  }
  return `Used ${name}${primitiveInputPreview(input)}`;
}

export function categorizeToolCall(name: string): { icon: LucideIcon; category: string } {
  const normalized = normalizeToolName(name);
  if (normalized === "read_file" || normalized === "read") return { icon: FileText, category: "file" };
  if (normalized === "write_file" || normalized === "write" || normalized === "create_file") {
    return { icon: FilePlus, category: "write" };
  }
  if (normalized === "str_replace" || normalized === "apply_patch") {
    return { icon: Replace, category: "edit" };
  }
  if (normalized === "grep_search" || normalized === "grep" || normalized === "semantic_search") {
    return { icon: SearchCode, category: "search" };
  }
  if (normalized === "shell" || normalized === "bash" || normalized === "command_execution") {
    return { icon: SquareTerminal, category: "terminal" };
  }
  if (normalized === "list_dir" || normalized === "glob" || normalized === "list") {
    return { icon: FolderOpen, category: "folder" };
  }
  if (normalized === "delete_file" || normalized === "delete") return { icon: Trash2, category: "edit" };
  if (normalized === "web_search" || normalized === "web_fetch") return { icon: Globe, category: "web" };
  if (normalized.includes("git")) return { icon: GitBranch, category: "terminal" };
  if (normalized.includes("web")) return { icon: Globe, category: "web" };
  return { icon: Wrench, category: "tool" };
}

function shortTargetFromCall(call: ToolCall): string | null {
  const normalized = normalizeToolName(call.name);
  const input = call.input;

  if (
    normalized === "read_file" ||
    normalized === "write_file" ||
    normalized === "create_file" ||
    normalized === "delete_file" ||
    normalized === "str_replace" ||
    normalized === "read" ||
    normalized === "write" ||
    normalized === "delete"
  ) {
    const base = getPathBasename(asString(input.path));
    return base || null;
  }

  if (normalized === "grep_search" || normalized === "grep") {
    const query = firstNonEmpty(input, ["pattern", "query"]);
    return query ? `"${truncatePreview(query, 24)}"` : null;
  }

  if (normalized === "semantic_search") {
    const query = asString(input.query);
    return query ? `"${truncatePreview(query, 24)}"` : null;
  }

  if (normalized === "shell" || normalized === "bash" || normalized === "command_execution") {
    const preview = commandPreview(asString(input.command));
    return preview ? `"${preview}"` : null;
  }

  if (normalized === "web_search") {
    const term = asString(input.search_term);
    return term ? `"${truncatePreview(term, 24)}"` : null;
  }

  if (normalized === "web_fetch") {
    const urlText = asString(input.url);
    return urlText ? parseHost(urlText) : null;
  }

  if (normalized === "list_dir" || normalized === "glob" || normalized === "list") {
    const target = asString(input.path || input.target_directory || input.glob_pattern);
    return target ? truncatePreview(target, 24) : null;
  }

  return null;
}

function fallbackCategorySummary(category: string, count: number): string {
  if (category === "search") return "Searched codebase";
  if (category === "file") return count > 1 ? "Read files" : "Read file";
  if (category === "write") return count > 1 ? "Created files" : "Created file";
  if (category === "edit") return count > 1 ? "Edited files" : "Edited file";
  if (category === "terminal") return count > 1 ? "Ran shell commands" : "Ran shell command";
  return count > 1 ? "Used tools" : "Used tool";
}

export function singleCallOutputBadge(calls: ToolCall[]): string | null {
  if (calls.length !== 1) return null;
  const output = calls[0]?.output;
  if (!output) return null;
  return `${output.length.toLocaleString()} chars`;
}

export function summarizeGroup(category: string, calls: ToolCall[]): string {
  const count = calls.length;
  if (count === 0) return "Used tool";
  if (count === 1) return describeToolCall(calls[0].name, calls[0].input);

  const targets = [...new Set(calls.map((call) => shortTargetFromCall(call)).filter(Boolean))];
  if (targets.length === 0) {
    return fallbackCategorySummary(category, count);
  }

  const shown = targets.slice(0, 3);
  const overflow = targets.length > shown.length ? ` +${targets.length - shown.length} more` : "";

  if (category === "file") return `Read ${count} files: ${shown.join(", ")}${overflow}`;
  if (category === "write") return `Created ${count} files: ${shown.join(", ")}${overflow}`;
  if (category === "edit") return `Edited ${count} files: ${shown.join(", ")}${overflow}`;
  if (category === "search") return `Searched ${shown.join(", ")}${overflow}`;
  if (category === "terminal") return `Ran ${shown.join(", ")}${overflow}`;
  return `Used ${shown.join(", ")}${overflow}`;
}
