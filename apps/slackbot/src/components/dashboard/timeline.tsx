"use client";

import { memo } from "react";
import type { TimelineEntry } from "./types";

export const Timeline = memo(function Timeline({
  title,
  entries,
}: {
  title?: string;
  entries: TimelineEntry[];
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      {title && <h3 className="mb-3 text-sm font-medium text-foreground">{title}</h3>}
      {entries.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No timeline items found</p>
      ) : (
        <ol className="relative border-l border-border ml-2 pt-1.5">
          {entries.map((entry, i) => (
            <li key={i} className="mb-4 ml-4 last:mb-0">
              <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-background bg-muted-foreground" />
              <time className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                {entry.date}
              </time>
              <div className="mt-0.5 flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">{entry.title}</p>
                {entry.badge && (
                  <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    {
                      default: "bg-secondary text-secondary-foreground",
                      success: "bg-primary/10 text-primary",
                      warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
                      destructive: "bg-destructive/10 text-destructive",
                      outline: "border border-border text-foreground",
                    }[entry.badge.intent ?? "default"]
                  }`}>
                    {entry.badge.text}
                  </span>
                )}
              </div>
              {entry.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});
