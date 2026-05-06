import { SLACK_PLAIN_TEXT_MESSAGE_CHARS } from "./markdown";

const SLACK_MSG_MAX_CHARS = SLACK_PLAIN_TEXT_MESSAGE_CHARS;

const CANCELLED_EXECUTION_MESSAGE = "Request cancelled. Send another message when you want to retry.";
const SILENCE_DEADLINE_MESSAGE = "Agent stopped after making no visible progress. Please retry.";
const EXECUTION_FAILED_MESSAGE = "Agent hit a runtime issue before finishing. Please retry.";

// Maximum length of the raw error detail that gets surfaced to Slack — enough
// to be useful (e.g. "429 Rate limit exceeded") without dumping a full stack
// trace into the channel.
const ERROR_DETAIL_MAX_CHARS = 240;

// Internal/noisy error texts that aren't actionable for the user — we keep the
// generic friendly message and skip the detail block for these.
const SUPPRESSED_ERROR_FRAGMENTS = [
  "connection error",
  "silence deadline",
  "cancel_requested",
];

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

function redactErrorDetail(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+/gi, "[redacted Slack token]")
    .replace(/\b(authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\/(?:home\/agent\/(?:workspace|uploads)|tmp)\/[^\s)`'"]+/g, "[redacted path]");
}

function codeFence(value: string, language = "text"): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function harnessErrorDetail(terminalReason: string, errorText: string): string {
  if (!terminalReason && !errorText) return "";
  const lowerErr = errorText.toLowerCase();
  if (SUPPRESSED_ERROR_FRAGMENTS.some((frag) => lowerErr.includes(frag))) {
    return "";
  }
  const lines: string[] = [];
  if (terminalReason) {
    lines.push(`Reason: \`${terminalReason}\``);
  }
  if (errorText) {
    lines.push(codeFence(truncate(redactErrorDetail(errorText), ERROR_DETAIL_MAX_CHARS)));
  }
  return lines.join("\n");
}

/**
 * Split text into chunks that fit within Slack's message limit.
 * Splits on paragraph boundaries, then line boundaries, then spaces.
 */
export function splitSlackMessage(text: string, limit = SLACK_MSG_MAX_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = -1;
    const paraIdx = remaining.lastIndexOf("\n\n", limit);
    if (paraIdx > limit * 0.3) {
      cut = paraIdx;
    } else {
      const nlIdx = remaining.lastIndexOf("\n", limit);
      if (nlIdx > limit * 0.3) {
        cut = nlIdx;
      } else {
        const spIdx = remaining.lastIndexOf(" ", limit);
        cut = spIdx > limit * 0.3 ? spIdx : limit;
      }
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

export function flattenMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = parseMarkdownTableRow(lines[i]);
    if (!header || i + 1 >= lines.length || !isMarkdownTableSeparator(lines[i + 1])) {
      output.push(lines[i]);
      continue;
    }

    const rows: string[] = [];
    i += 2;
    while (i < lines.length) {
      const cells = parseMarkdownTableRow(lines[i]);
      if (!cells) break;
      rows.push(`- ${header.map((label, idx) => `${label}: ${cells[idx] ?? ""}`).join("; ")}`);
      i += 1;
    }
    output.push(...rows);
    i -= 1;
  }

  return output.join("\n");
}

export function isSlackInvalidBlocksError(message: string): boolean {
  return message.includes("invalid_blocks");
}

export function normalizedTerminalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isCancellationTerminalState(
  status: string,
  terminalReason: string,
  resultText = "",
  errorText = "",
): boolean {
  const rawValues = [terminalReason, resultText, errorText]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  return status === "cancelled"
    || rawValues.includes("cancel_requested")
    || rawValues.includes("cancelled")
    || rawValues.includes("released")
    || rawValues.includes("user cancelled (sigint/sigterm)");
}

export function renderTerminalResultCopy(opts: {
  status?: unknown;
  terminalReason?: unknown;
  resultText?: unknown;
  errorText?: unknown;
  isError?: unknown;
}): string {
  const status = normalizedTerminalString(opts.status);
  const terminalReason = normalizedTerminalString(opts.terminalReason);
  const resultText = normalizedTerminalString(opts.resultText);
  const errorText = normalizedTerminalString(opts.errorText);
  const rawValues = [terminalReason, resultText, errorText]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  const rawBlob = rawValues.join("\n");
  const detailText = errorText || (Boolean(opts.isError) ? resultText : "");

  if (status === "completed" && !Boolean(opts.isError)) {
    return resultText;
  }

  if (isCancellationTerminalState(status, terminalReason, resultText, errorText)) {
    return CANCELLED_EXECUTION_MESSAGE;
  }

  if (terminalReason === "silence_deadline_exceeded"
    || rawBlob.includes("execution made no progress before silence deadline")
    || rawBlob.includes("silence deadline")) {
    return SILENCE_DEADLINE_MESSAGE;
  }

  if (status === "failed_permanent"
    || Boolean(opts.isError)
    || rawValues.includes("harness_error")
    || rawValues.includes("amp_reconnect_timeout")
    || rawValues.includes("execution_error")
    || rawValues.includes("stream_ended_without_turn_done")
    || rawValues.includes("assignment_missing")
    || rawValues.includes("hard_deadline_exceeded")
    || rawBlob.includes("connection error")) {
    const detail = harnessErrorDetail(terminalReason, detailText);
    return detail ? `${EXECUTION_FAILED_MESSAGE}\n\n${detail}` : EXECUTION_FAILED_MESSAGE;
  }

  return resultText;
}
