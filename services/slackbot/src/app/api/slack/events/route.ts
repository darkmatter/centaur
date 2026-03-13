import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { getBot, getSlackBootstrapState } from "@/lib/bot/setup";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * Slack webhook handler — delegates to the Chat SDK's Slack adapter
 * which handles HMAC verification, url_verification challenges, and event dispatch.
 */
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-slack-request-id") || "";
  const retryNum = request.headers.get("x-slack-retry-num") || "";

  log.info("webhook_received", { request_id: requestId, retry_num: retryNum });

  const bot = getBot();
  const handler = bot.webhooks.slack;
  if (!handler) {
    const bootstrap = getSlackBootstrapState();
    log.error("slack_webhook_unavailable", {
      request_id: requestId,
      retry_num: retryNum,
      missing_env_keys: bootstrap.missingEnvKeys,
    });
    return NextResponse.json(
      { error: "slack webhook unavailable", missing_env_keys: bootstrap.missingEnvKeys },
      { status: 503 },
    );
  }

  log.info("webhook_dispatched", { request_id: requestId, retry_num: retryNum });

  try {
    return await handler(request, {
      waitUntil: (task) => after(() => task),
    });
  } catch (error) {
    log.error("slack_events_handler_failed", {
      request_id: requestId,
      retry_num: retryNum,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
