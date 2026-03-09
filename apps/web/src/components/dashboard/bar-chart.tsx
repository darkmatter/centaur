"use client";

import {
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import type { BarChartProps } from "./types";

export function DashboardBarChart({
  title,
  categoryKey,
  valueKey,
  data,
  height,
  horizontal,
}: Omit<BarChartProps, "type">) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium tracking-tight text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <RechartsBarChart data={data as Record<string, unknown>[]} layout={horizontal ? "vertical" : "horizontal"}>
          <XAxis
            {...(horizontal ? { type: "number" } : { dataKey: categoryKey })}
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            stroke="var(--color-border)"
          />
          <YAxis
            {...(horizontal ? { type: "category", dataKey: categoryKey } : {})}
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            stroke="var(--color-border)"
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--color-foreground)",
            }}
          />
          <Bar dataKey={valueKey} fill="var(--chart-1)" radius={[6, 6, 0, 0]} />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
