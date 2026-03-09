import { after } from "next/server";
import { getBot, getSlackBootstrapState } from "@/lib/bot/bot";

export async function POST(
  request: Request,
  context: { params: Promise<{ platform: string }> }
) {
  const bot = getBot();
  const { platform } = await context.params;

  type Platform = keyof typeof bot.webhooks;
  const handler = bot.webhooks[platform as Platform];
  if (!handler) {
    if (platform === "slack") {
      const bootstrap = getSlackBootstrapState();
      const requestId = request.headers.get("x-slack-request-id") ?? "";
      const retryNum = request.headers.get("x-slack-retry-num") ?? "";
      console.error(
        "slack_webhook_unavailable",
        JSON.stringify({
          platform,
          request_id: requestId,
          retry_num: retryNum,
          missing_env_keys: bootstrap.missingEnvKeys,
        })
      );
      return Response.json(
        {
          error: "slack webhook unavailable",
          missing_env_keys: bootstrap.missingEnvKeys,
        },
        { status: 503 }
      );
    }
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }



  try {
    return await handler(request, {
      waitUntil: (task) => after(() => task),
    });
  } catch (error) {
    console.error(
      "webhook_handler_failed",
      JSON.stringify({
        platform,
        request_id: request.headers.get("x-slack-request-id") ?? "",
        retry_num: request.headers.get("x-slack-retry-num") ?? "",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return new Response("webhook handler failed", { status: 500 });
  }
}
