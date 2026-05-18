export class EventDeduper {
  readonly ttlMs: number
  private readonly seen = new Map<string, number>()

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  checkAndRemember(key: string, now = Date.now()): boolean {
    this.prune(now)
    const expiresAt = this.seen.get(key)
    if (expiresAt && expiresAt > now) return false
    this.seen.set(key, now + this.ttlMs)
    return true
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
    }
  }
}

export function slackDedupKey(opts: {
  eventId?: string
  teamId?: string
  channelId?: string
  messageTs?: string
}): string {
  if (opts.eventId) return `event:${opts.eventId}`
  return `message:${opts.teamId ?? 'unknown'}:${opts.channelId ?? 'unknown'}:${opts.messageTs ?? 'unknown'}`
}
