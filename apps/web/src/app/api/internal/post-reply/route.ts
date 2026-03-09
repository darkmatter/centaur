import { postMarkdownToSlack, postRichReplyToSlack } from "@/lib/bot/slack-post";
import type { SlackReplyMetadata } from "@/lib/bot/slack-blocks";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const API_KEY = process.env.AI_V2_API_KEY || process.env.API_SECRET_KEY || "";

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization") || "";
  if (!API_KEY || !auth.startsWith("Bearer ") || auth.slice(7) !== API_KEY) {
    return unauthorized();
  }

  const body = await request.json().catch(() => ({}));
  const channel = String(body.channel ?? "").trim();
  const threadTs = String(body.thread_ts ?? "").trim();
  const markdown = String(body.markdown ?? "");
  const rich = body.rich === true;
  const metadata = (body.metadata ?? {}) as SlackReplyMetadata;
  if (!channel || !threadTs || !markdown.trim()) {
    return Response.json(
      { error: "Missing channel, thread_ts, or markdown" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    if (rich) {
      await postRichReplyToSlack(channel, markdown, threadTs, metadata);
    } else {
      await postMarkdownToSlack(channel, markdown, threadTs);
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to post Slack reply" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
