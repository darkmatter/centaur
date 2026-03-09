import { formatValue } from "@/components/dashboard/format-value";
import { extractDashboardBlocks } from "@/lib/viewer/dashboard-parser";
import type {
  BarChartProps,
  DashboardSpec,
  DataTableProps,
  KPICardProps,
  LineChartProps,
  PieChartProps,
} from "@/lib/viewer/dashboard-types";

const MAX_MARKDOWN_TEXT = 3_800;
const MAX_FALLBACK_TEXT = 4_000;
const MAX_BLOCKS_PER_MESSAGE = 40;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const DEFAULT_THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "https://svc-ai.paradigm.xyz";

type SlackBlock = Record<string, unknown>;
type SlackAttachment = Record<string, unknown>;

export type SlackReplyMetadata = {
  threadKey?: string;
  viewerUrl?: string;
  harness?: string;
  durationSeconds?: number;
  toolCount?: number;
  sourceLabel?: string;
};

export type SlackMessagePayload = {
  text: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
  unfurl_links: boolean;
  unfurl_media: boolean;
};

type SlackDraft = {
  blocks: SlackBlock[];
  attachments: SlackAttachment[];
  textParts: string[];
  markdownChars: number;
};

type ParsedMarkdownTable = {
  before: string;
  headers: string[];
  rows: string[][];
  after: string;
};

type SlackTableCell = Record<string, unknown>;

function createDraft(): SlackDraft {
  return {
    blocks: [],
    attachments: [],
    textParts: [],
    markdownChars: 0,
  };
}

export function splitMarkdownChunks(markdown: string, maxChars: number = MAX_MARKDOWN_TEXT): string[] {
  const text = markdown.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const groups: string[] = [];
  const lines = text.split("\n");
  let currentGroup: string[] = [];
  let inFence = false;

  const pushGroup = () => {
    if (currentGroup.length === 0) return;
    groups.push(currentGroup.join("\n"));
    currentGroup = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }
    if (!inFence && line.trim() === "") {
      pushGroup();
      continue;
    }
    currentGroup.push(line);
  }
  pushGroup();

  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const normalized = current.replace(/^\n+|\n+$/g, "");
    if (normalized.trim()) {
      chunks.push(normalized);
    }
    current = "";
  };

  for (const group of groups) {
    const candidate = current ? `${current}\n\n${group}` : group;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) pushCurrent();
    if (group.length <= maxChars) {
      current = group;
      continue;
    }

    const groupLines = group.split("\n");
    const isFence = groupLines[0]?.trimStart().startsWith("```") && groupLines[groupLines.length - 1]?.trimStart().startsWith("```");
    if (isFence && groupLines.length >= 2) {
      const openingFence = groupLines[0];
      const closingFence = groupLines[groupLines.length - 1];
      const bodyLines = groupLines.slice(1, -1);
      const wrapperOverhead = openingFence.length + closingFence.length + 2;
      const bodyLimit = Math.max(256, maxChars - wrapperOverhead);
      let bodyChunk = "";
      for (const line of bodyLines) {
        const candidate = bodyChunk ? `${bodyChunk}\n${line}` : line;
        if (candidate.length <= bodyLimit) {
          bodyChunk = candidate;
          continue;
        }
        if (bodyChunk) {
          chunks.push(`${openingFence}\n${bodyChunk}\n${closingFence}`);
          bodyChunk = "";
        }
        let remainder = line;
        while (remainder.length > bodyLimit) {
          chunks.push(`${openingFence}\n${remainder.slice(0, bodyLimit)}\n${closingFence}`);
          remainder = remainder.slice(bodyLimit);
        }
        bodyChunk = remainder;
      }
      if (bodyChunk) {
        current = `${openingFence}\n${bodyChunk}\n${closingFence}`;
      }
      continue;
    }

    let lineChunk = "";
    for (const line of groupLines) {
      const nextLineChunk = lineChunk ? `${lineChunk}\n${line}` : line;
      if (nextLineChunk.length <= maxChars) {
        lineChunk = nextLineChunk;
        continue;
      }

      if (lineChunk) {
        chunks.push(lineChunk);
        lineChunk = "";
      }

      if (line.length <= maxChars) {
        lineChunk = line;
        continue;
      }

      let remainder = line;
      while (remainder.length > maxChars) {
        let cut = safeCutIndex(remainder, maxChars);
        if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
        chunks.push(remainder.slice(0, cut));
        remainder = remainder.slice(cut).replace(/^\s+/, "");
      }
      lineChunk = remainder;
    }

    if (lineChunk) {
      current = lineChunk;
    }
  }

  if (current) pushCurrent();
  return chunks;
}

function viewerUrlFromMetadata(metadata?: SlackReplyMetadata): string | undefined {
  if (metadata?.viewerUrl) return metadata.viewerUrl;
  if (!metadata?.threadKey) return undefined;
  return `${DEFAULT_THREAD_VIEWER_URL}/${encodeURIComponent(metadata.threadKey)}`;
}

function compactDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function metadataContext(metadata?: SlackReplyMetadata): SlackBlock | null {
  if (!metadata) return null;
  const parts = [
    metadata.sourceLabel || "Paradigm AI",
    metadata.harness || null,
    compactDuration(metadata.durationSeconds),
    metadata.toolCount ? `${metadata.toolCount} tool ${metadata.toolCount === 1 ? "call" : "calls"}` : null,
  ].filter((value): value is string => Boolean(value));
  if (parts.length === 0) return null;

  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: parts.join("  •  "),
      },
    ],
  };
}

function viewerActions(metadata?: SlackReplyMetadata): SlackBlock | null {
  const viewerUrl = viewerUrlFromMetadata(metadata);
  if (!viewerUrl) return null;
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Thread Viewer",
          emoji: true,
        },
        url: viewerUrl,
        action_id: "open_thread_viewer",
      },
    ],
  };
}

function addBlock(drafts: SlackDraft[], draft: SlackDraft, block: SlackBlock): SlackDraft {
  if (draft.blocks.length >= MAX_BLOCKS_PER_MESSAGE) {
    drafts.push(draft);
    const next = createDraft();
    next.blocks.push(block);
    return next;
  }
  draft.blocks.push(block);
  return draft;
}

function addMarkdown(drafts: SlackDraft[], draft: SlackDraft, markdown: string): SlackDraft {
  for (const chunk of splitMarkdownChunks(markdown)) {
    if (!chunk) continue;
    if (draft.markdownChars + chunk.length > MAX_MARKDOWN_TEXT || draft.blocks.length >= MAX_BLOCKS_PER_MESSAGE) {
      drafts.push(draft);
      draft = createDraft();
    }
    draft.blocks.push({ type: "markdown", text: chunk });
    rememberText(draft, markdownToFallbackText(chunk));
    draft.markdownChars += chunk.length;
  }
  return draft;
}

function rememberText(draft: SlackDraft, text: string): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return;
  draft.textParts.push(normalized);
}

function truncateCellText(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

function rawTextCell(text: string): SlackTableCell {
  return {
    type: "raw_text",
    text: truncateCellText(text),
  };
}

function richTextCell(text: string): SlackTableCell {
  const elements: Array<Record<string, unknown>> = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<@([A-Z0-9]+)>|(https?:\/\/\S+)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      elements.push({ type: "text", text: truncateCellText(text.slice(lastIndex, index)) });
    }
    if (match[1] && match[2]) {
      elements.push({ type: "link", url: match[2], text: truncateCellText(match[1]) });
    } else if (match[3]) {
      elements.push({ type: "user", user_id: match[3] });
    } else if (match[4]) {
      elements.push({ type: "link", url: match[4], text: truncateCellText(match[4]) });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push({ type: "text", text: truncateCellText(text.slice(lastIndex)) });
  }

  if (elements.length === 0) {
    return rawTextCell(text);
  }

  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements,
      },
    ],
  };
}

function tableCell(text: string): SlackTableCell {
  if (/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<@[A-Z0-9]+>|https?:\/\/\S+/.test(text)) {
    return richTextCell(text);
  }
  return rawTextCell(text);
}

function markdownTableFromDataTable(component: DataTableProps): SlackAttachment | null {
  const visibleColumns = component.columns.slice(0, MAX_TABLE_COLUMNS);
  if (visibleColumns.length === 0) return null;
  const headerRow = visibleColumns.map((column) => tableCell(column.label));
  const bodyRows = component.data.slice(0, MAX_TABLE_ROWS - 1).map((row) =>
    visibleColumns.map((column) => tableCell(formatValue(row[column.key], column.format))),
  );

  return {
    blocks: [
      {
        type: "table",
        rows: [headerRow, ...bodyRows],
        column_settings: visibleColumns.map((column) => ({
          align: column.format === "number" || column.format === "currency" || column.format === "percent"
            ? "right"
            : "left",
          is_wrapped: column.format === "text",
        })),
      },
    ],
  };
}

function kpiSection(components: KPICardProps[]): SlackBlock | null {
  if (components.length === 0) return null;
  const fields = components.slice(0, 5).flatMap((component) => [
    {
      type: "mrkdwn",
      text: `*${component.label}*`,
    },
    {
      type: "mrkdwn",
      text: formatValue(component.value, component.format),
    },
  ]);

  return {
    type: "section",
    fields,
  };
}

function summarizeKpis(components: KPICardProps[]): string {
  return components
    .slice(0, 5)
    .map((component) => `${component.label}: ${formatValue(component.value, component.format)}`)
    .join(" • ");
}

function tableFallbackSummary(
  headers: string[],
  rows: string[][],
  title?: string,
): string {
  const prefix = title ? `${title}. ` : "";
  const shownHeaders = headers.slice(0, 3).join(", ");
  const rowPreview = rows
    .slice(0, 3)
    .map((row) => row.slice(0, headers.length).join(" | "))
    .filter(Boolean)
    .join("; ");
  return `${prefix}Table with ${rows.length} rows${shownHeaders ? ` (${shownHeaders})` : ""}.${rowPreview ? ` Sample rows: ${rowPreview}.` : ""}`;
}

function chartSummary(component: LineChartProps | BarChartProps | PieChartProps): string {
  if (component.type === "line-chart") {
    const rows = component.data.slice(0, 6).map((row) => {
      const values = component.yKeys
        .map((key) => `${key}: ${String(row[key] ?? "—")}`)
        .join(", ");
      return `- ${String(row[component.xKey] ?? "—")}: ${values}`;
    });
    return `### ${component.title}\n${rows.join("\n")}`;
  }

  if (component.type === "bar-chart") {
    const rows = component.data
      .slice(0, 6)
      .map((row) => `- ${String(row[component.categoryKey] ?? "—")}: ${String(row[component.valueKey] ?? "—")}`);
    return `### ${component.title}\n${rows.join("\n")}`;
  }

  const rows = component.data
    .slice(0, 6)
    .map((row) => `- ${String(row[component.labelKey] ?? "—")}: ${String(row[component.valueKey] ?? "—")}`);
  return `### ${component.title}\n${rows.join("\n")}`;
}

function markdownToFallbackText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/```[\w-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCutIndex(text: string, maxChars: number): number {
  let cut = text.lastIndexOf(" ", maxChars);
  if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;

  const protectedPatterns = [
    /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g,
    /<@[A-Z0-9]+>/g,
    /https?:\/\/\S+/g,
    /`[^`]+`/g,
  ];

  for (const pattern of protectedPatterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (start < cut && end > cut && start > 0) {
        cut = start;
      }
    }
  }

  return cut;
}

function addDashboardSpec(drafts: SlackDraft[], draft: SlackDraft, spec: DashboardSpec): SlackDraft {
  const kpis = spec.components.filter((component): component is KPICardProps => component.type === "kpi-card");
  if (kpis.length > 0) {
    const kpiBlock = kpiSection(kpis);
    if (kpiBlock) {
      draft = addBlock(drafts, draft, kpiBlock);
      rememberText(draft, summarizeKpis(kpis));
    }
  }

  for (const component of spec.components) {
    if (component.type === "kpi-card") continue;

    if (component.type === "data-table") {
      if (draft.attachments.length > 0) {
        drafts.push(draft);
        draft = createDraft();
      }
      if (component.title) {
        draft = addMarkdown(drafts, draft, `### ${component.title}`);
      }
      const attachment = markdownTableFromDataTable(component);
      if (attachment) {
        draft.attachments.push(attachment);
        rememberText(
          draft,
          tableFallbackSummary(
            component.columns.map((column) => column.label),
            component.data.map((row) =>
              component.columns.map((column) => formatValue(row[column.key], column.format)),
            ),
            component.title,
          ),
        );
      }
      if (component.data.length >= MAX_TABLE_ROWS) {
        draft = addMarkdown(
          drafts,
          draft,
          `_Showing the first ${MAX_TABLE_ROWS - 1} rows in Slack. Open the Thread Viewer for the full table._`,
        );
      }
      continue;
    }

    draft = addMarkdown(drafts, draft, chartSummary(component));
  }

  return draft;
}

function isPipeTableLine(line: string): boolean {
  return line.includes("|") && line.trim().startsWith("|") && line.trim().endsWith("|");
}

function parsePipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let inCode = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function extractFirstMarkdownTable(markdown: string): ParsedMarkdownTable | null {
  const lines = markdown.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index].trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!isPipeTableLine(lines[index])) continue;
    if (!/^[\s|:-]+$/.test(lines[index + 1])) continue;

    const start = index;
    let end = index + 2;
    while (end < lines.length && isPipeTableLine(lines[end])) {
      end += 1;
    }

    const headers = parsePipeRow(lines[start]);
    const rows = lines.slice(start + 2, end).map(parsePipeRow).filter((row) => row.length > 0);
    if (headers.length === 0 || rows.length === 0) continue;

    return {
      before: lines.slice(0, start).join("\n"),
      headers,
      rows,
      after: lines.slice(end).join("\n"),
    };
  }

  return null;
}

function markdownTableAttachment(table: ParsedMarkdownTable): SlackAttachment | null {
  const headers = table.headers.slice(0, MAX_TABLE_COLUMNS);
  if (headers.length === 0) return null;
  const rows = table.rows.slice(0, MAX_TABLE_ROWS - 1).map((row) =>
    headers.map((_, index) => tableCell(row[index] ?? "—")),
  );

  return {
    blocks: [
      {
        type: "table",
        rows: [headers.map((header) => tableCell(header)), ...rows],
        column_settings: headers.map((header) => ({
          align: /%|amount|price|value|volume|tvl|count|total/i.test(header) ? "right" : "left",
          is_wrapped: true,
        })),
      },
    ],
  };
}

function fallbackTextForDraft(draft: SlackDraft): string {
  const fromBlocks = draft.textParts.join("\n\n").replace(/\s+/g, " ").trim();
  if (!fromBlocks && draft.attachments.length > 0) {
    return "Structured results available in the Thread Viewer.";
  }
  return fromBlocks.slice(0, MAX_FALLBACK_TEXT) || "Agent reply";
}

function finalizeDrafts(drafts: SlackDraft[], metadata?: SlackReplyMetadata): SlackMessagePayload[] {
  if (drafts.length === 0) return [];

  const firstContext = metadataContext(metadata);
  if (firstContext) {
    drafts[0].blocks.unshift(firstContext);
  }

  return drafts
    .filter((draft) => draft.blocks.length > 0 || draft.attachments.length > 0)
    .map((draft) => ({
      text: buildAccessibleText(draft, metadata),
      ...(draft.blocks.length > 0 ? { blocks: draft.blocks } : {}),
      ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
      unfurl_links: false,
      unfurl_media: false,
    }));
}

export function resultToSlackMessages(
  markdown: string,
  metadata?: SlackReplyMetadata,
): SlackMessagePayload[] {
  const drafts: SlackDraft[] = [];
  let draft = createDraft();

  const dashboardBlocks = extractDashboardBlocks(markdown);
  if (dashboardBlocks.length > 0) {
    for (const block of dashboardBlocks) {
      if (block.before.trim()) {
        draft = addMarkdown(drafts, draft, block.before);
      }
      draft = addDashboardSpec(drafts, draft, block.spec);
      if (block.after.trim()) {
        draft = addMarkdown(drafts, draft, block.after);
      }
    }
  } else {
    const table = extractFirstMarkdownTable(markdown);
    if (!table) {
      draft = addMarkdown(drafts, draft, markdown);
    } else {
      if (table.before.trim()) {
        draft = addMarkdown(drafts, draft, table.before);
      }
      const attachment = markdownTableAttachment(table);
      if (attachment) {
        draft.attachments.push(attachment);
        rememberText(draft, tableFallbackSummary(table.headers, table.rows));
      }
      if (table.after.trim()) {
        draft = addMarkdown(drafts, draft, table.after);
      }
    }
  }

  if (draft.blocks.length > 0 || draft.attachments.length > 0) {
    drafts.push(draft);
  }

  return finalizeDrafts(drafts, metadata);
}

function buildAccessibleText(draft: SlackDraft, metadata?: SlackReplyMetadata): string {
  const parts: string[] = [];
  const metadataParts = [
    metadata?.sourceLabel || "Paradigm AI",
    metadata?.harness || null,
    compactDuration(metadata?.durationSeconds),
    metadata?.toolCount ? `${metadata.toolCount} tool ${metadata.toolCount === 1 ? "call" : "calls"}` : null,
  ].filter((value): value is string => Boolean(value));

  if (metadataParts.length > 0) {
    parts.push(metadataParts.join(" • "));
  }

  const body = fallbackTextForDraft(draft);
  if (body) {
    parts.push(body);
  }

  const viewerUrl = viewerUrlFromMetadata(metadata);
  if (viewerUrl) {
    parts.push(`Thread Viewer: ${viewerUrl}`);
  }

  return parts.join("\n\n").slice(0, MAX_FALLBACK_TEXT) || "Agent reply";
}
