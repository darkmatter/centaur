"use client";

import { useState, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RenderNode } from "@/components/dashboard/component-renderer";
import type { ComponentNode } from "@/components/dashboard/types";
import {
  ChevronRight,
  ChevronDown,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Pencil,
  Eye,
  Plus,
  X,
  BarChart3,
  PieChart,
  LayoutGrid,
  Lock,
  Unlock,
  RotateCcw,
  Table,
  LineChart,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import ReactGridLayout, { useContainerWidth, verticalCompactor } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { Position, AggregatedPosition } from "./types";

// ── Formatting ──

function fmtCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCurrency(v: number | null): string {
  if (v == null || isNaN(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtPct(v: number): string {
  return `${v.toFixed(2)}%`;
}

// ── Aggregation ──

function aggregate(positions: Position[]): AggregatedPosition[] {
  const map = new Map<string, AggregatedPosition>();
  for (const p of positions) {
    const key = p.organizationId ?? p.assetName;
    const existing = map.get(key);
    if (existing) {
      existing.marketValue += p.marketValue;
      existing.grossInvestedCapital += p.grossInvestedCapital;
      existing.grossRealizedValue += p.grossRealizedValue;
      existing.dividendValue += p.dividendValue;
      existing.unrealizedGainLoss += p.unrealizedGainLoss;
      existing.realizedGainLoss += p.realizedGainLoss;
      existing.funds.push(p);
    } else {
      map.set(key, {
        organizationName: p.organizationName ?? p.assetName,
        ticker: p.ticker,
        assetType: p.assetType,
        marketValue: p.marketValue,
        grossInvestedCapital: p.grossInvestedCapital,
        grossRealizedValue: p.grossRealizedValue,
        dividendValue: p.dividendValue,
        moic: p.moic,
        unrealizedGainLoss: p.unrealizedGainLoss,
        realizedGainLoss: p.realizedGainLoss,
        latestPrice: p.latestPrice,
        funds: [p],
      });
    }
  }
  // Recalculate aggregate MOIC: (MV + Realized + Dividends) / IC
  for (const agg of map.values()) {
    const ic = agg.grossInvestedCapital;
    agg.moic = ic > 0 ? (agg.marketValue + agg.grossRealizedValue + agg.dividendValue) / ic : 0;
  }
  return [...map.values()];
}

// ── Avatar ──

const AVATAR_COLORS = [
  "hsl(220, 70%, 50%)", "hsl(160, 60%, 42%)", "hsl(280, 60%, 50%)",
  "hsl(30, 80%, 50%)", "hsl(340, 70%, 50%)", "hsl(200, 70%, 45%)",
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

// ── Sort ──

type SortKey = "organizationName" | "marketValue" | "grossInvestedCapital" | "moic" | "latestPrice" | "unrealizedGainLoss" | "realizedGainLoss";
type SortDir = "asc" | "desc";

function SortIcon({ column, sortKey, sortDir }: { column: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== column) return <ArrowUpDown className="ml-1 inline size-3 text-muted-foreground/40" />;
  return sortDir === "asc"
    ? <ArrowUp className="ml-1 inline size-3" />
    : <ArrowDown className="ml-1 inline size-3" />;
}

// ── Fund short names for filters ──

const FUND_OPTIONS = [
  { value: "all", label: "All Funds" },
  { value: "PF", label: "PF" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
  { value: "P3", label: "P3" },
  { value: "PGF", label: "PGF" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All asset types" },
  { value: "Token", label: "Token" },
  { value: "Public", label: "Public" },
  { value: "Private", label: "Private" },
];

// ── Dashboard builder palette ──

type PaletteItem = {
  id: string;
  label: string;
  icon: React.ElementType;
  description: string;
  buildNode: (positions: Position[]) => ComponentNode;
};

function buildPalette(): PaletteItem[] {
  return [
    {
      id: "pie-fund",
      label: "Fund Allocation",
      icon: PieChart,
      description: "Market value by fund",
      buildNode: (pos) => {
        const byFund = new Map<string, number>();
        for (const p of pos) byFund.set(p.fundShort || p.fundName, (byFund.get(p.fundShort || p.fundName) ?? 0) + p.marketValue);
        return {
          type: "pie-chart", title: "Allocation by Fund", labelKey: "fund", valueKey: "value", height: 300,
          data: [...byFund.entries()].sort((a, b) => b[1] - a[1]).map(([fund, value]) => ({ fund, value })),
        };
      },
    },
    {
      id: "pie-top",
      label: "Top Holdings",
      icon: PieChart,
      description: "Top 10 assets by market value",
      buildNode: (pos) => {
        const agg = aggregate(pos).sort((a, b) => b.marketValue - a.marketValue);
        const top = agg.slice(0, 10).map((p) => ({ name: p.ticker || p.organizationName, value: p.marketValue }));
        const rest = agg.slice(10).reduce((s, p) => s + p.marketValue, 0);
        if (rest > 0) top.push({ name: "Other", value: rest });
        return { type: "pie-chart", title: "Top Holdings", labelKey: "name", valueKey: "value", height: 300, data: top };
      },
    },
    {
      id: "pie-type",
      label: "Asset Type Split",
      icon: PieChart,
      description: "Breakdown by asset type",
      buildNode: (pos) => {
        const byType = new Map<string, number>();
        for (const p of pos) byType.set(p.assetType, (byType.get(p.assetType) ?? 0) + p.marketValue);
        return {
          type: "pie-chart", title: "By Asset Type", labelKey: "type", valueKey: "value", height: 280,
          data: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, value]) => ({ type, value })),
        };
      },
    },
    {
      id: "bar-fund",
      label: "Fund Bar Chart",
      icon: BarChart3,
      description: "AUM by fund",
      buildNode: (pos) => {
        const byFund = new Map<string, number>();
        for (const p of pos) byFund.set(p.fundShort || p.fundName, (byFund.get(p.fundShort || p.fundName) ?? 0) + p.marketValue);
        return {
          type: "bar-chart", title: "AUM by Fund", categoryKey: "fund", valueKey: "value", height: 280,
          data: [...byFund.entries()].sort((a, b) => b[1] - a[1]).map(([fund, value]) => ({ fund, value })),
        };
      },
    },
    {
      id: "bar-moic",
      label: "Top MOIC",
      icon: BarChart3,
      description: "Top 10 positions by MOIC",
      buildNode: (pos) => {
        const agg = aggregate(pos).filter((p) => p.moic > 1).sort((a, b) => b.moic - a.moic).slice(0, 10);
        return {
          type: "bar-chart", title: "Top MOIC", categoryKey: "name", valueKey: "moic", height: 280,
          data: agg.map((p) => ({ name: p.ticker || p.organizationName.slice(0, 12), moic: Math.round(p.moic * 100) / 100 })),
        };
      },
    },
  ];
}

// ── Grid layout ──

type CanvasItem = { instanceId: string; paletteId: string; node: ComponentNode };
const GRID_COLS = 12;
const GRID_ROW_HEIGHT = 60;

function defaultGridSize(node: ComponentNode): { w: number; h: number } {
  switch (node.type) {
    case "kpi-card": return { w: 3, h: 2 };
    case "data-table": return { w: 12, h: 7 };
    case "pie-chart": return { w: 6, h: 5 };
    case "bar-chart": return { w: 6, h: 5 };
    case "line-chart": return { w: 6, h: 5 };
    default: return { w: 4, h: 3 };
  }
}

function buildGridLayout(items: { instanceId: string; node: ComponentNode }[]): Layout {
  const result: LayoutItem[] = [];
  let x = 0, y = 0, rowMaxH = 0;
  for (const item of items) {
    const { w, h } = defaultGridSize(item.node);
    if (x + w > GRID_COLS) { x = 0; y += rowMaxH; rowMaxH = 0; }
    result.push({ i: item.instanceId, x, y, w, h, minW: 2, minH: 1 });
    x += w;
    rowMaxH = Math.max(rowMaxH, h);
  }
  return result;
}

// ── Component ──

export function PortfolioClient({ initialPositions }: { initialPositions: Position[] }) {
  const positions = initialPositions;

  // Filters
  const [search, setSearch] = useState("");
  const [fundFilter, setFundFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("marketValue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Expand
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [locked, setLocked] = useState(true);
  const palette = useMemo(() => buildPalette(), []);
  const [canvas, setCanvas] = useState<CanvasItem[]>([]);
  const [gridLayout, setGridLayout] = useState<Layout>([]);
  const [counter, setCounter] = useState(1);
  const { width: rglWidth, containerRef: rglRef, mounted: rglMounted } = useContainerWidth();

  // Totals (unfiltered)
  const totalMV = useMemo(() => positions.reduce((s, p) => s + p.marketValue, 0), [positions]);
  const totalIC = useMemo(() => positions.reduce((s, p) => s + p.grossInvestedCapital, 0), [positions]);
  const totalCount = positions.length;

  // Filtered positions
  const filtered = useMemo(() => {
    let rows = positions;
    if (fundFilter !== "all") rows = rows.filter((p) => p.fundShort === fundFilter);
    if (typeFilter !== "all") rows = rows.filter((p) => p.assetType === typeFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((p) => (p.organizationName ?? p.assetName).toLowerCase().includes(q) || p.assetName.toLowerCase().includes(q) || (p.ticker?.toLowerCase().includes(q)));
    }
    return rows;
  }, [positions, search, fundFilter, typeFilter]);

  // Aggregated + sorted
  const aggregated = useMemo(() => {
    const agg = aggregate(filtered);
    return [...agg].sort((a, b) => {
      const av = a[sortKey] as number | string | null;
      const bv = b[sortKey] as number | string | null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  // Filtered totals
  const filteredMV = useMemo(() => filtered.reduce((s, p) => s + p.marketValue, 0), [filtered]);
  const filteredIC = useMemo(() => filtered.reduce((s, p) => s + p.grossInvestedCapital, 0), [filtered]);
  const filteredCount = aggregated.length;

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return prev; }
      setSortDir(key === "organizationName" ? "asc" : "desc");
      return key;
    });
  }, []);

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  // Edit mode handlers
  const addComponent = useCallback((item: PaletteItem) => {
    if (locked) { toast("Unlock the canvas first"); return; }
    const id = `widget-${counter}`;
    const node = item.buildNode(filtered);
    setCanvas((prev) => [...prev, { instanceId: id, paletteId: item.id, node }]);
    setGridLayout((prev) => {
      const { w, h } = defaultGridSize(node);
      const maxY = prev.reduce((m, l) => Math.max(m, l.y + l.h), 0);
      return [...prev, { i: id, x: 0, y: maxY, w, h, minW: 2, minH: 1 }];
    });
    setCounter((c) => c + 1);
    toast(`Added "${item.label}"`);
  }, [counter, locked, filtered]);

  const removeComponent = useCallback((instanceId: string) => {
    if (locked) return;
    setCanvas((prev) => prev.filter((c) => c.instanceId !== instanceId));
    setGridLayout((prev) => prev.filter((l) => l.i !== instanceId));
  }, [locked]);

  // ── Render ──

  return (
    <div className="mx-auto max-w-portfolio-max px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-portfolio-sm font-medium uppercase tracking-wide text-muted-foreground">
              Market Value
            </p>
            <div className="flex items-baseline gap-1.5 justify-end">
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtPct(totalMV > 0 ? (filteredMV / totalMV) * 100 : 0)}
              </span>
              <span className="text-lg font-semibold tabular-nums">{fmtCompact(filteredMV)}</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-portfolio-sm font-medium uppercase tracking-wide text-muted-foreground">
              Invested Capital
            </p>
            <div className="flex items-baseline gap-1.5 justify-end">
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtPct(totalIC > 0 ? (filteredIC / totalIC) * 100 : 0)}
              </span>
              <span className="text-lg font-semibold tabular-nums">{fmtCompact(filteredIC)}</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-portfolio-sm font-medium uppercase tracking-wide text-muted-foreground">
              Positions
            </p>
            <div className="flex items-baseline gap-1.5 justify-end">
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtPct(totalCount > 0 ? (filteredCount / totalCount) * 100 : 0)}
              </span>
              <span className="text-lg font-semibold tabular-nums">{filteredCount}</span>
            </div>
          </div>
          <Separator orientation="vertical" className="h-8" />
          <Button
            variant={editing ? "default" : "outline"}
            size="xs"
            onClick={() => { setEditing((v) => { if (v) setLocked(true); return !v; }); }}
            className={`gap-1.5 text-xs ${editing ? "bg-primary text-primary-foreground" : ""}`}
          >
            {editing ? <Eye className="size-3" /> : <Pencil className="size-3" />}
            {editing ? "Done" : "Edit"}
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex items-center gap-3">
        <Input
          type="search"
          placeholder="Search positions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-64 border-border bg-background px-2.5 text-sm shadow-none focus-visible:ring-1"
        />
        <Select value={fundFilter} onValueChange={setFundFilter}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Select fund…" />
          </SelectTrigger>
          <SelectContent>
            {FUND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="All asset types" />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Positions Table */}
      {aggregated.length === 0 ? (
        <div className="flex h-64 items-center justify-center rounded-md border border-border bg-card">
          <p className="text-sm text-muted-foreground">No positions found</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="w-8 px-2 py-2.5" />
                  <th
                    onClick={() => toggleSort("organizationName")}
                    className="cursor-pointer select-none px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Position
                    <SortIcon column="organizationName" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("latestPrice")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Price
                    <SortIcon column="latestPrice" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("marketValue")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Market Value
                    <SortIcon column="marketValue" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("grossInvestedCapital")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Invested Capital
                    <SortIcon column="grossInvestedCapital" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("moic")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    MOIC
                    <SortIcon column="moic" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("unrealizedGainLoss")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Unrealized G/L
                    <SortIcon column="unrealizedGainLoss" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                  <th
                    onClick={() => toggleSort("realizedGainLoss")}
                    className="cursor-pointer select-none px-4 py-2.5 text-right text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Realized G/L
                    <SortIcon column="realizedGainLoss" sortKey={sortKey} sortDir={sortDir} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {aggregated.map((pos) => {
                  const isExpanded = expanded.has(pos.organizationName);
                  const hasMultipleFunds = pos.funds.length > 1;
                  const bg = AVATAR_COLORS[hashCode(pos.organizationName) % AVATAR_COLORS.length];

                  return (
                    <PositionRows
                      key={pos.organizationName}
                      pos={pos}
                      isExpanded={isExpanded}
                      hasMultipleFunds={hasMultipleFunds}
                      bg={bg}
                      onToggle={() => toggleExpand(pos.organizationName)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit mode: dashboard builder widgets */}
      {editing && (
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">
              Dashboard Widgets
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Add charts below the positions table
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {canvas.length > 0 && !locked && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => { setCanvas([]); setGridLayout([]); toast("Widgets cleared"); }}
                >
                  <RotateCcw className="size-3" />
                  Clear
                </Button>
              )}
              <Separator orientation="vertical" className="h-5" />
              <Button
                variant={locked ? "default" : "outline"}
                size="xs"
                onClick={() => { setLocked((v) => !v); toast(locked ? "Unlocked" : "Locked"); }}
                className={`gap-1.5 text-xs ${locked ? "bg-primary text-primary-foreground" : ""}`}
              >
                {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                {locked ? "Locked" : "Unlocked"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg-grid-sidebar-layout">
            {/* Palette */}
            <aside className="space-y-1">
              {palette.map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    onClick={() => addComponent(item)}
                    className="group h-auto w-full justify-start gap-2 rounded-lg border border-border/50 bg-card/30 px-2 py-1.5 text-left hover:border-primary/40 hover:bg-primary/5"
                  >
                    <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
                      <Icon className="size-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{item.label}</div>
                    </div>
                    <Plus className="size-3 shrink-0 text-muted-foreground/50 group-hover:text-primary" />
                  </Button>
                );
              })}
            </aside>

            {/* Canvas */}
            <div ref={rglRef} style={{ position: "relative" }}>
              {canvas.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/60 bg-card/20 py-16 text-center">
                  <LayoutGrid className="mb-2 size-6 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">Click widgets to add charts</p>
                </div>
              ) : rglMounted ? (
                <ReactGridLayout
                  layout={gridLayout.map((l) => ({ ...l, static: locked }))}
                  width={rglWidth}
                  gridConfig={{ cols: GRID_COLS, rowHeight: GRID_ROW_HEIGHT, margin: [12, 12] }}
                  dragConfig={{ enabled: !locked }}
                  resizeConfig={{ enabled: !locked, handles: ["se"] }}
                  compactor={verticalCompactor}
                  onLayoutChange={(nl) => { if (!locked) setGridLayout(nl as Layout); }}
                >
                  {canvas.map((item) => (
                    <div
                      key={item.instanceId}
                      className={`group/grid-item overflow-hidden rounded-lg border bg-card/40 ${locked ? "border-border/30" : "border-border/60 hover:border-primary/40"}`}
                    >
                      {!locked && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon-xs"
                          onClick={() => removeComponent(item.instanceId)}
                          className="absolute right-1.5 top-1.5 z-10 rounded-full opacity-0 group-hover/grid-item:opacity-100"
                        >
                          <X className="size-3" />
                        </Button>
                      )}
                      <div className="size-full overflow-auto p-2">
                        <RenderNode node={item.node} />
                      </div>
                    </div>
                  ))}
                </ReactGridLayout>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* View mode: show widgets if any were added */}
      {!editing && canvas.length > 0 && (
        <div className="mt-8" ref={!editing ? rglRef : undefined} style={{ position: "relative" }}>
          {rglMounted && (
            <ReactGridLayout
              layout={gridLayout.map((l) => ({ ...l, static: true }))}
              width={rglWidth}
              gridConfig={{ cols: GRID_COLS, rowHeight: GRID_ROW_HEIGHT, margin: [12, 12] }}
              dragConfig={{ enabled: false }}
              resizeConfig={{ enabled: false }}
              compactor={verticalCompactor}
            >
              {canvas.map((item) => (
                <div key={item.instanceId} className="overflow-hidden rounded-lg border border-border/30 bg-card/40">
                  <div className="size-full overflow-auto p-2">
                    <RenderNode node={item.node} />
                  </div>
                </div>
              ))}
            </ReactGridLayout>
          )}
        </div>
      )}
    </div>
  );
}

// ── Position row component ──

function PositionRows({
  pos,
  isExpanded,
  hasMultipleFunds,
  bg,
  onToggle,
}: {
  pos: AggregatedPosition;
  isExpanded: boolean;
  hasMultipleFunds: boolean;
  bg: string;
  onToggle: () => void;
}) {
  return (
    <>
      {/* Main row */}
      <tr className="border-b border-border/40 last:border-0 transition-colors hover:bg-muted/30">
        {/* Chevron */}
        <td className="px-2 py-2.5 text-center">
          {hasMultipleFunds ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onToggle}
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </Button>
          ) : (
            <span className="inline-block size-5" />
          )}
        </td>
        {/* Position */}
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
              style={{ backgroundColor: bg }}
            >
              {getInitials(pos.organizationName)}
            </div>
            <div className="flex flex-col">
              <span className="font-medium text-foreground">{pos.organizationName}</span>
              <div className="flex items-center gap-2">
                {pos.ticker && (
                  <span className="text-portfolio-sm text-muted-foreground">{pos.ticker}</span>
                )}
                {!hasMultipleFunds && pos.funds[0] && (
                  <span className="text-portfolio-sm text-muted-foreground">
                    · {pos.funds[0].fundShort}
                  </span>
                )}
              </div>
            </div>
          </div>
        </td>
        {/* Price */}
        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
          {pos.latestPrice != null ? fmtCurrency(pos.latestPrice) : "—"}
        </td>
        {/* Market Value */}
        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
          {fmtCompact(pos.marketValue)}
        </td>
        {/* Invested Capital */}
        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
          {fmtCompact(pos.grossInvestedCapital)}
        </td>
        {/* MOIC */}
        <td className="px-4 py-2.5 text-right">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
              pos.moic >= 1.0
                ? "bg-primary/10 text-primary"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {pos.moic > 0 ? `${pos.moic.toFixed(2)}x` : "—"}
          </span>
        </td>
        {/* Unrealized G/L */}
        <td className={`px-4 py-2.5 text-right tabular-nums ${pos.unrealizedGainLoss >= 0 ? "text-primary" : "text-destructive"}`}>
          {fmtCompact(pos.unrealizedGainLoss)}
        </td>
        {/* Realized G/L */}
        <td className={`px-4 py-2.5 text-right tabular-nums ${pos.realizedGainLoss >= 0 ? "text-primary" : "text-destructive"}`}>
          {fmtCompact(pos.realizedGainLoss)}
        </td>
      </tr>

      {/* Expanded sub-rows */}
      {isExpanded &&
        pos.funds.map((fund, fi) => (
          <tr
            key={`${pos.organizationName}-${fund.assetName}-${fund.fundShort}-${fi}`}
            className="border-b border-border/20 bg-muted/10 last:border-0"
          >
            <td />
            <td className="px-4 py-2 pl-16">
              <span className="text-xs text-muted-foreground">{fund.assetName} · {fund.fundShort}</span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
              {fund.latestPrice != null ? fmtCurrency(fund.latestPrice) : "—"}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
              {fmtCompact(fund.marketValue)}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
              {fmtCompact(fund.grossInvestedCapital)}
            </td>
            <td className="px-4 py-2 text-right">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-portfolio-sm font-medium tabular-nums ${
                  fund.moic >= 1.0
                    ? "bg-primary/10 text-primary"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {fund.moic > 0 ? `${fund.moic.toFixed(2)}x` : "—"}
              </span>
            </td>
            <td className={`px-4 py-2 text-right tabular-nums text-xs ${fund.unrealizedGainLoss >= 0 ? "text-primary" : "text-destructive"}`}>
              {fmtCompact(fund.unrealizedGainLoss)}
            </td>
            <td className={`px-4 py-2 text-right tabular-nums text-xs ${fund.realizedGainLoss >= 0 ? "text-primary" : "text-destructive"}`}>
              {fmtCompact(fund.realizedGainLoss)}
            </td>
          </tr>
        ))}
    </>
  );
}
