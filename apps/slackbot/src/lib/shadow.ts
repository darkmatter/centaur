/**
 * Shadow requests from #ai-agent (v1) to #ai-v2 (v2).
 *
 * When someone @mentions the v1 bot in #ai-agent, we replay the same
 * message through our v2 agent and post the result in #ai-v2 so we
 * can compare quality side-by-side.
 *
 * Also supports backtesting: fetch historical messages from #ai-agent
 * and replay them through the v2 agent.
 */

import { createClient, type RedisClientType } from "redis";
import { execute, type FileAttachment } from "./harness";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const THREAD_VIEWER_URL = process.env.THREAD_VIEWER_URL || "https://svc-ai.paradigm.xyz";
const REDIS_URL = process.env.REDIS_URL || "";

// v1 bot user ID (@ai in #ai-agent)
const V1_BOT_USER_ID = "U0AARS3FNEL";

// Channel IDs
const AI_AGENT_CHANNEL = "C0A82R7S80N"; // #ai-agent
const AI_V2_CHANNEL = "C0AJ07U8Z1N"; // #ai-v2

// Redis key prefix for shadow thread mappings
const SHADOW_MAP_PREFIX = "shadow_thread:";
const SHADOW_MAP_TTL = 60 * 60 * 24 * 7; // 7 days

// In-memory fallback when Redis is unavailable
const shadowThreadMapFallback = new Map<string, string>();

let _redis: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType | null> {
  if (!REDIS_URL) return null;
  if (_redis?.isOpen) return _redis;
  try {
    _redis = createClient({ url: REDIS_URL }) as RedisClientType;
    _redis.on("error", () => {});
    await _redis.connect();
    return _redis;
  } catch {
    _redis = null;
    return null;
  }
}

async function getShadowTs(parentTs: string): Promise<string | undefined> {
  const redis = await getRedis();
  if (redis) {
    const val = await redis.get(`${SHADOW_MAP_PREFIX}${parentTs}`);
    return val ?? undefined;
  }
  return shadowThreadMapFallback.get(parentTs);
}

async function setShadowTs(parentTs: string, shadowTs: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.set(`${SHADOW_MAP_PREFIX}${parentTs}`, shadowTs, { EX: SHADOW_MAP_TTL });
  }
  shadowThreadMapFallback.set(parentTs, shadowTs);
}

/**
 * Run a single shadow: post to #ai-v2, execute via v2 agent, post result.
 * Returns the shadow thread key, or null on failure.
 */
async function runShadow(
  cleanedText: string,
  originTs: string,
  files?: FileAttachment[],
  originThreadTs?: string,
): Promise<string | null> {
  // If this is a thread reply, reuse the existing shadow thread
  const parentTs = originThreadTs || originTs;
  const existingShadowTs = originThreadTs ? await getShadowTs(originThreadTs) : undefined;
  const shadowThreadKey = `shadow:${AI_AGENT_CHANNEL}:${parentTs}`;

  let shadowTs: string;

  if (existingShadowTs) {
    // Continue existing shadow thread — post follow-up quote
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: AI_V2_CHANNEL,
        thread_ts: existingShadowTs,
        text: `📝 *Follow-up* (<https://paradigm-ops.slack.com/archives/${AI_AGENT_CHANNEL}/p${originTs.replace(".", "")}|original>):\n>${cleanedText.split("\n").join("\n>")}`,
        unfurl_links: false,
      }),
    });
    shadowTs = existingShadowTs;
  } else {
    // New shadow thread
    const postRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: AI_V2_CHANNEL,
        text: `🔄 *Shadow* from <#${AI_AGENT_CHANNEL}> (<https://paradigm-ops.slack.com/archives/${AI_AGENT_CHANNEL}/p${parentTs.replace(".", "")}|original>):\n>${cleanedText.split("\n").join("\n>")}`,
        unfurl_links: false,
      }),
    });
    const postData = (await postRes.json()) as { ok: boolean; ts?: string };
    if (!postData.ok || !postData.ts) {
      console.log(JSON.stringify({ event: "shadow_post_failed", data: postData }));
      return null;
    }

    shadowTs = postData.ts;
    await setShadowTs(parentTs, shadowTs);

    // Post thread viewer link
    const viewerUrl = `${THREAD_VIEWER_URL}/threads/${encodeURIComponent(shadowThreadKey)}`;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: AI_V2_CHANNEL,
        thread_ts: shadowTs,
        text: `<${viewerUrl}|🔗 Thread Viewer>`,
        unfurl_links: false,
      }),
    });
  }

  // Run the message through the v2 agent (same thread key = same session)
  const result = await execute(shadowThreadKey, cleanedText, "amp", undefined, files);

  // Post the result as a thread reply in #ai-v2
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: AI_V2_CHANNEL,
      thread_ts: shadowTs,
      text: result,
      unfurl_links: false,
    }),
  });

  console.log(
    JSON.stringify({
      event: "shadow_complete",
      thread_key: shadowThreadKey,
      is_continuation: !!existingShadowTs,
      result_length: result.length,
    })
  );

  return shadowThreadKey;
}

/**
 * Check a raw Slack event payload and shadow v1 bot mentions
 * from #ai-agent into #ai-v2.
 */
export async function maybeShadow(body: Record<string, unknown>): Promise<void> {
  if (body.type !== "event_callback") return;

  const event = body.event as Record<string, unknown> | undefined;
  if (!event) return;

  // Only handle messages (not subtypes like bot_message, message_changed, etc.)
  if (event.type !== "message" && event.type !== "app_mention") return;
  if (event.subtype) return;
  if (event.bot_id) return;

  // Only from #ai-agent
  if (event.channel !== AI_AGENT_CHANNEL) return;

  const text = (event.text as string) || "";

  // Must mention the v1 bot
  if (!text.includes(`<@${V1_BOT_USER_ID}>`)) return;

  const ts = (event.ts as string) || "";
  const threadTs = (event.thread_ts as string) || undefined;

  // Strip the v1 bot mention to get the actual query
  const cleanedText = text.replace(new RegExp(`<@${V1_BOT_USER_ID}>`, "g"), "").trim();
  if (!cleanedText) return;

  // Extract file attachments
  const eventFiles = (event.files as Array<{ url_private?: string; name?: string }>) || [];
  const files: FileAttachment[] = eventFiles
    .filter((f): f is { url_private: string; name: string } => !!f.url_private && !!f.name)
    .map((f) => ({ url: f.url_private, name: f.name }));

  console.log(
    JSON.stringify({
      event: "shadow_detected",
      channel: AI_AGENT_CHANNEL,
      ts,
      thread_ts: threadTs,
      text_length: cleanedText.length,
      file_count: files.length,
    })
  );

  try {
    await runShadow(cleanedText, ts, files.length > 0 ? files : undefined, threadTs);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "shadow_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

type SlackMessage = {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  thread_ts?: string;
  files?: { url_private?: string; name?: string }[];
};

/**
 * Backtest: fetch historical messages from #ai-agent and replay
 * v1 bot mentions through the v2 agent sequentially.
 *
 * @param limit  Max number of messages to replay (default 10)
 * @param before Slack timestamp — only fetch messages older than this
 */
export async function backtest(
  limit: number = 10,
  before?: string,
): Promise<{ replayed: number; skipped: number; errors: number }> {
  // Fetch recent messages from #ai-agent (up to 200 to find enough v1 mentions)
  const params = new URLSearchParams({
    channel: AI_AGENT_CHANNEL,
    limit: "200",
  });
  if (before) params.set("latest", before);

  const res = await fetch(
    `https://slack.com/api/conversations.history?${params}`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
  );
  const data = (await res.json()) as { ok: boolean; messages?: SlackMessage[] };
  if (!data.ok || !data.messages) {
    throw new Error("Failed to fetch #ai-agent history");
  }

  let replayed = 0;
  let skipped = 0;
  let errors = 0;

  for (const msg of data.messages) {
    if (replayed >= limit) break;

    // Skip bot messages, subtypes, thread replies
    if (msg.bot_id || msg.subtype || msg.thread_ts) {
      skipped++;
      continue;
    }

    const text = msg.text || "";
    if (!text.includes(`<@${V1_BOT_USER_ID}>`)) {
      skipped++;
      continue;
    }

    const cleanedText = text.replace(new RegExp(`<@${V1_BOT_USER_ID}>`, "g"), "").trim();
    if (!cleanedText) {
      skipped++;
      continue;
    }

    const ts = msg.ts || "";
    const msgFiles: FileAttachment[] = (msg.files || [])
      .filter((f): f is { url_private: string; name: string } => !!f.url_private && !!f.name)
      .map((f) => ({ url: f.url_private, name: f.name }));

    console.log(
      JSON.stringify({
        event: "backtest_replaying",
        ts,
        text_preview: cleanedText.slice(0, 80),
        file_count: msgFiles.length,
        progress: `${replayed + 1}/${limit}`,
      })
    );

    try {
      await runShadow(cleanedText, ts, msgFiles.length > 0 ? msgFiles : undefined);
      replayed++;
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "backtest_error",
          ts,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      errors++;
    }
  }

  return { replayed, skipped, errors };
}
