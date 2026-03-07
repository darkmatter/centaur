const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlackLiveReply {
  private channel: string;
  private threadTs: string;
  private flushIntervalMs: number;
  private messageTs: string | null = null;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightFlush: Promise<void> | null = null;
  private disposed = false;

  constructor(channel: string, threadTs: string, opts?: { flushIntervalMs?: number }) {
    this.channel = channel;
    this.threadTs = threadTs;
    this.flushIntervalMs = opts?.flushIntervalMs ?? 2500;
  }

  async start(initialText: string): Promise<void> {
    const res = await this.slackApi("chat.postMessage", {
      channel: this.channel,
      thread_ts: this.threadTs,
      text: initialText,
      unfurl_links: false,
    });
    if (res.ok && res.ts) {
      this.messageTs = res.ts;
    }
  }

  queueUpdate(markdown: string): void {
    if (this.disposed || !this.messageTs) return;
    this.pendingText = markdown;
    if (!this.flushTimer && !this.inFlightFlush) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  async finish(markdown: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingText = null;
    // Wait for any in-flight flush to complete before sending the final update
    if (this.inFlightFlush) {
      await this.inFlightFlush;
    }
    if (this.messageTs) {
      await this.updateMessage(markdown);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.disposed || !this.pendingText || !this.messageTs) return;
    const text = this.pendingText;
    this.pendingText = null;
    this.inFlightFlush = this.updateMessage(text).finally(() => {
      this.inFlightFlush = null;
      // If another update was queued during flush, schedule next flush
      if (this.pendingText && !this.disposed) {
        this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      }
    });
  }

  private async updateMessage(text: string): Promise<void> {
    const res = await this.slackApi("chat.update", {
      channel: this.channel,
      ts: this.messageTs,
      text,
    });
    if (!res.ok && res.error === "ratelimited") {
      await sleep(2000);
      await this.slackApi("chat.update", {
        channel: this.channel,
        ts: this.messageTs,
        text,
      });
    }
  }

  private async slackApi(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; ts?: string; error?: string }> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as { ok: boolean; ts?: string; error?: string };
  }
}
