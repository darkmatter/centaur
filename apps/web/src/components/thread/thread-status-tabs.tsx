"use client";

import React from "react";
import { useHaptics } from "@/components/haptics-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { THREAD_STATUS_FILTER_OPTIONS, type VisibleThreadStatusFilter } from "@/components/thread/thread-ui-constants";

type ThreadStatusTabsProps = {
  value: VisibleThreadStatusFilter;
  counts: Record<VisibleThreadStatusFilter, number>;
  onChange: (next: VisibleThreadStatusFilter) => void;
  density?: "compact" | "comfortable";
  className?: string;
};

export function ThreadStatusTabs({
  value,
  counts,
  onChange,
  density = "comfortable",
  className,
}: ThreadStatusTabsProps) {
  const compact = density === "compact";
  const { trigger } = useHaptics();

  return (
    <div
      role="tablist"
      aria-label="Thread filters"
      className={cn(
        "flex w-full items-center gap-0.5",
        className,
      )}
    >
      {THREAD_STATUS_FILTER_OPTIONS.map((option) => {
        const active = value === option.id;
        return (
          <Button
            key={option.id}
            type="button"
            onClick={() => {
              if (!active) trigger("selection");
              onChange(option.id);
            }}
            role="tab"
            aria-selected={active}
            variant="ghost"
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-medium transition-colors duration-fast",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{compact ? option.shortLabel : option.label}</span>
            <span className={cn(
              "text-3xs tabular-nums",
              active ? "text-foreground/60" : "text-muted-foreground/60",
            )}>
              {counts[option.id]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
