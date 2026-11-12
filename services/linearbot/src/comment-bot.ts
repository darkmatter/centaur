import type { ChatSDKStreamChunk } from "@centaur/rendering";

// Linear comments carry concise outcomes. The durable session and Console keep
// task activity, reasoning, and failure diagnostics.
const SUMMARY_MARKER = /^\s*LINEAR_SUMMARY\s*:\s*/im;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_SUMMARY_LINES = 8;
const MISSING_SUMMARY =
  "Execution completed, but a concise outcome was unavailable. See Centaur Console for details.";
const FAILED_SUMMARY =
  "⚠️ The execution ended before a verified outcome could be posted. See Centaur Console for details.";

export function commentMentionsBot(
  body: string,
  names: string[],
  markers: { botUserId?: string; profileHandle?: string } = {},
): boolean {
  if (
    markers.profileHandle &&
    body.includes(`/profiles/${markers.profileHandle}`)
  ) {
    return true;
  }
  if (markers.botUserId && body.includes(markers.botUserId)) return true;
  const haystack = body.toLowerCase();
  return names.some((name) => {
    const needle = name.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(`@${needle}`);
  });
}

/** Only task failure state is needed from the stream; terminal text is separate. */
export class CommentReplyCollector {
  private sawError = false;

  update(chunk: ChatSDKStreamChunk): void {
    if (chunk.type === "task_update" && chunk.status === "error") {
      this.sawError = true;
    }
  }

  get failed(): boolean {
    return this.sawError;
  }
}

export function buildThinkingReplyBody(): string {
  return "On it — I’ll report the verified outcome here.";
}

export function buildFailedReplyBody(): string {
  return FAILED_SUMMARY;
}

/** Reject unmarked terminal text and common execution-transcript formats. */
export function buildCommentReplyBody(input: { fallback?: string }): string {
  const value = input.fallback;
  if (!value) return MISSING_SUMMARY;
  const marker = SUMMARY_MARKER.exec(value);
  if (!marker || marker.index === undefined) return MISSING_SUMMARY;
  const summary = value.slice(marker.index + marker[0].length).trim();
  if (!summary) return MISSING_SUMMARY;
  if (/<details\b|<summary\b|\b(?:chain of thought|command execution|tool output|raw log|execution log)\b|^\s*(?:let me|i need to|i'll|i’ll|now i'll|now i’ll)\b/im.test(summary)) {
    return MISSING_SUMMARY;
  }
  const lines = summary.split(/\r?\n/).filter((line) => line.trim());
  const bounded = lines.slice(0, MAX_SUMMARY_LINES).join("\n");
  return bounded.length > MAX_SUMMARY_CHARS || lines.length > MAX_SUMMARY_LINES
    ? bounded.slice(0, MAX_SUMMARY_CHARS - 48).trimEnd() + "\n… Full answer continues in Console."
    : bounded;
}
