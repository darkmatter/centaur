const EXPORT_COMMAND_PATTERN = new RegExp(
  [
    String.raw`^`,
    String.raw`(?:(?:please|pls)\s+)?`,
    String.raw`export`,
    String.raw`(?:\s+(?:this\s+)?(?:thread|session|chat|conversation))?`,
    String.raw`\s*[.!]?$`
  ].join(''),
  'i'
)

export function isSlackExportCommand(message: { text: string }): boolean {
  const text = message.text.trim()
  if (!text) return false
  // The Chat SDK normalizes Slack mention tokens before handlers run:
  // <@U123|name> becomes @name and the bot's own <@U123> becomes @U123, so
  // message.text never contains raw <@...> tokens. Strip both raw tokens
  // (defensive) and normalized standalone @mentions; mid-word @ (emails
  // like user@example.com) is left alone.
  const withoutMentions = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, ' ')
    .replace(/(^|\s)@[A-Za-z0-9._-]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return EXPORT_COMMAND_PATTERN.test(withoutMentions)
}

/** Direct tailnet viewer link for a thread transcript. */
export function exportLinkForThread(viewerUrl: string, threadId: string): string {
  return `${viewerUrl.replace(/\/$/, '')}/export/${encodeURIComponent(threadId)}`
}
