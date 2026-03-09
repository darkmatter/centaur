"use client";

import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Legend,
  Tooltip,
} from "recharts";
import type { PieChartProps } from "./types";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function DashboardPieChart({
  title,
  labelKey,
  valueKey,
  data,
  height,
}: Omit<PieChartProps, "type">) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium tracking-tight text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <RechartsPieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={labelKey}
            cx="50%"
            cy="45%"
            innerRadius="60%"
            outerRadius="80%"
            paddingAngle={2}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--color-foreground)",
            }}
          />
          <Legend
            verticalAlign="bottom"
            wrapperStyle={{ fontSize: 12, color: "var(--color-muted-foreground)" }}
          />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
}
