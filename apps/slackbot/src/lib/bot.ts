/**
 * Chat SDK bot — Slack adapter with Redis state.
 *
 * On @mention:
 *   1. spawn() → ensures a Docker container exists for this thread
 *   2. execute() → runs the message through the harness CLI
 *   3. thread.post() → posts the result back to Slack
 */

import { Chat, parseMarkdown, type Root } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMemoryState } from "@chat-adapter/state-memory";
import { extractHarness, spawn, execute } from "./harness";

type MarkdownNode = Root | Root["children"][number];

function renderSlackMessage(markdown: string) {
  const ast = parseMarkdown(markdown);
  const escapeLiteralTildes = (
    node: MarkdownNode,
    inDelete = false
  ): void => {
    const insideDelete = inDelete || node.type === "delete";

    if (node.type === "text" && !insideDelete) {
      // Slack treats paired single tildes as strikethrough; escape literal tildes.
      node.value = node.value.replace(/~/g, "\\~");
    }

    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as Root["children"]) {
        escapeLiteralTildes(child, insideDelete);
      }
    }
  };

  escapeLiteralTildes(ast);

  return { ast };
}

function createBot() {
  const hasSlackCreds =
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET;

  const bot = new Chat({
    userName: "tempo-ai",
    adapters: hasSlackCreds ? { slack: createSlackAdapter() } : {},
    state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
  });

  function buildSessionContext(threadId: string): string {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    return [
      "# Session Context",
      "",
      `- **Date/Time**: ${now} UTC`,
      `- **Thread ID**: ${threadId}`,
      "",
      "---",
      "",
    ].join("\n");
  }

  async function handleMessage(
    thread: Parameters<Parameters<typeof bot.onNewMention>[0]>[0],
    messageText: string,
    isFirstMessage: boolean
  ) {
    const { harness, cleanedText } = extractHarness(messageText);
    const threadKey = thread.id;

    await thread.startTyping("Spawning agent...");

    // Ensure container exists for this thread
    await spawn(threadKey, harness);

    await thread.startTyping("Running...");

    // Prepend session context on first message
    const message = isFirstMessage
      ? buildSessionContext(threadKey) + cleanedText
      : cleanedText;

    // Execute message and get final result
    const result = await execute(threadKey, message);

    await thread.post(renderSlackMessage(result));
  }

  // First @mention — subscribe and run
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await handleMessage(thread, message.text, true);
  });

  // Follow-up messages in subscribed threads
  bot.onSubscribedMessage(async (thread, message) => {
    if (!message.isMention) return;
    await handleMessage(thread, message.text, false);
  });

  return bot;
}

let _bot: ReturnType<typeof createBot> | null = null;
export function getBot() {
  if (!_bot) _bot = createBot();
  return _bot;
}
