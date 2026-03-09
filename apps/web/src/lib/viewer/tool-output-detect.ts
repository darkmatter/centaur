import { decode } from "@toon-format/toon";

import type { ColumnDef, DetailKVItem } from "@/components/dashboard/types";
import { formatValue } from "@/components/dashboard/format-value";

type ParsedFormat = "raw" | "json" | "toon" | "text";

export type ParsedToolOutput = {
  parsed: unknown;
  format: ParsedFormat;
  text: string;
};

export type SourceItem = {
  url: string;
  title: string;
  snippet?: string;
};

export type TableBlock = {
  type: "table";
  title?: string;
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  rowCount: number;
};

export type ChartBlock = {
  type: "chart";
  title?: string;
  chartType: "line" | "bar";
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  rowCount: number;
};

export type EntityBlock = {
  type: "entity";
  title?: string;
  items: DetailKVItem[];
  entries: Array<[string, unknown]>;
};

export type MarkdownBlock = {
  type: "markdown";
  text: string;
};

export type SourcesBlock = {
  type: "sources";
  items: SourceItem[];
};

export type ImageBlock = {
  type: "image";
  url: string;
};

export type RawBlock = {
  type: "raw";
  text: string;
};

export type ContentBlock =
  | TableBlock
  | ChartBlock
  | EntityBlock
  | MarkdownBlock
  | SourcesBlock
  | ImageBlock
  | RawBlock;

const TOOL_TABLE_HINTS = new Set(["allium", "dune", "paradigmdb", "posthog"]);
const TOOL_SOURCE_HINTS = new Set(["websearch", "web_search"]);

const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?\S*)?$/i;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[tT ][\d:.+-Zz]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolName(toolName?: string): string {
  if (!toolName) return "";
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toolFamily(toolName?: string): string {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return "";
  const parts = normalized.split("_");
  return parts[0] ?? normalized;
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksStructuredString(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (/^\[\d+\]\{.+\}:/m.test(trimmed)) return true;
  if (/^[A-Za-z0-9_-]+:\s+\S+/m.test(trimmed) && !looksLikeMarkdown(trimmed)) return true;
  return false;
}

function decodeToon(text: string): unknown {
  return decode(text, { strict: false });
}

export function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const textParts = output
      .filter(isRecord)
      .filter((item) => item.type === "text" && typeof item.text === "string" && item.text)
      .map((item) => String(item.text));
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  return stableStringify(output);
}

export function parseToolOutput(raw: unknown): ParsedToolOutput {
  if (raw === undefined || raw === null) {
    return { parsed: raw, format: "raw", text: "" };
  }

  if (typeof raw !== "string") {
    return { parsed: raw, format: "raw", text: stableStringify(raw) };
  }

  const text = raw.trim();
  if (!text) {
    return { parsed: "", format: "text", text: raw };
  }

  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
    try {
      return {
        parsed: JSON.parse(text),
        format: "json",
        text: raw,
      };
    } catch {
      // Fall through to TOON or text parsing.
    }
  }

  if (looksStructuredString(text)) {
    try {
      const parsed = decodeToon(text);
      if (parsed !== undefined) {
        return {
          parsed,
          format: "toon",
          text: raw,
        };
      }
    } catch {
      // Treat as text below.
    }
  }

  return { parsed: raw, format: "text", text: raw };
}

function humanizeKey(key: string): string {
  const cleaned = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return key;
  return cleaned.replace(/\b\w/g, (match) => match.toUpperCase());
}

function isDateLike(value: unknown): boolean {
  if (typeof value === "number") {
    return value > 1_000_000_000 && value < 9_999_999_999_999;
  }
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (ISO_DATE_RE.test(trimmed)) return true;
  const timestamp = Number(trimmed);
  return Number.isFinite(timestamp) && timestamp > 1_000_000_000 && timestamp < 9_999_999_999_999;
}

function looksLikeStatus(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return [
    "success",
    "confirmed",
    "active",
    "done",
    "completed",
    "failed",
    "reverted",
    "error",
    "rejected",
    "pending",
    "processing",
    "submitted",
    "waiting",
  ].includes(normalized);
}

function statusIntent(value: string): "default" | "success" | "warning" | "destructive" {
  const normalized = value.trim().toLowerCase();
  if (["success", "confirmed", "active", "done", "completed"].includes(normalized)) {
    return "success";
  }
  if (["failed", "reverted", "error", "rejected"].includes(normalized)) {
    return "destructive";
  }
  if (["pending", "processing", "submitted", "waiting"].includes(normalized)) {
    return "warning";
  }
  return "default";
}

function isNumericValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = value.replace(/[$,%_,]/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inferColumnFormat(key: string, sample: unknown[]): ColumnDef["format"] {
  const keyLower = key.toLowerCase();
  const nonNull = sample.filter((value) => value !== null && value !== undefined);
  if (nonNull.length === 0) return "text";

  if (nonNull.every((value) => isDateLike(value))) {
    return "date";
  }

  const numeric = nonNull.map(toNumber).filter((value): value is number => value !== null);
  if (numeric.length >= Math.max(1, Math.floor(nonNull.length * 0.7))) {
    const looksPercent =
      keyLower.includes("pct") ||
      keyLower.includes("percent") ||
      keyLower.includes("change") ||
      keyLower.endsWith("_return") ||
      keyLower.endsWith("return");
    if (looksPercent) return "percent";

    const looksCurrency = [
      "amount",
      "aum",
      "balance",
      "fees",
      "price",
      "revenue",
      "tvl",
      "usd",
      "value",
      "volume",
    ].some((token) => keyLower.includes(token));
    if (looksCurrency) {
      const maxAbs = Math.max(...numeric.map((value) => Math.abs(value)));
      return maxAbs >= 100_000 ? "compact-currency" : "currency";
    }
    return "number";
  }

  return "text";
}

export function inferColumns(data: Record<string, unknown>[]): ColumnDef[] {
  if (data.length === 0) return [];

  const keyCounts = new Map<string, number>();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  const keys = [...keyCounts.entries()]
    .filter(([, count]) => count / data.length >= 0.7)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);

  const sampleRows = data.slice(0, 20);
  return keys.map((key) => {
    const sample = sampleRows.map((row) => row[key]);
    const format = inferColumnFormat(key, sample);
    const firstString = sample.find((value) => typeof value === "string") as string | undefined;
    const column: ColumnDef = {
      key,
      label: humanizeKey(key),
      format,
      sortable: true,
      align: format === "number" || format === "currency" || format === "compact-currency" || format === "percent"
        ? "right"
        : "left",
    };

    if (firstString && URL_RE.test(firstString)) {
      column.cell = { type: "link", hrefKey: key };
      column.format = "text";
    } else if (firstString && looksLikeStatus(firstString)) {
      const statusValues = Array.from(
        new Set(sample.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))),
      );
      column.cell = {
        type: "badge",
        intentMap: Object.fromEntries(
          statusValues.map((value) => [value, statusIntent(value)]),
        ),
      };
      column.format = "text";
    }

    return column;
  });
}

function isFlatObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => {
    if (entry === null || entry === undefined) return true;
    if (Array.isArray(entry)) return false;
    return typeof entry !== "object";
  });
}

function sourceUrl(value: Record<string, unknown>): string | undefined {
  const candidate = value.url ?? value.link ?? value.href ?? value.source_url;
  return typeof candidate === "string" && URL_RE.test(candidate) ? candidate : undefined;
}

function isSourceItem(value: unknown): value is Record<string, unknown> & { title: string } {
  if (!isRecord(value)) return false;
  return typeof value.title === "string" && sourceUrl(value) !== undefined;
}

function sourceItemsFromUnknown(value: unknown): SourceItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSourceItem).map((item) => ({
    url: sourceUrl(item)!,
    title: item.title,
    snippet: typeof item.snippet === "string" && item.snippet.trim()
      ? item.snippet
      : typeof item.summary === "string" && item.summary.trim()
        ? item.summary
        : typeof item.description === "string" && item.description.trim()
          ? item.description
          : undefined,
  }));
}

function isTableLike(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const rows = value.filter(isRecord);
  if (rows.length < Math.max(1, Math.floor(value.length * 0.8))) return false;
  const keySets = rows.map((row) => new Set(Object.keys(row)));
  const reference = keySets[0];
  if (!reference || reference.size < 2) return false;
  let overlaps = 0;
  for (const keys of keySets) {
    const shared = [...reference].filter((key) => keys.has(key)).length;
    if (shared / reference.size >= 0.7) overlaps += 1;
  }
  return overlaps / rows.length >= 0.8;
}

function detectChartCandidate(
  data: Record<string, unknown>[],
  columns: ColumnDef[],
): Omit<ChartBlock, "type"> | null {
  if (data.length < 2 || columns.length < 2) return null;
  const dateColumn = columns.find((column) => column.format === "date");
  if (!dateColumn) return null;
  const numericColumns = columns.filter((column) =>
    ["number", "currency", "compact-currency", "percent"].includes(column.format),
  );
  if (numericColumns.length === 0) return null;
  const rowCount = data.length;
  return {
    chartType: numericColumns.length > 1 ? "line" : "bar",
    columns,
    data,
    xKey: dateColumn.key,
    yKeys: numericColumns.slice(0, 4).map((column) => column.key),
    rowCount,
  };
}

function detectMarkdownBlock(text: string): MarkdownBlock | null {
  const trimmed = text.trim();
  if (!trimmed || !looksLikeMarkdown(trimmed)) return null;
  return { type: "markdown", text: trimmed };
}

export function detectContentBlocks(
  raw: unknown,
  options?: { toolName?: string },
): ContentBlock[] {
  const parsedOutput = parseToolOutput(raw);
  const parsed = parsedOutput.parsed;
  const family = toolFamily(options?.toolName);

  if (isRecord(parsed) && TOOL_SOURCE_HINTS.has(family)) {
    const blocks: ContentBlock[] = [];
    if (typeof parsed.answer_markdown === "string" && parsed.answer_markdown.trim()) {
      blocks.push({ type: "markdown", text: parsed.answer_markdown });
    }
    const sources = sourceItemsFromUnknown(parsed.sources ?? parsed.results);
    if (sources.length > 0) {
      blocks.push({ type: "sources", items: sources });
    }
    if (blocks.length > 0) {
      return blocks;
    }
  }

  if (Array.isArray(parsed) && parsed.every(isSourceItem)) {
    return [{ type: "sources", items: sourceItemsFromUnknown(parsed) }];
  }

  if (Array.isArray(parsed) && isTableLike(parsed)) {
    const rows = parsed.filter(isRecord);
    const columns = inferColumns(rows);
    const chart = detectChartCandidate(rows, columns);
    if (chart && TOOL_TABLE_HINTS.has(family)) {
      return [{ type: "chart", ...chart }];
    }
    return chart ? [{ type: "chart", ...chart }] : [{ type: "table", columns, data: rows, rowCount: rows.length }];
  }

  if (isRecord(parsed) && Array.isArray(parsed.results) && isTableLike(parsed.results)) {
    const rows = parsed.results.filter(isRecord);
    const columns = inferColumns(rows);
    return [{ type: "table", columns, data: rows, rowCount: rows.length }];
  }

  if (isRecord(parsed) && isFlatObject(parsed)) {
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
    if (entries.length > 0) {
      return [
        {
          type: "entity",
          entries,
          items: entries.map(([key, value]) => ({
            label: humanizeKey(key),
            value: value == null ? "—" : String(value),
            format: inferColumnFormat(key, [value]),
          })),
        },
      ];
    }
  }

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    if (IMAGE_URL_RE.test(trimmed)) {
      return [{ type: "image", url: trimmed }];
    }
    const markdown = detectMarkdownBlock(trimmed);
    if (markdown) return [markdown];
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (IMAGE_URL_RE.test(trimmed)) {
      return [{ type: "image", url: trimmed }];
    }
    const markdown = detectMarkdownBlock(trimmed);
    if (markdown) return [markdown];
  }

  const fallbackText = parsedOutput.text || stableStringify(parsed);
  return [{ type: "raw", text: fallbackText }];
}

function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return [
    /^#{1,6}\s/m,
    /\*\*[^*]+\*\*/,
    /`{3}/,
    /\[[^\]]+\]\([^)]+\)/,
    /^\s*[-*+]\s/m,
    /^\s*\d+\.\s/m,
    /^>\s/m,
    /^\|.+\|$/m,
  ].some((pattern) => pattern.test(trimmed));
}

function firstSentence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const heading = compact.match(/^#+\s+(.+?)(?:\s|$)/);
  if (heading?.[1]) return heading[1];
  const sentence = compact.match(/^(.+?[.!?])(?:\s|$)/);
  return (sentence?.[1] ?? compact).trim();
}

function firstStringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function summarizeToolOutput(raw: unknown, toolName?: string): string {
  const blocks = detectContentBlocks(raw, { toolName });
  const first = blocks[0];
  if (!first) return "No results";

  if (first.type === "sources") {
    const domains = [...new Set(first.items.slice(0, 3).map((item) => {
      try {
        return new URL(item.url).host.replace(/^www\./, "");
      } catch {
        return item.url;
      }
    }))];
    return `${first.items.length} results${domains.length > 0 ? ` from ${domains.join(", ")}` : ""}`;
  }

  if (first.type === "table" || first.type === "chart") {
    const labelKey = first.columns.find((column) => column.format === "text")?.key ?? first.columns[0]?.key;
    const metricColumn = first.columns.find((column) =>
      ["number", "currency", "compact-currency", "percent"].includes(column.format),
    );
    if (labelKey && metricColumn) {
      const ranked = [...first.data]
        .map((row) => ({
          label: row[labelKey],
          value: toNumber(row[metricColumn.key]),
        }))
        .filter((row): row is { label: unknown; value: number } => row.value !== null)
        .sort((a, b) => b.value - a.value);
      if (ranked.length > 0) {
        return `${first.rowCount} rows · Top by ${metricColumn.label}: ${String(ranked[0].label)} (${formatValue(ranked[0].value, metricColumn.format)})`;
      }
    }
    return `${first.rowCount} ${first.rowCount === 1 ? "row" : "rows"}`;
  }

  if (first.type === "entity") {
    const record = Object.fromEntries(first.entries);
    const status = firstStringField(record, ["status", "state"]);
    const hash = firstStringField(record, ["hash", "tx_hash", "transaction_hash", "id"]);
    if (hash && status) {
      const shortHash =
        hash.length > 14 && (ADDRESS_RE.test(hash) || HASH_RE.test(hash))
          ? `${hash.slice(0, 6)}...${hash.slice(-4)}`
          : hash;
      return `${shortHash}: ${status}`;
    }
    const firstEntry = first.entries[0];
    if (firstEntry) {
      return `${humanizeKey(firstEntry[0])}: ${String(firstEntry[1])}`.slice(0, 80);
    }
    return "1 item";
  }

  if (first.type === "markdown") {
    const sentence = firstSentence(first.text);
    return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
  }

  if (first.type === "image") {
    return "Image";
  }

  const rawText = first.text.trim();
  if (!rawText) return "No results";
  return rawText.length > 80 ? `${rawText.slice(0, 79)}…` : rawText;
}
