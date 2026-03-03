"use client";

import { useEffect, useState } from "react";
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion";
import { cn } from "@/lib/utils";

type ChipAction = {
  label: string;
  value: string;
  variant?: "default" | "destructive" | "outline";
};

type QuickActionChipsProps = {
  threadState: string;
  onAction: (value: string) => void;
  className?: string;
};

const CHIP_SETS: Record<string, ChipAction[]> = {
  error: [
    { label: "Retry", value: "retry", variant: "default" },
    { label: "Retry with context", value: "retry-context", variant: "default" },
  ],
  stopped: [
    { label: "Resume", value: "resume", variant: "default" },
  ],
};

export function QuickActionChips({ threadState, onAction, className }: QuickActionChipsProps) {
  const normalizedState = threadState === "working" ? "running" : threadState;
  const chips = CHIP_SETS[normalizedState];
  const [renderedChips, setRenderedChips] = useState<ChipAction[] | null>(chips ?? null);
  const [visibility, setVisibility] = useState<"open" | "closed">(chips?.length ? "open" : "closed");

  useEffect(() => {
    if (chips && chips.length > 0) {
      setRenderedChips(chips);
      setVisibility("open");
      return;
    }
    if (!renderedChips) return;
    setVisibility("closed");
    const timer = window.setTimeout(() => setRenderedChips(null), 180);
    return () => window.clearTimeout(timer);
  }, [chips, renderedChips]);

  if (!renderedChips || renderedChips.length === 0) return null;

  return (
    <div
      data-state={visibility}
      className={cn(
        "border-t border-border/50 px-3 py-1.5 md:hidden",
        "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in data-[state=open]:duration-200",
        "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-2 data-[state=closed]:fade-out data-[state=closed]:duration-150",
        className,
      )}
    >
      <Suggestions>
        {renderedChips.map((chip) => (
          <Suggestion
            key={chip.value}
            suggestion={chip.value}
            variant={chip.variant ?? "outline"}
            onClick={onAction}
            className="min-h-[44px]"
          >
            {chip.label}
          </Suggestion>
        ))}
      </Suggestions>
    </div>
  );
}
