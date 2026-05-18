import { describe, expect, it, vi } from "vitest";

import {
  SlackBot,
  type BotMessage,
  type BotThread,
  type PostPayload,
  type SlackAdapter,
} from "../../services/slackbot/src/lib/bot/bot";
import type { StreamChunk, StreamOverflowMetadata } from "../../services/slackbot/src/lib/slack/types";
import { createE2EContext } from "../src/harness/scenario";

function slackTs(): string {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const micros = String(now % 1000).padStart(3, "0")
    + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${seconds}.${micros}`;
}

function extractStreamText(chunks: unknown[]): string {
  return chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
}

function createOverflowThread(threadId: string) {
  const edit = vi.fn(async () => {});
  const streamedChunks: unknown[] = [];
  const plainPosts: PostPayload[] = [];

  const thread: BotThread = {
    id: threadId,
    subscribe: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    post: async (
      content: AsyncGenerator<StreamChunk> | PostPayload,
    ): Promise<{ id: string; edit(content: { markdown: string }): Promise<void> } & StreamOverflowMetadata> => {
      if ("markdown" in content) {
        plainPosts.push(content);
        return { id: `plain-${plainPosts.length}`, edit };
      }

      for await (const chunk of content) {
        streamedChunks.push(chunk);
      }

      const overflowChars = extractStreamText(streamedChunks).length;
      return {
        id: "1778704967.119909",
        streamMessageTs: "1778704967.119909",
        overflowFollowupsPosted: true,
        overflowReason: "slack_rejected",
        overflowFollowupCount: 1,
        overflowChars,
        edit,
      };
    },
  };

  return {
    thread,
    edit,
    plainPosts,
    streamedChunks,
  };
}

describe("slackbot overflow duplicate rendering", () => {
  it("does not edit the original stream after a live Amp turn reports overflow follow-ups", async () => {
    const ctx = await createE2EContext();
    const alertPosts: Array<{ threadId: string; message: PostPayload }> = [];
    const slack: SlackAdapter = {
      fetchMessage: async () => null,
      fetchMessages: async () => ({ messages: [] }),
      setAssistantTitle: async () => {},
      postMessage: async (threadId, message) => {
        alertPosts.push({ threadId, message });
        return { id: `alert-${alertPosts.length}` };
      },
    };
    const bot = new SlackBot(ctx.client, "", slack, "C-e2e-alerts");
    const nonce = `CENTAUR_OVERFLOW_DUP_${Date.now()}`;
    const threadTs = slackTs();
    const harness = createOverflowThread(`slack:C-e2e:${threadTs}`);
    const msg: BotMessage = {
      id: threadTs,
      text: `Reply with exactly ${nonce} and nothing else.`,
      author: {
        isMe: false,
        isBot: false,
        userId: "U-e2e",
      },
      raw: {
        ts: threadTs,
        team: "T-e2e",
      },
    };

    await bot.onNewMention(harness.thread, msg);

    expect(extractStreamText(harness.streamedChunks)).toContain(nonce);
    expect(harness.edit).not.toHaveBeenCalled();
    expect(harness.plainPosts).toHaveLength(0);
    expect(alertPosts).toHaveLength(0);

    console.log(JSON.stringify(ctx.metrics.summary({
      scenario: "slackbot-overflow-duplicate",
      threadKey: "C-e2e:" + threadTs,
      finalStreamTextChars: extractStreamText(harness.streamedChunks).length,
      streamChunkCount: harness.streamedChunks.length,
      finalEditCalls: harness.edit.mock.calls.length,
      alertPosts: alertPosts.length,
    }), null, 2));
  });
});
