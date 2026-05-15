import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { SlackBot, type BotMessage, type BotThread, type SlackAdapter } from "../src/lib/bot/bot";
import { BoltSlackApp } from "../src/lib/slack/app";

const SIGNING_SECRET = "unit-test-signing-secret";

function signedSlackRequest(payload: Record<string, unknown>): NextRequest {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new NextRequest("http://test.local/api/slack/events", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  });
}

function createRoutingHarness() {
  const app = new BoltSlackApp("xoxb-unit-test", SIGNING_SECRET) as any;
  const adapter = {
    getBotUserId: vi.fn(() => "UBOT"),
    startTyping: vi.fn(async () => {}),
    stopTyping: vi.fn(async () => {}),
    toBotMessage: vi.fn(async (_threadId: string, event: any): Promise<BotMessage> => ({
      id: event.ts,
      text: event.text || "",
      raw: {
        ts: event.ts,
        team_id: event.team_id || event.team,
        team: event.team,
      },
      author: {
        isMe: event.user === "UBOT" || event.bot_id === "UBOT",
        isBot: Boolean(event.bot_id),
        userId: event.user || "",
      },
      attachments: [],
    })),
  };
  const bot = {
    client: {
      getMessages: vi.fn(async () => ({ messages: [] })),
    },
    waitForInFlightExecution: vi.fn(async () => false),
    onNewMention: vi.fn(async () => {}),
    onSubscribedMessage: vi.fn(async () => {}),
  };

  app.adapter = adapter;
  app.bot = bot;
  return { app, adapter, bot };
}

function slackEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    ts: "1700000000.000100",
    user: "U123",
    text: "<@UBOT> help",
    ...overrides,
  };
}

function createThread(id = "slack:C123:1700000000.000100") {
  const posted: unknown[] = [];
  return {
    thread: {
      id,
      subscribe: vi.fn(async () => {}),
      startTyping: vi.fn(async () => {}),
      stopTyping: vi.fn(async () => {}),
      post: vi.fn(async (content: any) => {
        posted.push(content);
        if (Symbol.asyncIterator in Object(content)) {
          for await (const chunk of content) posted.push(chunk);
        }
        return {
          id: "slack-reply-1",
          edit: vi.fn(async () => {}),
        };
      }),
    } satisfies BotThread,
    posted,
  };
}

function userMessage(text: string, opts?: Partial<BotMessage>): BotMessage {
  return {
    id: "1700000000.000100",
    text,
    raw: {
      ts: "1700000000.000100",
      team_id: "T123",
    },
    author: {
      isMe: false,
      isBot: false,
      userId: "U123",
    },
    ...opts,
  };
}

function createImmediateStreamClient() {
  return {
    spawn: vi.fn(async () => ({ assignment_generation: 7 })),
    message: vi.fn(async () => ({ ok: true, attachment_ids: [] })),
    startWorkflowRun: vi.fn(async () => ({ execution_id: "exe-new", status: "waiting" })),
    execute: vi.fn(async () => ({ execution_id: "exe-new" })),
    releaseThread: vi.fn(async () => ({ ok: true, released: true })),
    streamEvents: vi.fn(() => (async function* () {
      yield {
        eventId: 1,
        eventKind: "amp_raw_event",
        data: {
          type: "turn.done",
          result: "done",
        },
      };
    })()),
    steerExecution: vi.fn(async () => ({ ok: true, status: "steered" })),
    cancelExecution: vi.fn(async () => ({ ok: true })),
    markFinalDelivered: vi.fn(async () => ({ ok: true })),
    markFinalFailed: vi.fn(async () => ({ ok: true })),
    renewFinalDeliveryLease: vi.fn(async () => ({ ok: true })),
    claimFinalDeliveries: vi.fn(async () => ({ deliveries: [] })),
    listExecutions: vi.fn(async (threadKey: string) => ({
      thread_key: threadKey,
      executions: [],
    })),
    getExecution: vi.fn(async () => ({ status: "completed", result_text: "done" })),
    http: {
      get: vi.fn(async () => ({
        data: {
          eng: {},
          invest: {},
        },
      })),
    },
  };
}

function createSlackAdapter(overrides?: Partial<SlackAdapter>): SlackAdapter {
  return {
    fetchMessage: async () => null,
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "msg-1" }),
    setAssistantTitle: async () => {},
    getInstallation: async () => null,
    withBotToken: async (_token, fn) => await fn(),
    ...overrides,
  };
}

describe("Slack event routing and dedup", () => {
  it("deduplicates repeated Slack event_id values at the webhook boundary", async () => {
    const app = new BoltSlackApp("xoxb-unit-test", SIGNING_SECRET) as any;
    const dispatchWithRetry = vi.fn(async () => {});
    app.dispatchWithRetry = dispatchWithRetry;
    const payload = {
      type: "event_callback",
      event_id: "Ev-repeat",
      team_id: "T123",
      event: slackEvent(),
    };

    const first = await app.handleRequest(signedSlackRequest(payload));
    const second = await app.handleRequest(signedSlackRequest(payload));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(dispatchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("deduplicates app_mention and message deliveries for the same Slack message", async () => {
    const { app, bot } = createRoutingHarness();

    await app.routeSlackEvent(slackEvent({ type: "app_mention" }), "T123");
    await app.routeSlackEvent(slackEvent({ type: "message" }), "T123");

    expect(bot.onNewMention).toHaveBeenCalledTimes(1);
    expect(bot.onSubscribedMessage).not.toHaveBeenCalled();
  });

  it("does not let ignored file_share deliveries suppress a later app_mention", async () => {
    const { app, bot } = createRoutingHarness();
    const files = [{ id: "F123", mimetype: "image/png", url_private: "https://files.slack.test/F123" }];

    await app.routeSlackEvent(
      slackEvent({
        type: "message",
        subtype: "file_share",
        text: "",
        files,
      }),
      "T123",
    );
    await app.routeSlackEvent(
      slackEvent({
        type: "app_mention",
        text: "<@UBOT> what are these?",
        files,
      }),
      "T123",
    );

    expect(bot.onNewMention).toHaveBeenCalledTimes(1);
    expect(bot.onSubscribedMessage).not.toHaveBeenCalled();
  });

  it("treats direct messages without explicit bot mentions as mentions", async () => {
    const { app, adapter, bot } = createRoutingHarness();

    await app.routeSlackEvent(
      slackEvent({
        channel: "D123",
        channel_type: "im",
        ts: "1700000000.000200",
        text: "can you help with this",
      }),
      "T123",
    );

    expect(adapter.startTyping).toHaveBeenCalledWith("slack:D123:1700000000.000200");
    expect(bot.onNewMention).toHaveBeenCalledTimes(1);
    const routedMessage = ((bot.onNewMention as any).mock.calls[0]?.[1]) as
      | BotMessage
      | undefined;
    expect(routedMessage?.isMention).toBe(true);
  });

  it("ignores self messages, bot messages, and ignored subtypes", async () => {
    const { app, bot } = createRoutingHarness();

    await app.routeSlackEvent(slackEvent({ user: "UBOT" }), "T123");
    await app.routeSlackEvent(slackEvent({ ts: "1700000000.000101", bot_id: "B123" }), "T123");
    await app.routeSlackEvent(slackEvent({ ts: "1700000000.000102", subtype: "message_changed" }), "T123");

    expect(bot.onNewMention).not.toHaveBeenCalled();
    expect(bot.onSubscribedMessage).not.toHaveBeenCalled();
  });
});

describe("SlackBot attachment refetch", () => {
  it("refetches files through the real onNewMention path before starting the workflow", async () => {
    const client = createImmediateStreamClient();
    const fetchData = vi.fn(async () => Buffer.from("pdf-bytes"));
    const slack = createSlackAdapter({
      fetchMessage: vi.fn(async () => ({
        attachments: [
          {
            name: "memo.pdf",
            mimeType: "application/pdf",
            fetchData,
          },
        ],
      })),
    });
    const bot = new SlackBot(client as any, "", slack);
    const { thread } = createThread();

    await bot.onNewMention(thread, userMessage("please inspect the file", { attachments: [] }));

    expect(slack.fetchMessage).toHaveBeenCalledWith(thread.id, "1700000000.000100");
    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(client.startWorkflowRun).toHaveBeenCalledTimes(1);
    const workflowRequest = (client.startWorkflowRun as any).mock.calls[0]?.[0] as any;
    expect(workflowRequest.input.parts).toEqual([
      { type: "text", text: "please inspect the file" },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from("pdf-bytes").toString("base64"),
        },
      },
    ]);
  });
});
