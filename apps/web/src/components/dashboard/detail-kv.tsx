"use client";

import { memo } from "react";
import type { DetailKVItem, ComponentNode } from "./types";
import { formatValue } from "./format-value";

function isComponentNode(v: string | ComponentNode): v is ComponentNode {
  return typeof v === "object" && v !== null && "type" in v;
}

export const DetailKV = memo(function DetailKV({
  title,
  columns = 2,
  items,
}: {
  title?: string;
  columns?: number;
  items: DetailKVItem[];
}) {
  const colClass = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" }[columns] ?? "grid-cols-2";

  return (
    <div className="rounded-md border border-border bg-card p-4">
      {title && <h3 className="mb-3 text-sm font-medium text-foreground">{title}</h3>}
      <dl className={`grid ${colClass} gap-x-6 gap-y-3`}>
        {items.map((item, i) => (
          <div key={i}>
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-foreground">
              {isComponentNode(item.value)
                ? null // rendered by parent via RenderNode
                : item.format
                  ? formatValue(item.value, item.format)
                  : item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
});
