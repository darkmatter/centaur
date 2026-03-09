"use client";

import { useMemo, type ComponentType } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Brain,
  CircleStop,
  FilePenLine,
  FileText,
  Globe,
  Info,
  Menu,
  RefreshCw,
  SearchCode,
  SquareTerminal,
  Timer,
} from "lucide-react";
import type { ThreadDetail, ThreadTokenUsage } from "@/lib/types";
import {
  tokenUsageBreakdownLabel,
  formatTokenUsageCount,
  formatTokenUsageTicker,
  tokenUsageModelsList,
  tokenUsageConfidenceLabel,
  tokenUsageModelLabel,
} from "@/lib/token-usage";
import { Button } from "@/components/ui/button";
import { useHaptics } from "@/components/haptics-provider";
import { SurfaceBar } from "@/components/ui/surface-bar";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { StateDot } from "@/components/ui/state-dot";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { PhaseProgress } from "@/components/thread/phase-progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ThreadDetailHeaderProps = {
  thread: ThreadDetail;
  humanName: string;
  tokenUsage: ThreadTokenUsage | null;
  liveElapsed: string;
  stableStatus: string | null;
  isRunning: boolean;
  isEngineer: boolean;
  phases: string[];
  error: string | null;
  interruptError: string | null;
  canInterrupt: boolean;
  isInterrupting: boolean;
  onInterrupt: () => void;
  onRefresh: () => void;
  onOpenInfo: () => void;
  onOpenDrawer: () => void;
  sourceLabel: string;
  onBack: () => void;
  upHref: string;
};

function normalizeStatusLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function categorizeStatus(status: string | null): {
  icon: ComponentType<{ className?: string }>;
  text: string;
} {
  const raw = normalizeStatusLabel(status ?? "");
  const lower = raw.toLowerCase();
  if (!raw) return { icon: Bot, text: "Working" };
  if (/search|grep|find/.test(lower)) return { icon: SearchCode, text: raw };
  if (/read|reading/.test(lower)) return { icon: FileText, text: raw };
  if (/edit|write|creat/.test(lower)) return { icon: FilePenLine, text: raw };
  if (/run|shell|command/.test(lower)) return { icon: SquareTerminal, text: raw };
  if (/fetch|web/.test(lower)) return { icon: Globe, text: raw };
  if (/think|reason/.test(lower)) return { icon: Brain, text: raw };
  return { icon: Bot, text: raw };
}

export function ThreadDetailHeader({
  thread,
  humanName,
  tokenUsage,
  liveElapsed,
  stableStatus,
  isRunning,
  isEngineer,
  phases,
  error,
  interruptError,
  canInterrupt,
  isInterrupting,
  onInterrupt,
  onRefresh,
  onOpenInfo,
  onOpenDrawer,
  sourceLabel,
  onBack,
  upHref,
}: ThreadDetailHeaderProps) {
  const { trigger } = useHaptics();
  const usageConfidence = tokenUsageConfidenceLabel(tokenUsage);
  const tokenTicker = formatTokenUsageTicker(tokenUsage);
  const modelLabel = tokenUsageModelLabel(tokenUsage);
  const modelList = tokenUsageModelsList(tokenUsage);
  const breakdownLabel = tokenUsageBreakdownLabel(tokenUsage);
  const showError = !!error && !(thread.state === "error" && error.startsWith("Stream disconnected."));
  const statusSummary = useMemo(() => {
    if (thread.state === "error") return { icon: Bot, text: error || "Agent encountered an error" };
    if (thread.state === "stopping") return { icon: Bot, text: "Stopping run…" };
    if (isRunning) return categorizeStatus(stableStatus);
    return { icon: Bot, text: "Idle" };
  }, [error, isRunning, stableStatus, thread.state]);

  return (
    <SurfaceBar className="relative shrink-0 border-b border-border/70">
      <div className="flex min-h-10 items-center gap-2 px-2.5 py-1.5">
        <Button
          type="button"
          onClick={() => { trigger("light"); onOpenDrawer(); }}
          variant="ghost"
          size="icon"
          className="ui-control-icon md:hidden"
          aria-label="Open thread list"
          data-touch-target
        >
          <Menu className="size-5" />
        </Button>

        <Button
          type="button"
          onClick={() => { trigger("light"); onBack(); }}
          variant="ghost"
          size="icon-sm"
          className="mr-0.5 ui-control-icon"
          aria-label="Back to source"
          data-touch-target
        >
          <ArrowLeft className="size-4" />
        </Button>

        <Link
          href={upHref}
          scroll={false}
          aria-label="Up to threads"
          className="hidden size-9 rounded-lg ui-control-icon p-1 md:inline-flex items-center justify-center text-xs"
          data-touch-target
        >
          <ArrowUp className="size-3.5" />
        </Link>

        <HarnessBadge harness={thread.harness} className="flex-shrink-0" />

        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-balance">{humanName}</span>

        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/65 px-2 py-0.5 text-detail uppercase tracking-wide text-muted-foreground">
          <StateDot state={thread.state} className="flex-shrink-0" />
          <span className="hidden min-[380px]:inline">{thread.state}</span>
        </span>

        <span className="hidden md:inline-flex">
          <ParticipantAvatars participants={thread.participants} size={20} />
        </span>
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {thread.message_count} msg{thread.message_count === 1 ? "" : "s"}
        </span>
        {tokenTicker ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-xs font-mono tabular-nums text-muted-foreground md:inline-flex">
                {tokenTicker}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5 text-xs">
                <div>Total: {formatTokenUsageCount(tokenUsage?.total_tokens ?? null)}</div>
                <div>Input: {formatTokenUsageCount(tokenUsage?.input_tokens ?? null)}</div>
                <div>Output: {formatTokenUsageCount(tokenUsage?.output_tokens ?? null)}</div>
                <div>Split: {breakdownLabel}</div>
                <div>Model: {modelList}</div>
                <div>Usage: {usageConfidence}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <span className="hidden items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-xs font-mono tabular-nums text-muted-foreground lg:inline-flex">
          <Timer className="size-3.5" />
          {liveElapsed}
        </span>
        <span className="hidden text-xs font-mono text-muted-foreground xl:inline" title="Open command palette">
          Cmd+K
        </span>

        <Button
          type="button"
          onClick={() => { trigger("light"); onOpenInfo(); }}
          variant="ghost"
          size="icon"
          className="ui-control-icon md:hidden"
          aria-label="Thread info"
          data-touch-target
        >
          <Info className="size-4" />
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="hidden rounded-lg ui-control-icon p-1.5 md:block"
              aria-label="Show thread metadata"
            >
              <Info className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-popover-w">
            <div className="space-y-2 text-xs">
              <div className="font-semibold text-foreground">Debug IDs</div>
              <div className="font-mono text-muted-foreground break-all">{thread.slack_thread_key}</div>
            </div>
          </PopoverContent>
        </Popover>

        {canInterrupt && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={() => { trigger("warning"); onInterrupt(); }}
                disabled={isInterrupting}
                variant="destructive"
                size="xs"
                className="hidden md:inline-flex items-center gap-1 border border-destructive/35 bg-destructive/8 text-destructive hover:bg-destructive/14 disabled:opacity-60"
              >
                <CircleStop className={isInterrupting ? "size-3.5 animate-pulse" : "size-3.5"} />
                {isInterrupting ? "Stopping…" : "Stop"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop Alt+S</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              onClick={() => { trigger("light"); onRefresh(); }}
              variant="outline"
              size="xs"
              className="hidden md:inline-flex items-center gap-1 border-border/70 bg-card/45 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh Alt+R</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-7 items-center gap-2 border-t border-border/50 bg-background/45 px-2.5 py-1 text-xs">
        <span className="rounded-md border border-border/60 bg-secondary/65 px-1.5 py-0.5 text-xs text-muted-foreground">
          {sourceLabel}
        </span>
        <statusSummary.icon className="size-3.5 text-muted-foreground" />
        <span className={thread.state === "error" ? "text-destructive truncate" : "text-muted-foreground truncate"}>
          {statusSummary.text}
        </span>
        {!tokenTicker && modelLabel ? (
          <span className="ml-auto hidden rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground md:inline">
            {modelLabel}
          </span>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        Status: {statusSummary.text}
      </div>

      {(showError || !!interruptError) && (
        <div
          role="alert"
          className="inline-flex items-center gap-1.5 border-t border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <RefreshCw className="size-3.5" />
          {interruptError ??
            (thread.state === "error" && error?.startsWith("Stream disconnected.") ? null : error)}
        </div>
      )}

      {isEngineer && phases.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border/50">
          <PhaseProgress phases={phases} />
        </div>
      )}
    </SurfaceBar>
  );
}
