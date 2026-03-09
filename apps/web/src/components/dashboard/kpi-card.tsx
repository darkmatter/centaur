"use client";

import { memo } from "react";
import type { KPICardNode } from "./types";
import { formatValue } from "./format-value";

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const h = 24;
  const w = 64;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - ((v - min) / range) * h}`).join(" ");
  return (
    <svg width={w} height={h} className="text-primary" viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

export const KPICard = memo(function KPICard({
  label,
  value,
  format,
  delta,
  sparkline,
}: Omit<KPICardNode, "type">) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {formatValue(value, format)}
        </p>
        {sparkline && <Sparkline data={sparkline} />}
      </div>
      {delta != null && (
        <p className={`mt-1 text-sm font-medium ${delta >= 0 ? "text-primary" : "text-destructive"}`}>
          {delta >= 0 ? "↑" : "↓"}
          {Math.abs(delta).toFixed(1)}%
        </p>
      )}
    </div>
  );
});
