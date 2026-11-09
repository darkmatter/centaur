import type { ChatSDKStreamChunk } from "@centaur/rendering";

// Threads are king: a GitHub PR/issue comment thread maps to one Centaur
// sandbox/context. GitHub is a concise public outcome surface; Console is the
// durable execution record. In particular, do not carry task updates or model
// reasoning from the stream into a GitHub comment.

const PUBLIC_SUMMARY_MAX_CHARS = 2_000;
const PUBLIC_SUMMARY_MAX_LINES = 8;
const PUBLIC_SUMMARY_MARKER = /^\s*GITHUB_SUMMARY\s*:\s*/im;
const PUBLIC_SUMMARY_FIELDS = [ "Outcome", "Changes", "Verification", "CI", "Next" ] as const;
const PUBLIC_SUMMARY_FIELD_MARKER =
  /(?:^|\s)(Outcome|Changes|Verification|CI|Next)\s*:\s*/gi;
const INTERNAL_DETAILS_SECTION =
  /<details\b[^>]*>\s*<summary>\s*(?:chain\s+of\s+thought|thinking|reasoning|work\s+log|execution\s+log)\b[^<]*<\/summary>[\s\S]*?<\/details>\s*/gi;
// The marker and compact bounds are the primary disclosure boundary. This is
// only an opportunistic backstop for familiar transcript formats; update it
// when a concrete new leak is observed rather than treating it as a parser.
// `Plan's clear` appeared in the original leaked GitHub transcript.
const EXECUTION_TRANSCRIPT_MARKERS =
  /<details\b|<summary\b|\b(?:chain\s+of\s+thought|command execution|tool output|raw log|execution log)\b|^\s*(?:let me|i need to|i'll|i’ll|now i'll|now i’ll|first,? let me|plan(?:'|’)s clear)\b/im;
const MISSING_PUBLIC_SUMMARY =
  "Execution completed, but a concise verified summary was unavailable. Review the latest PR commit and checks; Centaur Console has the detailed record.";
const FAILED_PUBLIC_SUMMARY =
  "⚠️ The execution ended before a verified outcome could be posted. Review the latest PR commits and checks; Centaur Console has the detailed diagnostic record.";

/**
 * Accumulates the public final answer from a streamed run. Task updates are
 * deliberately not rendered to GitHub: they can contain tool commands and
 * execution detail that belongs in the durable Console record instead.
 */
export class CommentReplyCollector {
  private sawError = false;

  update(chunk: ChatSDKStreamChunk): void {
    // Markdown chunks are deliberately ignored. Some providers classify their
    // entire work trace as assistant prose, so treating this stream as a final
    // answer is a chain-of-thought disclosure bug. The structured terminal
    // result is captured separately by GithubRenderFallback.
    if (chunk.type === "markdown_text") return;
    if (chunk.type !== "task_update" || chunk.status !== "error") return;
    this.sawError = true;
  }

  get failed(): boolean {
    return this.sawError;
  }
}

/**
 * A short acknowledgement posted before a potentially long-lived sandbox turn.
 * It establishes the public contract without narrating the execution itself.
 */
export function buildWorkingReplyBody(): string {
  return "I’m on it. I’ll inspect the request, reproduce relevant failures locally, run the closest CI-equivalent checks, and report the verified outcome here.";
}

/**
 * A rendered GitHub reply and whether it had a verified concise summary. The
 * boolean is deliberately observable so operators can measure how often a
 * provider misses the public-summary contract without logging its contents.
 */
export type GithubPublicReply = {
  body: string;
  summaryAvailable: boolean;
};

export function buildPublicCommentReply(input: {
  fallback?: string;
}): GithubPublicReply {
  // Only use the structured terminal result. Providers can classify their
  // entire work trace as assistant prose, so streamed markdown is never a
  // public-reply source.
  const summary = extractPublicSummary(input.fallback);
  return summary
    ? { body: summary, summaryAvailable: true }
    : { body: MISSING_PUBLIC_SUMMARY, summaryAvailable: false };
}

/** Fixed public error text; Console remains the diagnostic surface. */
export function buildFailedReplyBody(): string {
  return FAILED_PUBLIC_SUMMARY;
}

function extractPublicSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const marker = PUBLIC_SUMMARY_MARKER.exec(value);
  if (!marker || marker.index === undefined) return undefined;
  const summary = value
    .slice(marker.index + marker[0].length)
    .replace(INTERNAL_DETAILS_SECTION, "")
    .trim();
  if (!summary || summary.length > PUBLIC_SUMMARY_MAX_CHARS) return undefined;
  if (summary.split(/\r?\n/).filter((line) => line.trim()).length > PUBLIC_SUMMARY_MAX_LINES) {
    return undefined;
  }
  if (EXECUTION_TRANSCRIPT_MARKERS.test(summary)) return undefined;
  return formatPublicSummary(summary);
}

/**
 * Models occasionally emit the required fields on one long line even when the
 * terminal contract asks for line breaks. A complete, ordered contract is safe
 * to reflow because the labels delimit each field; partial summaries remain
 * verbatim for backwards compatibility.
 */
function formatPublicSummary(summary: string): string {
  const matches = Array.from(summary.matchAll(PUBLIC_SUMMARY_FIELD_MARKER));
  if (
    matches.length !== PUBLIC_SUMMARY_FIELDS.length ||
    matches.some(
      (match, index) =>
        match[1]?.toLowerCase() !== PUBLIC_SUMMARY_FIELDS[index]?.toLowerCase(),
    ) ||
    summary.slice(0, matches[0]?.index ?? 0).trim()
  ) {
    return summary;
  }

  const fields = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? summary.length;
    return summary.slice(start, end).replace(/\s+/g, " ").trim();
  });
  if (fields.some((field) => !field)) return summary;

  return [
    "### Centaur update",
    "",
    ...PUBLIC_SUMMARY_FIELDS.map(
      (label, index) => `- **${label}:** ${fields[index]}`,
    ),
  ].join("\n");
}
