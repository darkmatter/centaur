"use client";

import {
  CircleCheck,
  ClipboardList,
  Eye,
  Hammer,
  LoaderCircle,
  MessageSquare,
  Rocket,
  Search,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { PHASES } from "@/lib/types";
import { cn } from "@/lib/utils";

const PHASE_ICONS = {
  research: Search,
  plan: ClipboardList,
  clarify: MessageSquare,
  implement: Hammer,
  review: Eye,
  publish: Rocket,
} as const;

export function PhaseProgress({ phases }: { phases: string[] }) {
  const normalized = phases
    .map((phase) => phase.toLowerCase())
    .filter((phase): phase is (typeof PHASES)[number] =>
      PHASES.includes(phase as (typeof PHASES)[number]),
    );
  const completedPhases = new Set<string>(normalized);
  const activePhase = normalized.length > 0 ? normalized[normalized.length - 1] : null;
  const activeIndex = activePhase ? PHASES.indexOf(activePhase as (typeof PHASES)[number]) : -1;
  const percent = activeIndex >= 0 ? ((activeIndex + 1) / PHASES.length) * 100 : 0;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5 overflow-x-auto">
      {PHASES.map((phase) => {
        const isActive = phase === activePhase;
        const isDone = completedPhases.has(phase) && !isActive;
        const isFuture = !completedPhases.has(phase) && !isActive;
        const Icon = PHASE_ICONS[phase];

        return (
          <div key={phase} className="flex items-center gap-1.5">
            {isDone ? (
              <CircleCheck className="size-3.5 text-primary shrink-0" />
            ) : isActive ? (
              <LoaderCircle className="size-3.5 text-primary shrink-0 animate-spin motion-reduce:animate-none" />
            ) : (
              <Icon className="size-3.5 text-muted-foreground shrink-0" />
            )}
              <span
                className={cn(
                  "text-xs font-medium uppercase tracking-wide whitespace-nowrap",
                  isDone && "text-primary",
                  isActive && "text-foreground",
                  isFuture && "text-muted-foreground",
                )}
              >
                {phase}
              </span>
          </div>
        );
      })}
      </div>
      <Progress value={percent} className="h-1 bg-muted" />
    </div>
  );
}
