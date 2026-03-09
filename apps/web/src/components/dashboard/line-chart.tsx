"use client";

import {
  ResponsiveContainer,
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import type { LineChartProps } from "./types";
import { formatValue } from "./format-value";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function DashboardLineChart({
  title,
  xKey,
  yKeys,
  data,
  xFormat,
  yFormat,
  height,
}: Omit<LineChartProps, "type">) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-medium tracking-tight text-foreground">{title}</h3>
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <RechartsLineChart data={data as Record<string, unknown>[]}>
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickFormatter={(v) => (xFormat ? formatValue(v, xFormat) : String(v))}
            stroke="var(--color-border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickFormatter={(v) => (yFormat ? formatValue(v, yFormat) : String(v))}
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
            formatter={(v: unknown) => (yFormat ? formatValue(v, yFormat) : String(v))}
            labelFormatter={(l: unknown) => (xFormat ? formatValue(l, xFormat) : String(l))}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--color-muted-foreground)" }}
          />
          {yKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}
