"use client";

import { memo } from "react";
import {
  ArrowLeft,
  CheckCircle,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SurfaceBar } from "@/components/ui/surface-bar";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { categorizeToolCall } from "@/lib/describe";
import type { SubagentActivity, SubagentStep } from "@/lib/describe";
import {
  getSubagentPreviewText,
  isSubagentTerminal,
  normalizeSubagentStatus,
  subagentSelectionKey,
  subagentStatusLabel,
} from "@/lib/viewer/subagent-steps";
import { subagentIdentityIcon } from "@/components/thread/subagent-card";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: string }) {
  const normalized = normalizeSubagentStatus(status);
  const isDone = normalized === "completed" || normalized === "selected";
  const isFailed = normalized === "failed";
  return (
    <Badge
      variant={isFailed ? "destructive" : isDone ? "default" : "secondary"}
      className="text-3xs"
    >
      {subagentStatusLabel(status)}
    </Badge>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="thread-surface-soft rounded-lg px-3 py-2">
      <div className="text-detail uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-mono tabular-nums text-foreground/85">{value}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="stat-row-value truncate text-right text-xs font-mono tabular-nums text-foreground/82">
        {value}
      </span>
    </div>
  );
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border/60 bg-background/40 px-2 py-1 text-detail text-muted-foreground">
      {children}
    </span>
  );
}

function ActivityTimeline({
  activities,
  isRunning,
  isFailed,
}: {
  activities: SubagentActivity[];
  isRunning: boolean;
  isFailed: boolean;
}) {
  if (activities.length === 0) return null;
  return (
    <div className="space-y-0">
      {activities.map((act, i) => {
        const isLast = i === activities.length - 1;
        const showSpinner = isLast && isRunning;
        const ActivityIcon = act.toolName ? categorizeToolCall(act.toolName).icon : null;
        return (
          <div key={`${act.toolName ?? ""}:${act.description}:${i}`} className="grid grid-timeline gap-3 pb-3 last:pb-0">
            <div className="relative flex justify-center">
              {!isLast && (
                <span className="absolute left-1/2 top-4 bottom-timeline-tail w-px -translate-x-1/2 bg-border/40" />
              )}
              {showSpinner ? (
                <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
              ) : isLast && isFailed ? (
                <CircleX className="size-3.5 text-destructive/80" />
              ) : ActivityIcon ? (
                <ActivityIcon className="size-3.5 text-muted-foreground/80" />
              ) : (
                <CheckCircle className="size-3.5 text-primary/70" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm leading-6 text-foreground/82">{act.description}</p>
              {act.toolName && (
                <p className="mt-0.5 text-detail font-mono text-muted-foreground/75">
                  {act.toolName}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const SubagentDetailContent = memo(function SubagentDetailContent({
  step,
}: {
  step: SubagentStep;
}) {
  const isTerminal = isSubagentTerminal(step.status);
  const isRunning = !isTerminal;
  const isFailed = normalizeSubagentStatus(step.status) === "failed";
  const activities = step.activities ?? [];
  const acceptableCount = step.acceptableCount ?? step.acceptable;
  const failedCount = step.failedCount ?? step.failed;

  return (
    <div className="thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="space-y-5 px-4 py-4 md:px-6 md:py-5 safe-area-bottom">
        {(step.turns !== undefined ||
          step.toolCalls !== undefined ||
          step.durationS !== undefined ||
          step.totalTokens !== undefined ||
          step.costUsd != null ||
          (step.maxParallel !== undefined && step.maxParallel > 1) ||
          step.totalBranches !== undefined ||
          acceptableCount !== undefined ||
          failedCount !== undefined ||
          step.inputTokens !== undefined ||
          step.outputTokens !== undefined ||
          step.branchIndex !== undefined) && (
          <section>
            <div className="mb-3 text-detail font-medium uppercase tracking-section text-muted-foreground">
              Overview
            </div>
            <div className="grid grid-cols-2 gap-2">
              {step.durationS !== undefined && <StatCard label="Duration" value={formatDuration(step.durationS)} />}
              {step.toolCalls !== undefined && <StatCard label="Tools" value={String(step.toolCalls)} />}
              {step.turns !== undefined && <StatCard label="Turns" value={String(step.turns)} />}
              {step.totalTokens !== undefined && <StatCard label="Tokens" value={formatTokens(step.totalTokens)} />}
              {step.inputTokens !== undefined && <StatCard label="Input" value={formatTokens(step.inputTokens)} />}
              {step.outputTokens !== undefined && <StatCard label="Output" value={formatTokens(step.outputTokens)} />}
              {step.costUsd != null && <StatCard label="Cost" value={`$${step.costUsd.toFixed(4)}`} />}
              {step.maxParallel !== undefined && step.maxParallel > 1 && (
                <StatCard label="Parallel" value={`${step.maxParallel}x`} />
              )}
              {step.totalBranches !== undefined && (
                <StatCard
                  label="Branches"
                  value={`${step.completed ?? step.completedCount ?? 0}/${step.totalBranches}`}
                />
              )}
              {acceptableCount !== undefined && (
                <StatCard label="Accepted" value={String(acceptableCount)} />
              )}
              {failedCount !== undefined && (
                <StatCard label="Failed" value={String(failedCount)} />
              )}
              {step.branchIndex !== undefined && (
                <StatCard label="Branch" value={String(step.branchIndex)} />
              )}
            </div>
          </section>
        )}

        {activities.length > 0 && (
          <section>
            <div className="mb-3 text-detail font-medium uppercase tracking-section text-muted-foreground">
              Activity
            </div>
            <div className="thread-surface-soft rounded-xl px-3 py-3">
              <ActivityTimeline activities={activities} isRunning={isRunning} isFailed={isFailed} />
            </div>
          </section>
        )}

        {step.summary && (
          <section>
            <div className="mb-3 text-detail font-medium uppercase tracking-section text-muted-foreground">
              {isTerminal ? "Result" : "Progress"}
            </div>
            <div className="thread-surface-soft rounded-xl px-3 py-3">
              <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/82">{step.summary}</p>
            </div>
          </section>
        )}

        {step.error && (
          <section>
            <div className="mb-3 text-detail font-medium uppercase tracking-section text-destructive">
              Error
            </div>
            <div className="rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-3">
              <p className="whitespace-pre-wrap text-sm leading-6 text-destructive">{step.error}</p>
            </div>
          </section>
        )}

        {(step.subagentId ||
          step.model ||
          step.branchIndex !== undefined ||
          step.isAcceptable !== undefined) && (
          <section>
            <div className="mb-3 text-detail font-medium uppercase tracking-section text-muted-foreground">
              Details
            </div>
            <div className="thread-surface-soft rounded-xl px-3 py-2">
              {step.subagentId && <StatRow label="Subagent ID" value={step.subagentId} />}
              {step.model && <StatRow label="Model" value={step.model} />}
              {step.branchIndex !== undefined && <StatRow label="Branch index" value={String(step.branchIndex)} />}
              {step.isAcceptable !== undefined && (
                <StatRow label="Accepted" value={step.isAcceptable ? "yes" : "no"} />
              )}
            </div>
          </section>
        )}

        {isRunning && activities.length === 0 && !step.summary && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <div className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" />
              <Shimmer duration={2}>Running…</Shimmer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export const SubagentDetailPanel = memo(function SubagentDetailPanel({
  step,
  open,
  onClose,
}: {
  step: SubagentStep | null;
  open: boolean;
  onClose: () => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  if (!step) return null;

  const IdentityIcon = subagentIdentityIcon(step);
  const isTerminal = isSubagentTerminal(step.status);
  const isRunning = !isTerminal;
  const isFailed = normalizeSubagentStatus(step.status) === "failed";
  const preview = getSubagentPreviewText(step);

  return (
    <Sheet open={open} onOpenChange={(value) => !value && onClose()} modal={!isDesktop}>
      <SheetContent
        id="subagent-detail-panel"
        side={isDesktop ? "right" : "bottom"}
        showCloseButton={isDesktop}
        overlayClassName={
          isDesktop
            ? "pointer-events-none bg-black/12 backdrop-blur-[1px]"
            : "overlay-backdrop"
        }
        className={cn(
          "p-0 flex flex-col",
          isDesktop
            ? "thread-surface h-full w-full border-l border-border/70 w-sheet-panel"
            : "h-dvh-full max-h-dvh-full rounded-none shadow-sheet",
        )}
      >
        <SurfaceBar asChild>
          <SheetHeader
            className={cn(
              "shrink-0 border-b border-border/70",
              isDesktop
                ? "px-6 pt-5 pb-4"
                : "safe-area-inset-x safe-area-inset-top pb-3",
            )}
          >
          {!isDesktop && (
            <div className="mb-3 flex items-center justify-between">
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ui-control-icon"
                  aria-label="Back to thread"
                >
                  <ArrowLeft className="size-4" />
                </Button>
              </SheetClose>
              <StatusBadge status={step.status} />
            </div>
          )}
          <div className={cn("flex items-start gap-3", isDesktop ? "pr-8" : "")}>
            <div className="relative mt-0.5 shrink-0">
              <div className="thread-surface-soft flex size-10 items-center justify-center rounded-xl text-muted-foreground">
                <IdentityIcon className="size-5" />
              </div>
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                  isFailed
                    ? "bg-destructive"
                    : isTerminal
                      ? "bg-primary"
                      : "bg-primary animate-pulse",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-base leading-6">{step.name || "Subagent"}</SheetTitle>
                {isDesktop && <StatusBadge status={step.status} />}
              </div>
              <SheetDescription className="mt-1 flex flex-wrap items-center gap-1.5">
                {step.model && <MetaChip>{step.model}</MetaChip>}
                {step.phase && <MetaChip>{step.phase}</MetaChip>}
                {step.branchIndex !== undefined && <MetaChip>Branch {step.branchIndex}</MetaChip>}
                {step.completed !== undefined && step.totalBranches !== undefined && (
                  <MetaChip>
                    {step.completed}/{step.totalBranches} branches
                  </MetaChip>
                )}
                {step.isAcceptable && <MetaChip>Accepted</MetaChip>}
              </SheetDescription>
              {preview && (
                <div className="mt-2 text-xs leading-5 text-muted-foreground">
                  {isRunning ? <Shimmer duration={2}>{preview}</Shimmer> : preview}
                </div>
              )}
            </div>
          </div>
          </SheetHeader>
        </SurfaceBar>

        <SubagentDetailContent key={subagentSelectionKey(step)} step={step} />
      </SheetContent>
    </Sheet>
  );
});
