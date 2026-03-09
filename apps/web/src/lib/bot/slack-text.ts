import { parseMarkdown, type Root } from "chat";
import { SlackFormatConverter } from "@chat-adapter/slack";

export const MAX_SLACK_TEXT_CHARS = 3800;

export function truncateSlackText(text: string): string {
  const safe = text.trim();
  if (!safe) return "";
  if (safe.length <= MAX_SLACK_TEXT_CHARS) return safe;
  return safe.slice(0, MAX_SLACK_TEXT_CHARS - 18).trimEnd() + "\n\n... (truncated)";
}

type MarkdownNode = Root | Root["children"][number];

function preprocessSlackLinks(text: string): string {
  let result = text;
  result = result.replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+)&gt;/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  return result;
}

function preprocessMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|.*\|\s*$/.test(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      const parseRow = (row: string): string[] =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());

      const dataRows = tableLines.filter(
        (l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)
      );
      if (dataRows.length === 0) {
        result.push(...tableLines);
        continue;
      }

      const headers = parseRow(dataRows[0]);
      const bodyRows = dataRows.slice(1);

      if (bodyRows.length === 0) {
        result.push(headers.map((h) => `*${h}*`).join("  ·  "));
        result.push("");
      } else {
        for (const row of bodyRows) {
          const cells = parseRow(row);
          const label = cells[0] || "";
          result.push(`*${label}*`);
          for (let c = 1; c < cells.length; c++) {
            const headerLabel = headers[c] || `Col ${c}`;
            result.push(`• *${headerLabel}:* ${cells[c] || "—"}`);
          }
          result.push("");
        }
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function escapeLiteralTildes(node: MarkdownNode, inDelete = false): void {
  const insideDelete = inDelete || node.type === "delete";

  if (node.type === "text" && !insideDelete) {
    node.value = node.value.replace(/~/g, "\\~");
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children as Root["children"]) {
      escapeLiteralTildes(child, insideDelete);
    }
  }
}

const slackFmt = new SlackFormatConverter();

/**
 * Convert standard Markdown to Slack mrkdwn string.
 *
 * Uses the same AST pipeline as the main bot path:
 * preprocessSlackLinks → preprocessMarkdownTables → parseMarkdown → escapeLiteralTildes → SlackFormatConverter.fromAst
 */
export function markdownToSlack(markdown: string): string {
  const ast = parseMarkdown(preprocessMarkdownTables(preprocessSlackLinks(markdown)));
  escapeLiteralTildes(ast);
  return slackFmt.fromAst(ast);
}
