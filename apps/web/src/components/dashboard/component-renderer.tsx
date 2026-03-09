"use client";

import { memo } from "react";
import type { ComponentNode } from "./types";
import { DataTable } from "./data-table";
import { KPICard } from "./kpi-card";
import { DashboardLineChart } from "./line-chart";
import { DashboardBarChart } from "./bar-chart";
import { DashboardPieChart } from "./pie-chart";
import { DetailKV } from "./detail-kv";
import { Timeline } from "./timeline";
import { PeopleList } from "./people-list";
import { formatValue } from "./format-value";
import { LiveDataWrapper } from "./live-data-wrapper";
import { Button } from "@/components/ui/button";

const AVATAR_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
];

function getInitials(name: string): string {
  return name
    .split(/[\s|]+/)
    .filter((p) => p && !/^[(\[|]/.test(p))
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const RenderNode = memo(function RenderNode({ node }: { node: ComponentNode }) {
  switch (node.type) {
    // ── Layout ──
    case "stack": {
      const dir = node.direction === "horizontal" ? "flex-row" : "flex-col";
      const gap = node.gap ?? 4;
      return (
        <div className={`flex ${dir} gap-${gap}`}>
          {node.children.map((c, i) => <RenderNode key={i} node={c} />)}
        </div>
      );
    }

    case "grid": {
      const cols = { 1: "grid-cols-1", 2: "grid-cols-1 md:grid-cols-2", 3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3", 4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4" }[node.columns] ?? "grid-cols-1";
      const gap = node.gap ?? 4;
      return (
        <div className={`grid ${cols} gap-${gap}`}>
          {node.children.map((c, i) => <RenderNode key={i} node={c} />)}
        </div>
      );
    }

    case "card":
      return (
        <div className="rounded-md border border-border bg-card p-4">
          {node.title && <h3 className="mb-3 text-sm font-medium text-foreground">{node.title}</h3>}
          {node.children.map((c, i) => <RenderNode key={i} node={c} />)}
        </div>
      );

    case "tabs":
      return <TabsComponent tabs={node.tabs} defaultTab={node.defaultTab} />;

    case "split": {
      const [left, right] = node.ratio?.split(":").map(Number) ?? [1, 2];
      return (
        <div className="flex gap-4" style={{ display: "grid", gridTemplateColumns: `${left}fr ${right}fr` }}>
          <RenderNode node={node.children[0]} />
          <RenderNode node={node.children[1]} />
        </div>
      );
    }

    case "toolbar":
      return (
        <div className="flex items-center gap-2 flex-wrap">
          {node.children.map((c, i) => <RenderNode key={i} node={c} />)}
        </div>
      );

    // ── Display ──
    case "text": {
      const styles: Record<string, string> = {
        heading: "text-lg font-semibold text-foreground",
        subheading: "text-sm font-medium text-foreground",
        body: "text-sm text-muted-foreground",
        caption: "text-xs text-muted-foreground",
        code: "font-mono text-xs text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded",
      };
      return <p className={styles[node.variant ?? "body"]}>{node.content}</p>;
    }

    case "badge": {
      const intents: Record<string, string> = {
        default: "bg-secondary text-secondary-foreground",
        success: "bg-primary/10 text-primary",
        warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border border-border text-foreground",
      };
      return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${intents[node.intent ?? "default"]}`}>
          {node.text}
        </span>
      );
    }

    case "pill": {
      const bg = node.color ? `var(--${node.color})` : "var(--primary)";
      return (
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white"
          style={{ backgroundColor: bg }}
        >
          {node.text}
        </span>
      );
    }

    case "avatar": {
      const sizes = { sm: "h-6 w-6 text-3xs", md: "h-8 w-8 text-xs", lg: "h-10 w-10 text-sm" };
      const size = sizes[node.size ?? "md"];
      const bg = AVATAR_COLORS[hashCode(node.name) % AVATAR_COLORS.length];
      if (node.src) {
        return <img src={node.src} alt={node.name} className={`${size} rounded-full object-cover`} />;
      }
      return (
        <div
          className={`${size} flex items-center justify-center rounded-full font-medium text-white`}
          style={{ backgroundColor: bg }}
        >
          {getInitials(node.name)}
        </div>
      );
    }

    case "status-dot": {
      const colors: Record<string, string> = {
        success: "bg-primary", warning: "bg-yellow-500", error: "bg-destructive",
        idle: "bg-muted-foreground", running: "bg-primary animate-pulse",
      };
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${colors[node.status]}`} />
          {node.label && <span className="text-xs text-muted-foreground">{node.label}</span>}
        </span>
      );
    }

    case "icon":
      return <span className="text-muted-foreground" style={{ fontSize: node.size ?? 16 }}>●</span>;

    // ── Data ──
    case "data-table":
      return (
        <LiveDataWrapper dataSource={node.dataSource} initialData={node.data}>
          {(data) => (
            <DataTable
              columns={node.columns}
              data={data}
              defaultSort={node.defaultSort}
              searchable={node.searchable}
              title={node.title}
              pageSize={node.pageSize}
              virtualizeThreshold={node.virtualizeThreshold}
              compact={node.compact}
              striped={node.striped}
              stickyHeader={node.stickyHeader}
            />
          )}
        </LiveDataWrapper>
      );

    case "kpi-card":
      return (
        <LiveDataWrapper dataSource={node.dataSource} initialData={[]}>
          {(data) => (
            <KPICard
              label={node.label}
              value={data[0] ? Number(Object.values(data[0])[0]) : node.value}
              format={node.format}
              delta={node.delta}
              sparkline={node.sparkline}
            />
          )}
        </LiveDataWrapper>
      );

    case "line-chart":
      return (
        <LiveDataWrapper dataSource={node.dataSource} initialData={node.data}>
          {(data) => (
            <DashboardLineChart
              title={node.title}
              xKey={node.xKey}
              yKeys={node.yKeys}
              data={data}
              xFormat={node.xFormat}
              yFormat={node.yFormat}
              height={node.height}
            />
          )}
        </LiveDataWrapper>
      );

    case "bar-chart":
      return (
        <LiveDataWrapper dataSource={node.dataSource} initialData={node.data}>
          {(data) => (
            <DashboardBarChart
              title={node.title}
              categoryKey={node.categoryKey}
              valueKey={node.valueKey}
              data={data}
              height={node.height}
              horizontal={node.horizontal}
            />
          )}
        </LiveDataWrapper>
      );

    case "pie-chart":
      return (
        <LiveDataWrapper dataSource={node.dataSource} initialData={node.data}>
          {(data) => (
            <DashboardPieChart
              title={node.title}
              labelKey={node.labelKey}
              valueKey={node.valueKey}
              data={data}
              height={node.height}
            />
          )}
        </LiveDataWrapper>
      );

    // ── Domain ──
    case "detail-kv":
      return <DetailKV title={node.title} columns={node.columns} items={node.items} />;

    case "timeline":
      return <Timeline title={node.title} entries={node.entries} />;

    case "people-list":
      return (
        <PeopleList
          title={node.title}
          people={node.people}
          searchable={node.searchable}
          pageSize={node.pageSize}
        />
      );

    case "empty-state":
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          {node.icon && <span className="mb-3 text-3xl text-muted-foreground">{node.icon}</span>}
          <p className="text-sm font-medium text-foreground">{node.title}</p>
          {node.description && <p className="mt-1 text-xs text-muted-foreground">{node.description}</p>}
        </div>
      );

    default:
      return null;
  }
});

// ── Tabs (needs local state) ──
import { useState } from "react";
import type { TabItem } from "./types";

const TabsComponent = memo(function TabsComponent({
  tabs,
  defaultTab,
}: {
  tabs: TabItem[];
  defaultTab?: string;
}) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key ?? "");
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <Button
            key={tab.key}
            type="button"
            variant="ghost"
            onClick={() => setActive(tab.key)}
            className={`px-3 py-2 text-xs font-medium transition-colors ${
              tab.key === active
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium tabular-nums">
                {tab.count}
              </span>
            )}
          </Button>
        ))}
      </div>
      {activeTab && (
        <div className="pt-4">
          <RenderNode node={activeTab.content} />
        </div>
      )}
    </div>
  );
});
