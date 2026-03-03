"use client";

import {
  AlertTriangle,
  ChevronRight,
  CopyIcon,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import type { Step } from "@/lib/describe";
import type { Participant } from "@/lib/types";
import { DiffCard } from "@/components/thread/diff-card";
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
import {
  Agent,
  AgentHeader,
  AgentContent,
} from "@/components/ai-elements/agent";
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
import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceFrames,
  StackTraceHeader,
} from "@/components/ai-elements/stack-trace";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function sourceLabel(source?: string): string {
  const normalized = (source ?? "").trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (normalized === "thread_ui") return "Thread Viewer";
  if (normalized === "slack") return "Slack";
  if (normalized === "slack_subscribed_message") return "Slack Thread";
  if (normalized === "api") return "API";
  return normalized.replace(/_/g, " ");
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/;

function participantDisplayName(
  participant: Participant | undefined,
  userId: string | undefined,
  fallback: string,
): string {
  const participantName = String(participant?.name || "").trim();
  if (participantName && !SLACK_USER_ID_RE.test(participantName)) return participantName;
  const id = String(userId || participant?.id || "").trim();
  if (!id) return fallback;
  if (SLACK_USER_ID_RE.test(id)) return `User ${id.slice(-4)}`;
  return id;
}

function fileChangeIcon(kind: string): string {
  if (kind === "add") return "text-emerald-500";
  if (kind === "delete") return "text-destructive";
  return "text-amber-500";
}

function looksLikeStackTrace(text: string): boolean {
  return /^\s*at\s+/m.test(text) && /Error[:]/i.test(text);
}

function copyToClipboard(text: string, label?: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast("Clipboard unavailable");
    return;
  }
  void navigator.clipboard.writeText(text).then(() => {
    toast(label || "Copied to clipboard");
  }).catch(() => {
    toast("Failed to copy");
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

export function MessagePartRenderer({
  step,
  participantsById,
  turnDurationsById,
}: {
  step: Step;
  participantsById: Map<string, Participant>;
  turnDurationsById: Record<number, number>;
}) {
  if (step.type === "phase") {
    return (
      <Checkpoint>
        <CheckpointIcon className="size-3 text-primary" />
        <span className="shrink-0 px-2 text-[10px] font-medium uppercase tracking-wider">
          {step.phase}
        </span>
      </Checkpoint>
    );
  }

  if (step.type === "thinking") {
    return (
      <Reasoning duration={step.durationS} isStreaming={Boolean(step.streaming)}>
        <ReasoningTrigger />
        <ReasoningContent>{step.text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (step.type === "subagent") {
    const normalizedStatus = step.status.trim().toLowerCase();
    const isDone = normalizedStatus === "completed" || normalizedStatus === "selected";
    const isFailed = normalizedStatus === "failed";
    const stats: string[] = [];
    if (step.phase) stats.push(step.phase);
    if (step.completed !== undefined && step.totalBranches !== undefined) {
      stats.push(`${step.completed}/${step.totalBranches} done`);
    }
    if (step.turns !== undefined) stats.push(`${step.turns} turns`);
    if (step.toolCalls !== undefined) stats.push(`${step.toolCalls} tool calls`);
    if (step.durationS !== undefined) stats.push(formatDuration(step.durationS));
    if (step.totalTokens !== undefined) {
      const tokenStr = `${Math.max(0, step.totalTokens).toLocaleString()} tok`;
      const costStr = step.costUsd != null ? ` / $${step.costUsd.toFixed(4)}` : "";
      stats.push(`${tokenStr}${costStr}`);
    }
    if (step.maxParallel !== undefined && step.maxParallel > 1) {
      stats.push(`${step.maxParallel}x parallel`);
    }

    return (
      <Agent className={isFailed ? "border-destructive/30" : isDone ? "border-emerald-500/30" : ""}>
        <AgentHeader name={step.name || "Subagent"} model={step.model} />
        <AgentContent>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge
              variant={isFailed ? "destructive" : isDone ? "default" : "secondary"}
              className="text-[10px]"
            >
              {normalizedStatus.replace(/_/g, " ") || "update"}
            </Badge>
            {stats.map((stat) => (
              <span key={stat} className="text-muted-foreground">{stat}</span>
            ))}
          </div>
          {step.summary ? <p className="text-xs">{step.summary}</p> : null}
          {step.error ? <p className="text-xs font-medium text-destructive">{step.error}</p> : null}
        </AgentContent>
      </Agent>
    );
  }

  if (step.type === "tool-group") {
    return <StepGroup icon={step.icon} summary={step.summary} calls={step.calls} />;
  }

  if (step.type === "diff") {
    return (
      <DiffCard
        file={step.file}
        lang={step.lang}
        oldStr={step.oldStr}
        newStr={step.newStr}
        result={step.result}
      />
    );
  }

  if (step.type === "terminal") {
    const exitLabel = typeof step.exitCode === "number" ? `[exit ${step.exitCode}]` : "";
    const combinedOutput = [
      `$ ${step.command}`,
      step.output || "",
      exitLabel,
    ].filter(Boolean).join("\n");
    const isFailed = typeof step.exitCode === "number" && step.exitCode !== 0;
    return (
      <Terminal
        output={combinedOutput}
        isStreaming={Boolean(step.streaming)}
        className={isFailed ? "border-destructive/30" : ""}
      >
        <TerminalHeader>
          <TerminalTitle>{step.description}</TerminalTitle>
          <div className="flex items-center gap-1">
            <TerminalStatus />
            {typeof step.exitCode === "number" && (
              <Badge variant={isFailed ? "destructive" : "secondary"} className="text-[10px]">
                exit {step.exitCode}
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

  if (step.type === "file-changes") {
    const defaultExpanded = new Set<string>();
    return (
      <FileTree defaultExpanded={defaultExpanded}>
        {step.changes.map((change) => (
          <FileTreeFile
            key={change.path}
            path={change.path}
            name={`${change.kind === "add" ? "+" : change.kind === "delete" ? "-" : "~"} ${change.path}`}
            className={fileChangeIcon(change.kind)}
          />
        ))}
      </FileTree>
    );
  }

  if (step.type === "error") {
    if (looksLikeStackTrace(step.message)) {
      return (
        <StackTrace trace={step.message} defaultOpen role="alert" className="border-destructive/30">
          <StackTraceHeader>
            <StackTraceError>
              <StackTraceErrorType />
              <StackTraceErrorMessage />
            </StackTraceError>
            <StackTraceActions>
              <StackTraceCopyButton />
            </StackTraceActions>
            <StackTraceExpandButton />
          </StackTraceHeader>
          <StackTraceContent>
            <StackTraceFrames />
          </StackTraceContent>
        </StackTrace>
      );
    }
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        <AlertTriangle className="size-4 shrink-0" />
        {step.message}
      </div>
    );
  }

  if (step.type === "user-message") {
    const participant = step.userId ? participantsById.get(step.userId) : undefined;
    const displayName = participantDisplayName(participant, step.userId, "User");
    const turnDuration = step.turnId ? turnDurationsById[step.turnId] : undefined;
    return (
      <div className="rounded-sm border-l-[3px] border-l-primary bg-primary/5 px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          {participant?.avatar_url ? (
            <img src={participant.avatar_url} alt={displayName} className="size-[18px] rounded-full" />
          ) : (
            <div className="flex size-[18px] items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
              {initials(displayName)}
            </div>
          )}
          <span className="text-sm font-medium text-foreground">{displayName}</span>
          {typeof turnDuration === "number" ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
              <Timer className="size-3" />
              {formatDuration(turnDuration)}
            </span>
          ) : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
            {sourceLabel(step.source)}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground">{step.text}</div>
      </div>
    );
  }

  if (step.type === "context-group") {
    return (
      <details className="group rounded-lg border border-border/40 bg-card/40">
        <summary className="flex min-h-[44px] list-none cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          {step.items.length} message{step.items.length === 1 ? "" : "s"} in thread
        </summary>
        <div className="space-y-2 px-3 pb-3">
          {step.items.map((item) => {
            const participant = item.userId ? participantsById.get(item.userId) : undefined;
            const displayName = participantDisplayName(
              participant,
              item.userId,
              "Thread participant",
            );
            return (
              <div key={item.id} className="rounded border border-border/50 bg-background px-2 py-1.5">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="text-foreground">{displayName}</span>
                  <span>{sourceLabel(item.source)}</span>
                </div>
                <div className="whitespace-pre-wrap text-xs text-muted-foreground">{item.text}</div>
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  if (step.type === "result") {
    return (
      <div className="rounded-md border border-border bg-card px-3 py-2">
        <MessageActions className="mb-1">
          <MessageAction
            tooltip="Copy result"
            onClick={() => copyToClipboard(step.text, "Result copied")}
          >
            <CopyIcon className="size-3.5" />
          </MessageAction>
        </MessageActions>
        <div className={step.streaming ? "streaming-cursor" : ""}>
          <MessageResponse>{step.text}</MessageResponse>
        </div>
        {step.sources && step.sources.length > 0 ? (
          <Sources className="mt-2">
            <SourcesTrigger count={step.sources.length} />
            <SourcesContent>
              {step.sources.map((source) => (
                <Source key={source.url} href={source.url} title={source.title} />
              ))}
            </SourcesContent>
          </Sources>
        ) : null}
      </div>
    );
  }

  if (step.type === "system") {
    return (
      <div
        className={cn(
          "rounded-md border px-3 py-2 text-xs",
          step.tone === "warn" ? "border-amber-500/30 bg-amber-500/10" : "border-border/60 bg-card/40",
        )}
      >
        <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">{step.title}</div>
        <div className="whitespace-pre-wrap text-muted-foreground">{step.text}</div>
      </div>
    );
  }

  return null;
}
