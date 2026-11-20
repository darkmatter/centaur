const maxCharacters = 2_000;
const maxLines = 8;
const continuation = "\n… Full answer continues in Console.";

/** Apply the public reply limits after the caller has validated its content. */
export function boundPublicReply(summary: string): string {
  const lines = summary.split(/\r?\n/).filter((line) => line.trim());
  const bounded = lines.slice(0, maxLines).join("\n");
  if (bounded.length <= maxCharacters && lines.length <= maxLines) {
    return bounded;
  }
  return bounded.slice(0, maxCharacters - 48).trimEnd() + continuation;
}
