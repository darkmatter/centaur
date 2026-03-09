"use client";

/**
 * Render a UIMessage's parts directly — no Step[] intermediate.
 *
 * This replaces the `stepsFromUiMessages → MessagePartRenderer` pipeline
 * with a single pass over `message.parts`, using the same visual components.
 */

import type { UIMessage } from "ai";
import { isTextUIPart, isReasoningUIPart, isToolUIPart, isDataUIPart } from "ai";
import { useMemo } from "react";

import {
  categorizeToolCall,
  describeToolCall,
  summarizeGroup,
  type ToolCall,
} from "@/lib/describe";
import { asString, asRecord, asNumber, asBoolean } from "@/lib/parse-utils";
import { dedupeSources, extractSourcesFromUnknown, type StepSource } from "@/lib/viewer/source-utils";
import { stringifyToolOutput } from "@/lib/viewer/tool-output-detect";
import type { Participant } from "@/lib/types";

import dynamic from "next/dynamic";
const DiffCard = dynamic(() => import("@/components/thread/diff-card").then(m => ({ default: m.DiffCard })), { ssr: false });
import { StepGroup } from "@/components/thread/step-group";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
  TerminalStatus,
  TerminalActions,
  TerminalCopyButton,
} from "@/components/ai-elements/terminal";
import { SubagentCard } from "@/components/thread/subagent-card";
import type { SubagentStep } from "@/lib/describe";
import { normalizeSubagentStatus, subagentSelectionKey } from "@/lib/viewer/subagent-steps";
import {
  Checkpoint,
  CheckpointIcon,
} from "@/components/ai-elements/checkpoint";
import {
  FileTree,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import {
  MessageResponse,
  MessageAction,
  MessageActions,
} from "@/components/ai-elements/message";
import {
  Sources,
  SourcesContent,
  SourcesTrigger,
  Source,
} from "@/components/ai-elements/sources";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, CopyIcon, ChevronRight, Timer } from "lucide-react";
import { toast } from "sonner";

// ── Helpers ────────────────────────────────────────────────────────────────

function copyToClipboard(text: string, label?: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast("Clipboard unavailable");
    return;
  }
  void navigator.clipboard
    .writeText(text)
    .then(() => toast(label || "Copied to clipboard"))
    .catch(() => toast("Failed to copy"));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function sourceLabel(source?: string): string {
  const normalized = (source ?? "").trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (normalized === "thread_ui") return "Thread Viewer";
  if (normalized === "slack") return "Slack";
  if (normalized === "api") return "API";
  return normalized.replace(/_/g, " ");
}

function initials(name: string): string {
  const words = name.trim().replace(/^@/, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;
const SLACK_MENTION_RE = /<@(U[A-Z0-9]+)>/g;
const HARNESS_PREFIX_RE = /^User [A-Z0-9]{4}\b[:\s]*/i;

/**
 * Replace raw Slack mention tags (`<@U0AH5TRPOHO>`) with human-readable names
 * and strip harness-injected "User XXXX" prefixes from message text.
 */
function cleanMessageText(
  text: string,
  participantsById: Map<string, Participant>,
): string {
  let cleaned = text.replace(SLACK_MENTION_RE, (_match, userId: string) => {
    const p = participantsById.get(userId);
    if (p?.username) return `@${p.username}`;
    if (p?.name && !SLACK_USER_ID_RE.test(p.name)) return p.name;
    return `@user-${userId.slice(-4)}`;
  });
  cleaned = cleaned.replace(HARNESS_PREFIX_RE, "");
  return cleaned;
}

function participantDisplayName(
  participant: Participant | undefined,
  userId: string | undefined,
  fallback: string,
): string {
  const username = String(participant?.username || "").trim();
  if (username) return `@${username}`;
  const name = String(participant?.name || "").trim();
  if (name && !SLACK_USER_ID_RE.test(name)) return name;
  const id = String(userId || participant?.id || "").trim();
  if (!id) return fallback;
  if (SLACK_USER_ID_RE.test(id)) return `User ${id.slice(-4)}`;
  return id;
}

// ── Types for grouped tool calls ──────────────────────────────────────────

type ToolGroup = {
  key: string;
  category: string;
  icon: ReturnType<typeof categorizeToolCall>["icon"];
  calls: ToolCall[];
};

// ── Main renderer ─────────────────────────────────────────────────────────

/**
 * Render a single UIMessage. For assistant messages, iterates over `message.parts`
 * and renders each using the appropriate visual component.
 */
export function UIMessageRenderer({
  message,
  participantsById,
  onSelectSubagent,
  selectedSubagentKey,
}: {
  message: UIMessage;
  participantsById: Map<string, Participant>;
  onSelectSubagent?: (step: SubagentStep) => void;
  selectedSubagentKey?: string | null;
}) {
  const parts = message.parts ?? [];

  // For user messages, render the text content
  if (message.role === "user") {
    const textParts = parts.filter(isTextUIPart);
    const raw = textParts.map((p) => p.text).join("\n").trim();
    if (!raw) return null;
    const text = cleanMessageText(raw, participantsById);
    return (
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
        <div className="whitespace-pre-wrap text-sm text-foreground">{text}</div>
      </div>
    );
  }

  if (message.role !== "assistant") return null;

  return (
    <AssistantParts
      parts={parts}
      participantsById={participantsById}
      onSelectSubagent={onSelectSubagent}
      selectedSubagentKey={selectedSubagentKey}
    />
  );
}

function AssistantParts({
  parts,
  participantsById,
  onSelectSubagent,
  selectedSubagentKey,
}: {
  parts: UIMessage["parts"];
  participantsById: Map<string, Participant>;
  onSelectSubagent?: (step: SubagentStep) => void;
  selectedSubagentKey?: string | null;
}) {
  // Group consecutive tool calls of the same category
  const elements = useMemo(() => buildElements(parts), [parts]);

  return (
    <div className="space-y-1.5">
      {elements.map((el) => (
        <PartElement
          key={el.key}
          element={el}
          participantsById={participantsById}
          onSelectSubagent={onSelectSubagent}
          selectedSubagentKey={selectedSubagentKey}
        />
      ))}
    </div>
  );
}

// ── Element types ─────────────────────────────────────────────────────────

type Element =
  | { kind: "text"; key: string; text: string; streaming: boolean; sources: StepSource[] }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | { kind: "tool-group"; key: string; group: ToolGroup }
  | { kind: "diff"; key: string; file: string; lang: string; oldStr: string; newStr: string; result?: string }
  | { kind: "terminal"; key: string; command: string; output?: string; exitCode?: number; streaming: boolean }
  | { kind: "error"; key: string; message: string }
  | { kind: "phase"; key: string; phase: string }
  | { kind: "subagent"; key: string; data: Record<string, unknown> }
  | { kind: "user-message"; key: string; data: Record<string, unknown> }
  | { kind: "context-message"; key: string; data: Record<string, unknown> }
  | { kind: "shell-command"; key: string; data: Record<string, unknown> }
  | { kind: "file-changes"; key: string; changes: Array<{ path: string; kind: string }> }
  | { kind: "system"; key: string; title: string; text: string; tone: "info" | "warn" };

function buildElements(parts: UIMessage["parts"]): Element[] {
  const elements: Element[] = [];
  let pendingToolGroup: ToolGroup | null = null;
  const sources: StepSource[] = [];

  const flushToolGroup = () => {
    if (!pendingToolGroup || pendingToolGroup.calls.length === 0) return;
    elements.push({
      kind: "tool-group",
      key: pendingToolGroup.key,
      group: pendingToolGroup,
    });
    pendingToolGroup = null;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partRec = part as Record<string, unknown>;
    const partType = asString(partRec.type);
    const partId = asString(partRec.id) || `part-${i}`;

    if (isTextUIPart(part)) {
      const text = part.text.trim();
      if (!text) continue;
      flushToolGroup();
      elements.push({
        kind: "text",
        key: `text:${partId}`,
        text,
        streaming: asString(partRec.state) === "streaming",
        sources: [...sources],
      });
      continue;
    }

    if (isReasoningUIPart(part)) {
      const text = (part.text ?? "").trim();
      if (!text) continue;
      flushToolGroup();
      elements.push({
        kind: "reasoning",
        key: `reasoning:${partId}`,
        text,
        streaming: asString(partRec.state) === "streaming",
      });
      continue;
    }

    if (partType === "error") {
      const errorText = asString(partRec.errorText).trim();
      if (!errorText) continue;
      flushToolGroup();
      elements.push({
        kind: "error",
        key: `error:${partId}`,
        message: errorText,
      });
      continue;
    }

    if (partType === "source-url") {
      const url = asString(partRec.url);
      if (url) sources.push({ url, title: asString(partRec.title) || url });
      continue;
    }

    // Tool call parts (dynamic-tool or tool-*)
    if (isToolUIPart(part)) {
      const toolName = asString(partRec.toolName) || (partType.startsWith("tool-") ? partType.slice(5) : "tool");
      const toolInput = asRecord(partRec.input);
      const toolCallId = asString(partRec.toolCallId) || `tool-${i}`;
      const outputText = stringifyToolOutput(partRec.output);
      const errorText = asString(partRec.errorText);
      const partState = asString(partRec.state);
      const hasError = Boolean(errorText) || partState === "output-error";
      const extractedSources = extractSourcesFromUnknown(partRec.output);
      if (extractedSources.length > 0) sources.push(...extractedSources);

      // str_replace → diff card
      if (toolName === "str_replace") {
        flushToolGroup();
        const path = asString(toolInput.path);
        const ext = path.split(".").pop()?.toLowerCase();
        elements.push({
          kind: "diff",
          key: `diff:${toolCallId}`,
          file: path,
          lang: ext || "txt",
          oldStr: asString(toolInput.old ?? toolInput.old_str),
          newStr: asString(toolInput.new ?? toolInput.new_str),
          result: hasError ? errorText : outputText || undefined,
        });
        continue;
      }

      // shell/bash → terminal
      if (toolName === "shell" || toolName === "bash") {
        flushToolGroup();
        elements.push({
          kind: "terminal",
          key: `terminal:${toolCallId}`,
          command: asString(toolInput.command),
          output: hasError ? errorText : outputText || undefined,
          streaming: partState === "input-available" || partState === "input-streaming",
        });
        continue;
      }

      // Regular tool → group
      const call: ToolCall = {
        id: toolCallId,
        name: toolName,
        input: toolInput,
        output: hasError ? undefined : outputText || undefined,
        rawOutput: hasError ? undefined : partRec.output,
        errorText: errorText || undefined,
        uiState: hasError ? "output-error" : outputText ? "output-available" : "input-available",
        state: hasError ? "error" : outputText ? "done" : "loading",
        sources: extractedSources.length > 0 ? dedupeSources(extractedSources) : undefined,
      };

      const { icon, category } = categorizeToolCall(toolName);
      if (pendingToolGroup && pendingToolGroup.category === category) {
        pendingToolGroup.calls.push(call);
      } else {
        flushToolGroup();
        pendingToolGroup = {
          key: `tool-group:${toolCallId}:${category}`,
          category,
          icon,
          calls: [call],
        };
      }
      continue;
    }

    // Custom data parts — use isDataUIPart for the generic check, then route by type
    if (isDataUIPart(part)) {
      const data = asRecord(partRec.data);

      if (partType === "data-phase-progress") {
        const phase = asString(data.phase);
        if (!phase) continue;
        flushToolGroup();
        elements.push({ kind: "phase", key: `phase:${partId}`, phase });
        continue;
      }

      if (partType === "data-subagent") {
        if (!asString(data.status)) continue;
        flushToolGroup();
        elements.push({ kind: "subagent", key: `subagent:${partId}`, data });
        continue;
      }

      if (partType === "data-user-message") {
        const text = asString(data.text).trim();
        if (!text) continue;
        flushToolGroup();
        elements.push({ kind: "user-message", key: `user:${partId}`, data });
        continue;
      }

      if (partType === "data-context-message") {
        const text = asString(data.text).trim();
        if (!text) continue;
        flushToolGroup();
        elements.push({ kind: "context-message", key: `context:${partId}`, data });
        continue;
      }

      if (partType === "data-shell-command") {
        flushToolGroup();
        elements.push({ kind: "shell-command", key: `shell:${partId}`, data });
        continue;
      }

      if (partType === "data-file-changes") {
        const changes = Array.isArray(data.changes)
          ? data.changes.map((c) => asRecord(c)).map((c) => ({
              path: asString(c.path),
              kind: asString(c.kind) || "update",
            })).filter((c) => c.path)
          : [];
        if (changes.length === 0) continue;
        flushToolGroup();
        elements.push({ kind: "file-changes", key: `files:${partId}`, changes });
        continue;
      }

      if (partType === "data-system-event") {
        const text = asString(data.text).trim();
        if (!text) continue;
        flushToolGroup();
        elements.push({
          kind: "system",
          key: `system:${partId}`,
          title: asString(data.title) || "System",
          text,
          tone: asString(data.tone) === "warn" ? "warn" : "info",
        });
        continue;
      }
    }
  }

  flushToolGroup();
  return elements;
}

// ── Part element renderer ─────────────────────────────────────────────────

function PartElement({
  element,
  participantsById,
  onSelectSubagent,
  selectedSubagentKey,
}: {
  element: Element;
  participantsById: Map<string, Participant>;
  onSelectSubagent?: (step: SubagentStep) => void;
  selectedSubagentKey?: string | null;
}) {
  switch (element.kind) {
    case "text":
      return (
        <div className="rounded-lg border border-border/50 bg-card/30 px-2.5 py-2">
          <MessageActions className="mb-1">
            <MessageAction
              tooltip="Copy result"
              onClick={() => copyToClipboard(element.text, "Result copied")}
            >
              <CopyIcon className="size-3.5" />
            </MessageAction>
          </MessageActions>
          <div className={element.streaming ? "streaming-cursor" : ""}>
            <MessageResponse>{element.text}</MessageResponse>
          </div>
          {element.sources.length > 0 && (
            <Sources className="mt-2">
              <SourcesTrigger count={element.sources.length} />
              <SourcesContent>
                {element.sources.map((s) => (
                  <Source key={s.url} href={s.url} title={s.title} />
                ))}
              </SourcesContent>
            </Sources>
          )}
        </div>
      );

    case "reasoning":
      return (
        <Reasoning isStreaming={element.streaming}>
          <ReasoningTrigger />
          <ReasoningContent>{element.text}</ReasoningContent>
        </Reasoning>
      );

    case "tool-group":
      return (
        <StepGroup
          icon={element.group.icon}
          summary={summarizeGroup(element.group.category, element.group.calls)}
          calls={element.group.calls}
        />
      );

    case "diff":
      return (
        <DiffCard
          file={element.file}
          lang={element.lang}
          oldStr={element.oldStr}
          newStr={element.newStr}
          result={element.result}
        />
      );

    case "terminal":
      return (
        <Terminal
          output={`$ ${element.command}${element.output ? `\n${element.output}` : ""}`}
          isStreaming={element.streaming}
          className={
            typeof element.exitCode === "number" && element.exitCode !== 0
              ? "border-destructive/30"
              : "border-border/70"
          }
        >
          <TerminalHeader>
            <TerminalTitle>Ran shell command</TerminalTitle>
            <div className="flex items-center gap-1">
              <TerminalStatus />
              {typeof element.exitCode === "number" && (
                <Badge
                  variant={element.exitCode !== 0 ? "destructive" : "secondary"}
                  className="text-xs"
                >
                  exit {element.exitCode}
                </Badge>
              )}
              <TerminalActions>
                <TerminalCopyButton />
              </TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent className="max-h-64" />
        </Terminal>
      );

    case "error":
      return (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {element.message}
        </div>
      );

    case "phase":
      return (
        <Checkpoint>
          <CheckpointIcon className="size-3 text-primary" />
          <span className="shrink-0 px-2 text-xs font-medium uppercase tracking-wider">
            {element.phase}
          </span>
        </Checkpoint>
      );

    case "subagent": {
      const d = element.data;
      const step: SubagentStep = {
        id: asString(d.subagent_id) || element.key,
        type: "subagent",
        subagentId: asString(d.subagent_id) || undefined,
        status: asString(d.status) || "running",
        name: asString(d.name) || undefined,
        summary: asString(d.summary) || undefined,
        error: asString(d.error) || undefined,
        phase: asString(d.phase) || undefined,
        model: asString(d.model) || undefined,
        turns: asNumber(d.turns) ?? undefined,
        toolCalls: asNumber(d.tool_calls) ?? undefined,
        durationS: asNumber(d.duration_s) ?? undefined,
        inputTokens: asNumber(d.input_tokens) ?? undefined,
        outputTokens: asNumber(d.output_tokens) ?? undefined,
        totalTokens: asNumber(d.total_tokens) ?? undefined,
        costUsd: asNumber(d.cost_usd),
        branchIndex: asNumber(d.branch_index) ?? undefined,
        totalBranches: asNumber(d.total_branches) ?? undefined,
        completed: asNumber(d.completed) ?? undefined,
        acceptable: asNumber(d.acceptable) ?? undefined,
        failed: asNumber(d.failed) ?? undefined,
        completedCount: asNumber(d.completed_count) ?? undefined,
        acceptableCount: asNumber(d.acceptable_count) ?? undefined,
        failedCount: asNumber(d.failed_count) ?? undefined,
        isAcceptable: asBoolean(d.is_acceptable) ?? undefined,
        maxParallel: asNumber(d.max_parallel) ?? undefined,
        activity: asString(d.activity) || undefined,
      };
      return (
        <SubagentCard
          step={step}
          onSelect={onSelectSubagent}
          isSelected={selectedSubagentKey === subagentSelectionKey(step)}
        />
      );
    }

    case "user-message": {
      const d = element.data;
      const userId = asString(d.user_id);
      const participant = userId ? participantsById.get(userId) : undefined;
      const displayName = participantDisplayName(participant, userId, "User");
      const msgText = cleanMessageText(asString(d.text), participantsById);
      return (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            {participant?.avatar_url ? (
              <img src={participant.avatar_url} alt={displayName} className="size-[18px] rounded-full" />
            ) : (
              <div className="flex size-[18px] items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {initials(displayName)}
              </div>
            )}
            <span className="text-sm font-medium text-foreground">{displayName}</span>
            <span className="rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs">
              {sourceLabel(asString(d.source))}
            </span>
          </div>
          <div className="whitespace-pre-wrap text-sm text-foreground">{msgText}</div>
        </div>
      );
    }

    case "context-message": {
      const d = element.data;
      const userId = asString(d.user_id);
      const participant = userId ? participantsById.get(userId) : undefined;
      const displayName = participantDisplayName(participant, userId, "Thread participant");
      const msgText = cleanMessageText(asString(d.text), participantsById);
      return (
        <div className="rounded-md border border-border/50 bg-background px-2 py-1.5">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            {participant?.avatar_url ? (
              <img src={participant.avatar_url} alt={displayName} className="size-[16px] rounded-full" />
            ) : (
              <div className="flex size-[16px] items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground">
                {initials(displayName)}
              </div>
            )}
            <span className="text-foreground">{displayName}</span>
            <span>{sourceLabel(asString(d.source))}</span>
          </div>
          <div className="whitespace-pre-wrap text-xs text-muted-foreground">{msgText}</div>
        </div>
      );
    }

    case "shell-command": {
      const d = element.data;
      const command = asString(d.command);
      const output = stringifyToolOutput(d.output);
      const exitCode = typeof d.exitCode === "number" ? d.exitCode : undefined;
      const isFailed = typeof exitCode === "number" && exitCode !== 0;
      const combinedOutput = [`$ ${command}`, output, exitCode !== undefined ? `[exit ${exitCode}]` : ""]
        .filter(Boolean)
        .join("\n");
      return (
        <Terminal output={combinedOutput} className={isFailed ? "border-destructive/30" : "border-border/70"}>
          <TerminalHeader>
            <TerminalTitle>Ran shell command</TerminalTitle>
            <div className="flex items-center gap-1">
              <TerminalStatus />
              {typeof exitCode === "number" && (
                <Badge variant={isFailed ? "destructive" : "secondary"} className="text-xs">
                  exit {exitCode}
                </Badge>
              )}
              <TerminalActions>
                <TerminalCopyButton />
              </TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent className="max-h-64" />
        </Terminal>
      );
    }

    case "file-changes":
      return (
        <FileTree defaultExpanded={new Set<string>()}>
          {element.changes.map((change) => (
            <FileTreeFile
              key={change.path}
              path={change.path}
              name={`${change.kind === "add" ? "+" : change.kind === "delete" ? "-" : "~"} ${change.path}`}
              className={
                change.kind === "add"
                  ? "text-primary"
                  : change.kind === "delete"
                    ? "text-destructive"
                    : "text-muted-foreground"
              }
            />
          ))}
        </FileTree>
      );

    case "system":
      return (
        <div
          className={cn(
            "rounded-xl border px-3 py-2 text-xs",
            element.tone === "warn" ? "border-primary/30 bg-primary/10" : "border-border/60 bg-card/40",
          )}
        >
          <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">{element.title}</div>
          <div className="whitespace-pre-wrap text-muted-foreground">{element.text}</div>
        </div>
      );
  }
}
