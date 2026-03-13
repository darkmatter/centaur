/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Eagerly initializes the Chat SDK so the Slack adapter is ready
 * before any webhooks arrive. Without this, the first webhook after
 * a deploy can hit the slackbot before the SDK is initialized,
 * returning 404/503 and losing the message.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getBot } = await import("@/lib/bot/setup");
    getBot();
  }
}
