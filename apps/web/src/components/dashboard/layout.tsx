"use client";

import type { DashboardSpec, ComponentNode } from "./types";
import { RenderNode } from "./component-renderer";

const GRID_CLASS: Record<DashboardSpec["layout"], string> = {
  single: "grid grid-cols-1 gap-4",
  "grid-2": "grid grid-cols-1 md:grid-cols-2 gap-4",
  "grid-3": "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4",
};

function spanClass(node: ComponentNode): string {
  if (node.type === "data-table" || node.type === "line-chart" || node.type === "timeline" ||
      node.type === "people-list" || node.type === "tabs" || node.type === "split" ||
      node.type === "detail-kv" || node.type === "stack" || node.type === "grid" ||
      node.type === "toolbar") {
    return "col-span-full";
  }
  return "";
}

export function DashboardLayout({ spec }: { spec: DashboardSpec }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-3">{spec.title}</h2>
      <div className={GRID_CLASS[spec.layout]}>
        {spec.components.map((component, i) => (
          <div key={i} className={spanClass(component)}>
            <RenderNode node={component} />
          </div>
        ))}
      </div>
    </div>
  );
}
