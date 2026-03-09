import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
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

  // HMAC verification (previously done by Python proxy)
  const { valid, reason } = verifySlackSignature(SIGNING_SECRET, signature, timestamp, rawBody);
  if (!valid) {
    console.error(
      "slack_webhook_rejected",
      JSON.stringify({
        reason,
        request_id: requestId,
        retry_num: retryNum,
        has_signature: Boolean(signature),
        has_timestamp: Boolean(timestamp),
      }),
    );
    return NextResponse.json({ error: "Invalid Slack signature" }, { status: 401 });
  }

  // Handle URL verification challenge directly
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Delegate to the Chat SDK bot (same path as the existing /api/webhooks/[platform] route)
  const bot = getBot();
  const handler = bot.webhooks.slack;
  if (!handler) {
    const bootstrap = getSlackBootstrapState();
    console.error(
      "slack_webhook_unavailable",
      JSON.stringify({
        request_id: requestId,
        retry_num: retryNum,
        missing_env_keys: bootstrap.missingEnvKeys,
      }),
    );
    return NextResponse.json(
      { error: "slack webhook unavailable", missing_env_keys: bootstrap.missingEnvKeys },
      { status: 503 },
    );
  }

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
    console.error(
      "slack_events_handler_failed",
      JSON.stringify({
        request_id: requestId,
        retry_num: retryNum,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
