"use client";

import { useMemo, useState, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnDef, CellRenderer } from "./types";
import { formatValue } from "./format-value";
import { Input } from "@/components/ui/input";

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_VIRTUALIZE_THRESHOLD = 100;
const ROW_HEIGHT = 40;
const ROW_HEIGHT_COMPACT = 32;

const BADGE_INTENTS: Record<string, string> = {
  default: "bg-secondary text-secondary-foreground",
  success: "bg-primary/10 text-primary",
  warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  destructive: "bg-destructive/10 text-destructive",
  outline: "border border-border text-foreground",
};

const AVATAR_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getInitials(name: string): string {
  return name.split(/[\s|]+/).filter((p) => p && !/^[(\[|]/.test(p)).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

function renderCell(value: unknown, col: ColumnDef, row: Record<string, unknown>) {
  const cell = col.cell;
  if (!cell) return formatValue(value, col.format);

  const strVal = value == null ? "" : String(value);

  switch (cell.type) {
    case "badge": {
      const intent = cell.intentMap?.[strVal] ?? "default";
      return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${BADGE_INTENTS[intent]}`}>
          {strVal}
        </span>
      );
    }
    case "pill": {
      const color = cell.colorMap?.[strVal];
      const bg = color ? `var(--${color})` : "var(--primary)";
      return (
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
          style={{ backgroundColor: bg }}
        >
          {strVal}
        </span>
      );
    }
    case "avatar": {
      const name = cell.nameKey ? String(row[cell.nameKey] ?? strVal) : strVal;
      const bg = AVATAR_COLORS[hashCode(name) % AVATAR_COLORS.length];
      return (
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium text-white"
            style={{ backgroundColor: bg }}
          >
            {getInitials(name)}
          </div>
          <span>{strVal}</span>
        </div>
      );
    }
    case "stacked-text": {
      const secondary = row[cell.secondaryKey];
      return (
        <div className="flex flex-col">
          <span>{formatValue(value, col.format)}</span>
          <span className="text-[10px] text-muted-foreground">{formatValue(secondary, cell.secondaryFormat ?? "text")}</span>
        </div>
      );
    }
    case "link": {
      const href = String(row[cell.hrefKey] ?? "#");
      return (
        <a href={href} className="text-primary underline-offset-4 hover:underline" target="_blank" rel="noopener noreferrer">
          {formatValue(value, col.format)}
        </a>
      );
    }
    default:
      return formatValue(value, col.format);
  }
}

function cellAlignClass(col: ColumnDef) {
  if (col.align === "right") return "text-right";
  if (col.align === "center") return "text-center";
  return "text-left";
}

function cellValueClass(col: ColumnDef, value: unknown) {
  if (col.format === "percent" && typeof value === "number") {
    if (value > 0) return "text-primary";
    if (value < 0) return "text-destructive";
  }
  return "";
}

export function DataTable({
  columns,
  data,
  defaultSort,
  searchable,
  title,
  pageSize = DEFAULT_PAGE_SIZE,
  virtualizeThreshold = DEFAULT_VIRTUALIZE_THRESHOLD,
  compact = false,
  striped = true,
  stickyHeader = true,
}: {
  columns: ColumnDef[];
  data: readonly Record<string, unknown>[];
  defaultSort?: { key: string; direction: "asc" | "desc" };
  searchable?: boolean;
  title?: string;
  pageSize?: number;
  virtualizeThreshold?: number;
  compact?: boolean;
  striped?: boolean;
  stickyHeader?: boolean;
}) {
  const [sortKey, setSortKey] = useState(defaultSort?.key ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSort?.direction ?? "asc");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  const visibleCols = useMemo(() => columns.filter((c) => !c.hidden), [columns]);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter((row) =>
      visibleCols.some((col) => {
        const v = row[col.key];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [data, search, visibleCols]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = visibleCols.find((c) => c.key === sortKey);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir, visibleCols]);

  const useVirtual = sorted.length > virtualizeThreshold;
  const totalPages = useVirtual ? 1 : Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const displayRows = useVirtual ? sorted : sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const rowH = compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 20,
  });

  const toggleSort = useCallback(
    (col: ColumnDef) => {
      if (!col.sortable) return;
      if (sortKey === col.key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(col.key);
        setSortDir("asc");
      }
      setPage(0);
    },
    [sortKey],
  );

  const px = compact ? "px-3" : "px-4";
  const py = compact ? "py-1.5" : "py-2.5";

  const headerRow = (
    <tr className="border-b border-border bg-muted/30">
      {visibleCols.map((col) => (
        <th
          key={col.key}
          onClick={() => toggleSort(col)}
          className={`${px} ${py} text-xs font-medium text-muted-foreground ${cellAlignClass(col)} ${
            col.sortable ? "cursor-pointer select-none hover:text-foreground" : ""
          }`}
          style={col.minWidth ? { minWidth: col.minWidth } : undefined}
        >
          {col.label}
          {sortKey === col.key && <span className="ml-1">{sortDir === "asc" ? "▲" : "▼"}</span>}
        </th>
      ))}
    </tr>
  );

  const renderRow = (row: Record<string, unknown>, idx: number, style?: React.CSSProperties) => (
    <tr
      key={idx}
      className={`border-b border-border last:border-0 ${striped && idx % 2 === 1 ? "bg-muted/50" : ""}`}
      style={style}
    >
      {visibleCols.map((col) => (
        <td
          key={col.key}
          className={`${px} ${py} ${cellValueClass(col, row[col.key]) || "text-foreground"} ${cellAlignClass(col)}`}
          style={col.minWidth ? { minWidth: col.minWidth } : undefined}
        >
          {renderCell(row[col.key], col, row)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      {(title || searchable) && (
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">{sorted.length} {sorted.length === 1 ? "row" : "rows"}</span>
            {searchable && (
              <Input
                type="search"
                placeholder="Search…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-48 border-border bg-background px-2.5 text-sm shadow-none focus-visible:ring-1"
              />
            )}
          </div>
        </div>
      )}

      {useVirtual ? (
        <div ref={parentRef} className="overflow-auto" style={{ maxHeight: 600 }}>
          <table className="w-full text-sm">
            <thead className={stickyHeader ? "sticky top-0 z-10 bg-card" : ""}>{headerRow}</thead>
            <tbody style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const row = displayRows[vRow.index];
                return renderRow(row, vRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: vRow.size,
                  transform: `translateY(${vRow.start}px)`,
                  display: "table-row",
                });
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={stickyHeader ? "sticky top-0 z-10 bg-card" : ""}>{headerRow}</thead>
              <tbody>{displayRows.map((row, i) => renderRow(row, i))}</tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span>
                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}
              </span>
              <div className="flex gap-2">
                <button type="button" disabled={safePage === 0} onClick={() => setPage((p) => p - 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40">Prev</button>
                <button type="button" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
