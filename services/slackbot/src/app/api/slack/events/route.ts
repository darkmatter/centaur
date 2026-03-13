import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { verifySlackSignature } from "@/lib/bot/slack-client";
import { getBot, getSlackBootstrapState } from "@/lib/bot/bot";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

/**
 * Direct Slack webhook handler with built-in HMAC verification.
 *
 * This replaces the Python proxy path (src/api/app.py `proxy_webhooks`)
 * by performing HMAC verification in Next.js and delegating to the
 * existing Chat SDK bot for event processing.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-slack-signature") || "";
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const requestId = request.headers.get("x-slack-request-id") || "";
  const retryNum = request.headers.get("x-slack-retry-num") || "";

  // Parse body early to extract event type for logging
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (body.event as Record<string, unknown>)?.type ?? body.type ?? "unknown";
  log.info("webhook_received", { event_type: eventType, request_id: requestId, retry_num: retryNum });

  // HMAC verification (previously done by Python proxy)
  const { valid, reason } = verifySlackSignature(SIGNING_SECRET, signature, timestamp, rawBody);
  if (!valid) {
    log.error("slack_webhook_rejected", {
      reason,
      request_id: requestId,
      retry_num: retryNum,
      has_signature: Boolean(signature),
      has_timestamp: Boolean(timestamp),
    });
    return NextResponse.json({ error: "Invalid Slack signature" }, { status: 401 });
  }

  // Handle URL verification challenge directly
  if (body.type === "url_verification") {
    log.info("webhook_challenge", { request_id: requestId });
    return NextResponse.json({ challenge: body.challenge });
  }

  // Delegate to the Chat SDK bot (same path as the existing /api/webhooks/[platform] route)
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

  // Reconstruct a Request for the Chat SDK handler (it needs to re-read the body)
  const sdkRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: rawBody,
  });

  try {
    return await handler(sdkRequest, {
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
