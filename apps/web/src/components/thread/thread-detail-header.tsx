"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  CircleStop,
  Info,
  Menu,
  RefreshCw,
  Timer,
} from "lucide-react";
import type { ThreadDetail, ThreadTokenUsage } from "@/lib/types";
import {
  formatTokenUsageCount,
  formatTokenUsageTicker,
  tokenUsageBreakdownLabel,
  tokenUsageConfidenceLabel,
  tokenUsageModelLabel,
  tokenUsageModelsList,
} from "@/lib/token-usage";
import { Button } from "@/components/ui/button";
import { useHaptics } from "@/components/haptics-provider";
import { SurfaceBar } from "@/components/ui/surface-bar";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { StateDot } from "@/components/ui/state-dot";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { PhaseProgress } from "@/components/thread/phase-progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  categorizeAgentStatusText,
  threadStateLabel,
} from "@/lib/status-semantics";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { TextReveal } from "@/components/ai-elements/text-reveal";

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
  const showError =
    !!error &&
    !(thread.state === "error" && error.startsWith("Stream disconnected."));
  const statusSummary = useMemo(() => {
    if (thread.state === "error") {
      return { icon: Bot, text: error || "Agent encountered an error" };
    }
    if (thread.state === "stopping") {
      return { icon: Bot, text: "Stopping run…" };
    }
    if (isRunning) return categorizeAgentStatusText(stableStatus);
    return { icon: Bot, text: "Idle" };
  }, [error, isRunning, stableStatus, thread.state]);

  return (
    <SurfaceBar className="relative shrink-0 border-b border-border/70">
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <Button
          type="button"
          onClick={() => {
            trigger("light");
            onOpenDrawer();
          }}
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
          onClick={() => {
            trigger("light");
            onBack();
          }}
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
          className="hidden size-9 items-center justify-center rounded-lg p-1 text-xs ui-control-icon md:inline-flex"
          data-touch-target
        >
          <ArrowUp className="size-3.5" />
        </Link>

        <HarnessBadge harness={thread.harness} className="flex-shrink-0" />

        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-balance">
          {humanName}
        </span>

        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/65 px-2 py-0.5 text-detail uppercase tracking-wide text-muted-foreground">
          <StateDot state={thread.state} className="flex-shrink-0" />
          <span className="hidden min-[380px]:inline">
            {threadStateLabel(thread.state)}
          </span>
        </span>

        <span className="hidden md:inline-flex">
          <ParticipantAvatars participants={thread.participants} size={20} />
        </span>
        <span className="hidden text-xs text-muted-foreground lg:inline">
          <AnimatedNumber value={thread.message_count} /> msg
          {thread.message_count === 1 ? "" : "s"}
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
        <span
          className="hidden text-xs font-mono text-muted-foreground xl:inline"
          title="Open command palette"
        >
          Cmd+K
        </span>

        <Button
          type="button"
          onClick={() => {
            trigger("light");
            onOpenInfo();
          }}
          variant="ghost"
          size="icon"
          className="ui-control-icon"
          aria-label="Thread info"
          data-touch-target
        >
          <Info className="size-4" />
        </Button>

        {canInterrupt && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={() => {
                  trigger("warning");
                  onInterrupt();
                }}
                disabled={isInterrupting}
                variant="destructive"
                size="xs"
                className="hidden items-center gap-1 border border-destructive/35 bg-destructive/8 text-destructive hover:bg-destructive/14 disabled:opacity-60 md:inline-flex"
              >
                <CircleStop
                  className={isInterrupting ? "size-3.5 animate-pulse" : "size-3.5"}
                />
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
              onClick={() => {
                trigger("light");
                onRefresh();
              }}
              variant="outline"
              size="xs"
              className="hidden items-center gap-1 border-border/70 bg-card/45 text-muted-foreground hover:bg-accent hover:text-foreground md:inline-flex"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh Alt+R</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-8 items-center gap-2 border-t border-border/50 bg-background/45 px-3 py-2 text-xs">
        <span className="rounded-md border border-border/60 bg-secondary/65 px-1.5 py-0.5 text-xs text-muted-foreground">
          {sourceLabel}
        </span>
        <statusSummary.icon className="size-3.5 text-muted-foreground" />
        <span
          className={
            thread.state === "error"
              ? "truncate text-destructive"
              : "truncate text-muted-foreground"
          }
        >
          <TextReveal text={statusSummary.text} />
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
            (thread.state === "error" && error?.startsWith("Stream disconnected.")
              ? null
              : error)}
        </div>
      )}

      {isEngineer && phases.length > 0 && (
        <div className="border-t border-border/50 px-3 py-2">
          <PhaseProgress phases={phases} />
        </div>
      )}
    </SurfaceBar>
  );
}
