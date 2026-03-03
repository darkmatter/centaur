"use client";

import { useState, useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { DashboardLayout } from "@/components/dashboard/layout";
import { parseDashboardSpec } from "@/lib/dashboard-parser";
import type { DashboardSpec } from "@/components/dashboard/types";

const SAMPLE_DASHBOARD: DashboardSpec = {
  title: "Portfolio Overview",
  layout: "grid-3",
  components: [
    { type: "kpi-card", label: "Total NAV", value: 1250000000, format: "compact-currency", delta: 3.2, sparkline: [1180, 1195, 1210, 1225, 1240, 1235, 1250] },
    { type: "kpi-card", label: "MTD Return", value: 3.2, format: "percent", delta: 1.5 },
    { type: "kpi-card", label: "Positions", value: 42, format: "number", delta: -2.3 },
    {
      type: "tabs",
      defaultTab: "holdings",
      tabs: [
        {
          key: "holdings",
          label: "Holdings",
          count: 7,
          content: {
            type: "data-table",
            title: "Top Holdings",
            searchable: true,
            columns: [
              { key: "name", label: "Asset", format: "text" as const, sortable: true, cell: { type: "avatar" as const } },
              { key: "type", label: "Type", format: "text" as const, cell: { type: "badge" as const, intentMap: { "Token": "default", "Public Equity": "success", "Private": "outline" } } },
              { key: "fund", label: "Fund", format: "text" as const, cell: { type: "pill" as const, colorMap: { "P1": "chart-1", "PF": "chart-2" } } },
              { key: "value", label: "Market Value", format: "compact-currency" as const, sortable: true, align: "right" as const },
              { key: "weight", label: "Weight", format: "percent" as const, sortable: true, align: "right" as const },
              { key: "mtdReturn", label: "MTD Return", format: "percent" as const, sortable: true, align: "right" as const },
            ],
            data: [
              { name: "Ethereum", type: "Token", fund: "P1", value: 450000000, weight: 36.0, mtdReturn: 5.2 },
              { name: "Bitcoin", type: "Token", fund: "P1", value: 320000000, weight: 25.6, mtdReturn: 2.1 },
              { name: "Solana", type: "Token", fund: "PF", value: 180000000, weight: 14.4, mtdReturn: 8.7 },
              { name: "Coinbase", type: "Public Equity", fund: "P1", value: 95000000, weight: 7.6, mtdReturn: -3.1 },
              { name: "Talarion", type: "Private", fund: "PF", value: 72000000, weight: 5.8, mtdReturn: 1.9 },
              { name: "Bayesian", type: "Private", fund: "P1", value: 48000000, weight: 3.8, mtdReturn: 12.4 },
              { name: "Chainlink", type: "Token", fund: "PF", value: 35000000, weight: 2.8, mtdReturn: -0.5 },
            ],
            defaultSort: { key: "value", direction: "desc" as const },
          },
        },
        {
          key: "transactions",
          label: "Transactions",
          count: 5,
          content: {
            type: "data-table",
            title: "Recent Transactions",
            compact: true,
            columns: [
              { key: "date", label: "Date", format: "date" as const, sortable: true },
              { key: "type", label: "Type", format: "text" as const, cell: { type: "badge" as const, intentMap: { "VEST": "success", "TRADE": "default", "STAKING REWARD": "outline" } }, minWidth: 120 },
              { key: "fund", label: "Fund", format: "text" as const, cell: { type: "pill" as const, colorMap: { "P1": "chart-1", "PF": "chart-2" } } },
              { key: "asset", label: "Asset", format: "text" as const, sortable: true },
              { key: "amount", label: "Amount", format: "number" as const, align: "right" as const },
              { key: "price", label: "Price", format: "currency" as const, align: "right" as const },
            ],
            data: [
              { date: "2026-03-02", type: "VEST", fund: "P1", asset: "VANA", amount: 135890, price: 0.0002 },
              { date: "2026-03-01", type: "STAKING REWARD", fund: "P1", asset: "ETH", amount: 12.5, price: 3200 },
              { date: "2026-02-28", type: "TRADE", fund: "PF", asset: "SOL", amount: 5000, price: 145.50 },
              { date: "2026-02-27", type: "VEST", fund: "PF", asset: "OP", amount: 757480, price: 0.0001 },
              { date: "2026-02-26", type: "TRADE", fund: "P1", asset: "BTC", amount: 2.5, price: 95000 },
            ],
            defaultSort: { key: "date", direction: "desc" as const },
          },
        },
      ],
    },
    {
      type: "detail-kv",
      title: "Account Details",
      columns: 3,
      items: [
        { label: "Fund Manager", value: "Jane Doe" },
        { label: "Strategy", value: "Multi-Asset Crypto" },
        { label: "AUM", value: "1250000000", format: "compact-currency" as const },
        { label: "Inception Date", value: "2021-06-15", format: "date" as const },
        { label: "Management Fee", value: "2", format: "percent" as const },
        { label: "Status", value: "Active" },
      ],
    },
    {
      type: "timeline",
      title: "Recent Activity",
      entries: [
        { date: "Mar 2, 2026", title: "VANA vest executed", description: "135.89K tokens vested from Series A allocation", badge: { text: "VEST", intent: "success" as const } },
        { date: "Mar 1, 2026", title: "ETH staking reward received", description: "12.5 ETH from Beacon Chain validators" },
        { date: "Feb 28, 2026", title: "SOL position increased", description: "Purchased 5,000 SOL at $145.50 via FalconX", badge: { text: "TRADE", intent: "default" as const } },
        { date: "Feb 27, 2026", title: "Portfolio rebalance completed", description: "Adjusted weights across 8 positions" },
      ],
    },
    {
      type: "people-list",
      title: "Key Contacts",
      searchable: true,
      people: [
        { name: "Jane Doe", title: "Fund Manager", company: "Paradigm", tags: ["PORTFOLIO", "OPS"] },
        { name: "John Smith", title: "Head of Trading", company: "Paradigm", tags: ["TRADING"] },
        { name: "Sarah Chen", title: "Analyst", company: "Paradigm", tags: ["RESEARCH"] },
        { name: "Mike Johnson", title: "Account Manager", company: "Coinbase Prime", tags: ["CUSTODY"] },
        { name: "Tyler | vaults.fyi", title: "Founder", company: "vaults.fyi", tags: ["DEFI"] },
      ],
    },
  ],
};

export default function UIKitPage() {
  const [raw, setRaw] = useState(JSON.stringify(SAMPLE_DASHBOARD, null, 2));

  const spec = useMemo<DashboardSpec | null>(() => {
    // Try JSON first (since our sample is JSON)
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "title" in parsed && "components" in parsed) {
        return parsed as DashboardSpec;
      }
    } catch {
      // Not JSON
    }
    // Fall back to TOON format
    return parseDashboardSpec(raw);
  }, [raw]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">UIKit – Composable Dashboard Components</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live preview of all dashboard components. Edit the JSON spec below to test.
            Supports: KPI cards, data tables (with badge/pill/avatar cells, virtualization, pagination),
            tabs, detail-kv, timeline, people list, and layout primitives (stack, grid, card, split).
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Dashboard Spec (JSON)
            </label>
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              className="h-[500px] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Parse Status</label>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  spec
                    ? "bg-primary/10 text-primary"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {spec ? `✓ ${spec.components.length} components` : "✗ Parse error"}
              </span>
            </div>
            <pre className="h-[500px] overflow-auto rounded-md border border-border bg-muted/30 p-4 text-xs">
              {spec ? JSON.stringify(spec, null, 2) : "Failed to parse spec"}
            </pre>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Rendered Preview</h2>
          {spec ? (
            <DashboardLayout spec={spec} />
          ) : (
            <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Fix the spec above to see a preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
