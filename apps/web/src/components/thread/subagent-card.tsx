"use client";

import { memo, useMemo } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  ChevronRight,
  FilePenLine,
  FlaskConical,
  Globe,
  SearchCode,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useHaptics } from "@/components/haptics-provider";
import type { SubagentStep } from "@/lib/describe";
import { formatDurationShort } from "@/lib/formatting";
import { getSubagentPreviewText } from "@/lib/viewer/subagent-steps";
import { normalizeSubagentStatus, subagentDotClassName, subagentStatusLabel, subagentTone } from "@/lib/status-semantics";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/animated-number";

export function subagentIdentityIcon(step: SubagentStep): LucideIcon {
  const haystack = [
    step.name ?? "",
    step.phase ?? "",
    step.activity ?? "",
    step.summary ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (/(research|explore|search|investigat)/.test(haystack)) return SearchCode;
  if (/(browse|web|url|site|http)/.test(haystack)) return Globe;
  if (/(shell|terminal|command|bash)/.test(haystack)) return SquareTerminal;
  if (/(edit|write|refactor|implement|fix|patch|file)/.test(haystack)) return FilePenLine;
  if (/(review|audit|verify|check)/.test(haystack)) return ShieldCheck;
  if (/(test|qa|validate)/.test(haystack)) return FlaskConical;
  return Bot;
}

export const SubagentCard = memo(function SubagentCard({
  step,
  isSelected = false,
  onSelect,
}: {
  step: SubagentStep;
  isSelected?: boolean;
  onSelect?: (step: SubagentStep) => void;
}) {
  const { trigger } = useHaptics();
  const Icon = useMemo(() => subagentIdentityIcon(step), [step]);
  const preview = getSubagentPreviewText(step);
  const metaParts: string[] = [];
  if (step.phase) metaParts.push(step.phase);
  if (step.durationS !== undefined) metaParts.push(formatDurationShort(step.durationS));
  if (step.toolCalls !== undefined) metaParts.push(`${step.toolCalls} ${step.toolCalls === 1 ? "tool" : "tools"}`);
  else if (step.turns !== undefined) metaParts.push(`${step.turns} ${step.turns === 1 ? "turn" : "turns"}`);

  function handleClick() {
    trigger("light");
    onSelect?.(step);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={handleClick}
      data-touch-target
      aria-haspopup="dialog"
      aria-controls={isSelected ? "subagent-detail-panel" : undefined}
      aria-label={`Open details for ${step.name || "Subagent"}`}
      className={cn(
        "h-auto group/subagent relative flex w-full items-start gap-3 overflow-hidden rounded-lg border bg-card/30 px-3 py-2.5 text-left",
        "thread-action-transition cursor-pointer hover:border-border/70 hover:bg-accent/35 active:bg-accent/50 active:scale-press",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        isSelected && "border-primary/45 bg-accent/40 shadow-sm",
        !isSelected && normalizeSubagentStatus(step.status) === "failed" && "border-destructive/30",
        !isSelected &&
          (normalizeSubagentStatus(step.status) === "completed" ||
            normalizeSubagentStatus(step.status) === "selected") &&
          "border-primary/20",
      )}
    >
      <div
        className={cn(
          "absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary/70",
          isSelected ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="relative mt-0.5 shrink-0">
        <div className="flex size-8 items-center justify-center rounded-md border border-border/50 bg-background/45 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
              subagentDotClassName(step.status),
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-label font-medium leading-5 text-foreground/90">
            {step.name || "Subagent"}
          </span>
          {step.model && (
            <Badge className="shrink-0 text-3xs" variant="secondary">
              {step.model}
            </Badge>
          )}
          {step.completed !== undefined && step.totalBranches !== undefined && (
            <span className="shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground">
              <AnimatedNumber value={step.completed} />/<AnimatedNumber value={step.totalBranches} />
            </span>
          )}
        </div>
        {preview ? (
          <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {subagentTone(step.status) === "secondary" ? (
              <Shimmer duration={2}>{preview}</Shimmer>
            ) : (
              preview
            )}
          </div>
        ) : null}
        <div className="mt-1 flex min-h-meta-min items-center gap-1.5 text-detail text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", subagentDotClassName(step.status))} />
            <span>{subagentStatusLabel(step.status)}</span>
          </span>
          {metaParts.map((part) => (
            <span key={part} className="inline-flex items-center gap-1">
              <span className="opacity-50">·</span>
              <span>{part}</span>
            </span>
          ))}
        </div>
      </div>
      <ChevronRight
        className={cn(
          "mt-1 size-3.5 shrink-0 text-muted-foreground/35 transition-all duration-fast",
          isSelected ? "translate-x-0.5 text-muted-foreground/80" : "group-hover/subagent:translate-x-0.5 group-hover/subagent:text-muted-foreground/75",
        )}
      />
    </Button>
  );
});

SubagentCard.displayName = "SubagentCard";
