/**
 * Thin Slack-side interception for the native OMP collaboration command.
 *
 * The Chat SDK normalizes Slack mention tokens before handlers run:
 * `<@U123|name>` becomes `@name` and the bot's own `<@U123>` becomes `@U123`,
 * so `message.text` never carries raw `<@...>` tokens. We strip both raw tokens
 * (defensive) and normalized standalone `@mentions` defensively, matching the
 * stop/export command conventions.
 */

export type CollabSubcommand = 'start' | 'status' | 'stop'

export type ParsedCollabCommand = {
  subcommand: CollabSubcommand
  args: string[]
}

const COLLAB_COMMAND_PATTERN = /^collab(?:\s|$)/i

/**
 * Recognises the `/collab` family of commands after mention stripping. Returns
 * the parsed subcommand (defaulting to `start` when the bare word `collab` is
 * sent) or `undefined` when the text is not a collab command.
 *
 * Accepted forms (after mention stripping):
 *   collab                 → start
 *   collab start           → start
 *   collab status          → status
 *   collab stop            → stop
 *   collab start extra     → start with args ['extra'] (reported as malformed)
 */
export function parseCollabCommand(message: { text: string }): ParsedCollabCommand | undefined {
  const text = stripMentions(message.text).trim()
  if (!text) return undefined
  if (!COLLAB_COMMAND_PATTERN.test(text)) return undefined

  // Drop the leading `collab` token.
  const rest = text.replace(/^collab\s*/i, '').trim()
  if (rest === '') return { subcommand: 'start', args: [] }

  const tokens = rest.split(/\s+/)
  const head = tokens[0]!.toLowerCase()
  if (head === 'start' || head === 'status' || head === 'stop') {
    return { subcommand: head, args: tokens.slice(1) }
  }
  // Unknown subcommand: treat the whole tail as args so the handler can report
  // a malformed command rather than silently starting a room.
  return { subcommand: 'start', args: tokens }
}

/** Whether a parsed command carries extra arguments the subcommand does not take. */
export function hasMalformedCollabArgs(parsed: ParsedCollabCommand): boolean {
  return parsed.args.length > 0
}

/**
 * Render the start response as exactly one copyable shell command. The
 * capability URL is a full `omp join`-able tailnet link emitted by the
 * resident OMP host via api-rs — ingress never synthesises the relay prefix.
 *
 * Single-quote escaping follows the POSIX rule: replace every `'` in the URL
 * with the four-character sequence `'\''` (close quote, escaped quote, reopen
 * quote). The result is safe to paste into any POSIX shell.
 */
export function renderCollabJoinCommand(joinUrl: string): string {
  return `omp join '${posixSingleQuoteEscape(joinUrl)}'`
}

/** POSIX single-quote escape: `'` → `'\''`. Exported for testing. */
export function posixSingleQuoteEscape(value: string): string {
  return value.replaceAll("'", "'\\''")
}

function stripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, ' ')
    .replace(/(^|\s)@[A-Za-z0-9._-]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
