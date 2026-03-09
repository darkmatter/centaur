"use client";

import { memo, type ComponentProps, type Ref } from "react";
import Link from "next/link";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { StateDot } from "@/components/ui/state-dot";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { Progress } from "@/components/ui/progress";
import { PHASES, type ThreadSummary } from "@/lib/types";
import { useElapsed } from "@/hooks/use-elapsed";
import { getThreadDisplayName, parseActivePhase, runningSubtitle } from "@/lib/viewer/thread-selectors";
import { isRunningState } from "@/lib/viewer/thread-ordering";
import { cn } from "@/lib/utils";

type ThreadSummaryCardProps = {
  thread: ThreadSummary;
  href: string;
  statusSubtitle?: string | null;
  density?: "compact" | "comfortable";
  isSelected?: boolean;
  className?: string;
  linkRef?: Ref<HTMLAnchorElement>;
  linkProps?: Omit<ComponentProps<typeof Link>, "href" | "className" | "children" | "prefetch"> & {
    [key: `data-${string}`]: string | undefined;
  };
};

function ThreadAge({ thread }: { thread: ThreadSummary }) {
  const elapsed = useElapsed(thread.last_activity, isRunningState(thread.state));
  return <span>{elapsed}</span>;
}

export const ThreadSummaryCard = memo(function ThreadSummaryCard({
  thread,
  href,
  statusSubtitle,
  density = "comfortable",
  isSelected = false,
  className,
  linkRef,
  linkProps,
}: ThreadSummaryCardProps) {
  const compact = density === "compact";
  const activeState = isRunningState(thread.state);
  const resolvedStatusSubtitle = statusSubtitle ?? runningSubtitle(thread);
  const activePhase = parseActivePhase(thread);
  const phaseIndex = activePhase ? PHASES.indexOf(activePhase as (typeof PHASES)[number]) : -1;
  const progress = phaseIndex >= 0 ? ((phaseIndex + 1) / PHASES.length) * 100 : 0;
  const name = getThreadDisplayName(thread);
  const rawTask = thread.last_user_message || thread.first_message || "";
  const taskPreview = rawTask.replace(/^\[[\w]+\]\s*/, "").replace(/\s+/g, " ").slice(0, compact ? 120 : 100);

  return (
    <Link
      href={href}
      prefetch={false}
      ref={linkRef}
      className={cn(
        "thread-action-transition group block w-full no-underline text-inherit",
        compact ? "px-3 py-2.5" : "px-3 py-3",
        "hover:bg-accent/40 active:bg-accent/50 focus-visible:bg-accent/40 focus-visible:outline-none",
        activeState && "bg-primary/5",
        thread.state === "error" && "bg-destructive/5",
        isSelected && "bg-accent/50",
        className,
      )}
      {...linkProps}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StateDot state={thread.state} className="size-2 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-detail text-muted-foreground/70">
          <ThreadAge thread={thread} />
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-1 pl-4 text-detail text-muted-foreground">
        <HarnessBadge harness={thread.harness} className="harness-badge-sm" />
        <span className="text-border/60">·</span>
        <span>{thread.turn_count} turn{thread.turn_count === 1 ? "" : "s"}</span>
        <span className="text-border/60">·</span>
        <span>{thread.state}</span>
      </div>

      {taskPreview ? (
        <div className="mt-0.5 line-clamp-1 pl-4 text-detail leading-relaxed text-muted-foreground/70">
          {taskPreview}
        </div>
      ) : null}
      {resolvedStatusSubtitle ? (
        <div className="mt-0.5 line-clamp-1 pl-4 text-detail text-muted-foreground">
          {resolvedStatusSubtitle}
        </div>
      ) : null}
      {activePhase ? <Progress value={progress} className="mt-1.5 h-0.5 bg-muted/70" /> : null}
    </Link>
  );
});
