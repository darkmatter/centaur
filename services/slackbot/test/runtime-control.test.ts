import { describe, expect, it, vi } from "vitest";

import type { StreamChunk } from "../src/lib/slack/types";

import { SlackBot, type BotMessage, type BotThread, type SlackAdapter } from "../src/lib/bot/bot";

function createThread(id = "slack:C123:1700000000.000100") {
  const postedMarkdown: string[] = [];
  const streamedChunks: StreamChunk[] = [];
  let postCount = 0;

  const thread: BotThread = {
    id,
    async subscribe() {},
    async startTyping() {},
    async post(content) {
      postCount += 1;
      if ("markdown" in content) {
        postedMarkdown.push(content.markdown);
      } else {
        for await (const chunk of content) {
          streamedChunks.push(chunk);
        }
      }
      return {
        id: `msg-${postedMarkdown.length + streamedChunks.length}`,
        async edit(c: { markdown: string }) {
          postedMarkdown.push(c.markdown);
        },
      };
    },
  };

  return {
    thread,
    postedMarkdown,
    streamedChunks,
    get postCount() {
      return postCount;
    },
  };
}

function streamText(chunks: StreamChunk[]): string {
  return chunks.map((chunk) => {
    if (chunk.type === "markdown_text") return chunk.text;
    if (chunk.type === "blocks") {
      return chunk.blocks
        .filter((block) => block.type === "markdown")
        .map((block) => typeof block.text === "string" ? block.text : "")
        .join("");
    }
    return "";
  }).join("");
}

function userMessage(text: string, opts?: { id?: string; teamId?: string; isMention?: boolean }): BotMessage {
  const ts = opts?.id || "1700000000.000100";
  return {
    id: ts,
    text,
    isMention: opts?.isMention,
    raw: {
      ts,
      team_id: opts?.teamId || "T123",
    },
    author: {
      isMe: false,
      isBot: false,
      userId: "U123",
    },
  };
}

function createImmediateStreamClient(): any {
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
    listExecutions: vi.fn(async (threadKey: string) => ({ thread_key: threadKey, executions: [] })),
    getExecution: vi.fn(async () => ({ status: "completed", result_text: "done" })),
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

describe("SlackBot runtime control", () => {
  const normalizedThreadKey = "C123:1700000000.000100";

  it("passes whole-thread history to the workflow and uses the current message ID as trigger", async () => {
    const client = createImmediateStreamClient();
    const slack = createSlackAdapter({
      fetchMessages: async () => ({
        messages: [
          userMessage("prior context", { id: "1700000000.000001" }) as any,
          userMessage("<@bot> please help", { id: "1700000000.000002" }) as any,
        ],
      }),
    });
    const bot = new SlackBot(client as any, "", slack);
    const { thread } = createThread();

    await bot.onNewMention(thread, userMessage("<@bot> please help", { id: "1700000000.000002" }));

    expect(client.message).not.toHaveBeenCalled();
    expect(client.startWorkflowRun).toHaveBeenCalledTimes(1);
    expect(client.startWorkflowRun.mock.calls[0][0].triggerKey).toBe(
      `slack-thread-turn:${normalizedThreadKey}:slack:1700000000.000002`,
    );
    expect(client.startWorkflowRun.mock.calls[0][0].input.history_messages).toEqual([
      {
        message_id: "slack:1700000000.000001",
        parts: [{ type: "text", text: "prior context" }],
        user_id: "U123",
        metadata: { platform: "slack", history_backfill: true },
      },
    ]);
  });

  it("excludes the current mention from workflow history by stable ID", async () => {
    const client = createImmediateStreamClient();
    const slack = createSlackAdapter({
      fetchMessages: async () => ({
        messages: [
          userMessage("<@bot> raw mention text", { id: "1700000000.000002" }) as any,
          userMessage("prior context", { id: "1700000000.000001" }) as any,
        ],
      }),
    });
    const bot = new SlackBot(client as any, "", slack);
    const { thread } = createThread();

    await bot.onNewMention(thread, userMessage("<@bot> cleaned mention text", { id: "1700000000.000002" }));

    expect(client.message).not.toHaveBeenCalled();
    expect(client.startWorkflowRun.mock.calls[0][0].input.message_id).toBe("slack:1700000000.000002");
    expect(client.startWorkflowRun.mock.calls[0][0].input.history_messages.map((m: any) => m.message_id)).toEqual([
      "slack:1700000000.000001",
    ]);
  });

  it("releases the active assignment before an explicit persona switch", async () => {
    const client = createImmediateStreamClient();
    const bot = new SlackBot(client as any, "", createSlackAdapter());
    const { thread } = createThread();

    await bot.onSubscribedMessage(thread, userMessage("<@bot> dont u have --invest", {
      id: "1700000000.000300",
      isMention: true,
    }));

    expect(client.releaseThread).toHaveBeenCalledWith(normalizedThreadKey, {
      releaseId: "prompt-switch:slack:1700000000.000300",
      cancelInflight: true,
    });
    expect(client.startWorkflowRun.mock.calls[0][0].input.prompt_selector).toBe("invest");
  });

  it("steers the previous execution with the new mention content", async () => {
    const client = createImmediateStreamClient();
    const bot = new SlackBot(client as any);
    const { thread } = createThread();
    const oldAbortController = new AbortController();

    (bot as any).inFlightExecutions.set(normalizedThreadKey, {
      executionId: "exe-old",
      abortController: oldAbortController,
    });

    await bot.onSubscribedMessage(thread, userMessage("follow-up", {
      id: "1700000000.000003",
      isMention: true,
    }));

    expect(oldAbortController.signal.aborted).toBe(false);
    expect(client.steerExecution).toHaveBeenCalledWith("exe-old", {
      contentBlocks: [{ type: "text", text: "follow-up" }],
      messageId: "slack:1700000000.000003",
      userId: "U123",
      metadata: { platform: "slack", team_id: "T123" },
    });
    expect(client.cancelExecution).not.toHaveBeenCalled();
    expect(client.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not start a duplicate workflow when steering falls back to cancellation", async () => {
    const client = createImmediateStreamClient();
    client.steerExecution = vi.fn(async () => ({ ok: true, status: "cancel_requested" }));
    const bot = new SlackBot(client as any);
    const { thread } = createThread();
    const oldAbortController = new AbortController();

    (bot as any).inFlightExecutions.set(normalizedThreadKey, {
      executionId: "exe-old",
      abortController: oldAbortController,
    });

    await bot.onSubscribedMessage(thread, userMessage("<@bot> stop", {
      id: "1700000000.000006",
      isMention: true,
    }));

    expect(oldAbortController.signal.aborted).toBe(true);
    expect(client.cancelExecution).toHaveBeenCalledWith("exe-old");
    expect(client.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("excludes Slack messages newer than the current mention from workflow history", async () => {
    const client = createImmediateStreamClient();
    const slack = createSlackAdapter({
      fetchMessages: async () => ({
        messages: [
          userMessage("<@bot> current ask", { id: "1700000000.000100" }) as any,
          userMessage("<@bot> stop", { id: "1700000004.000100" }) as any,
          userMessage("prior context", { id: "1699999999.000100" }) as any,
        ],
      }),
    });
    const bot = new SlackBot(client as any, "", slack);
    const { thread } = createThread();

    await bot.onNewMention(thread, userMessage("<@bot> current ask", { id: "1700000000.000100" }));

    expect(client.startWorkflowRun.mock.calls[0][0].input.history_messages.map((m: any) => m.message_id)).toEqual([
      "slack:1699999999.000100",
    ]);
  });

  it("does not leave a blank streamed message behind when an execution is interrupted before text", async () => {
    let nextExecution = 1;
    const client = {
      spawn: vi.fn(async () => ({ assignment_generation: 7 })),
      message: vi.fn(async () => ({ ok: true, attachment_ids: [] })),
      startWorkflowRun: vi.fn(async () => ({ execution_id: `exe-${nextExecution++}`, status: "waiting" })),
      execute: vi.fn(async () => ({ execution_id: `exe-${nextExecution++}` })),
      streamEvents: vi.fn(({ executionId, signal }: { executionId: string; signal?: AbortSignal }) => {
        if (executionId === "exe-1") {
          return (async function* () {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        }

        return (async function* () {
          yield {
            eventId: 1,
            eventKind: "amp_raw_event",
            data: {
              type: "turn.done",
              result: "done",
            },
          };
        })();
      }),
      cancelExecution: vi.fn(async () => ({ ok: true })),
      markFinalDelivered: vi.fn(async () => ({ ok: true })),
      markFinalFailed: vi.fn(async () => ({ ok: true })),
      claimFinalDeliveries: vi.fn(async () => ({ deliveries: [] })),
      getExecution: vi.fn(async () => ({ status: "completed", result_text: "done" })),
    };
    const bot = new SlackBot(client as any);
    const runtime = createThread();
    const { thread, streamedChunks } = runtime;

    const firstTurn = bot.onSubscribedMessage(thread, userMessage("first", {
      id: "1700000000.000003",
      isMention: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await bot.onSubscribedMessage(thread, userMessage("second", {
      id: "1700000000.000004",
      isMention: true,
    }));
    await firstTurn;

    expect(client.cancelExecution).toHaveBeenCalledWith("exe-1");
    expect(runtime.postCount).toBe(0);
    expect(client.startWorkflowRun).toHaveBeenCalledTimes(1);
    expect(streamText(streamedChunks).trim()).toBe("");
  });

  it("acks live streamed deliveries without requiring an outbox lease", async () => {
    const client = createImmediateStreamClient();
    const bot = new SlackBot(client as any);
    const { thread } = createThread();

    await bot.onSubscribedMessage(thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-new", undefined);
  });

  it("uses the stored terminal result when the event stream reconnects after completion", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      // API reconnect edge-case: no unseen events remain, so consumeExecutionEvents
      // has to fall back to the durable execution row.
    })());
    client.getExecution = vi.fn(async () => ({ status: "completed", result_text: "stored answer" }));

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    expect(client.getExecution).toHaveBeenCalledWith("exe-new");
    expect(streamText(runtime.streamedChunks)).toContain("stored answer");
  });

  it("logs expected Slack streaming fallbacks at info level", async () => {
    const client = createImmediateStreamClient();
    client.getExecution = vi.fn(async () => ({ status: "running" }));
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const thread: BotThread = {
      id: "slack:C123:1700000000.000100",
      async subscribe() {},
      async startTyping() {},
      async post(content) {
        if ("markdown" in content) return { id: "fallback", async edit() {} };
        throw new Error("message_not_in_streaming_state");
      },
    };

    const bot = new SlackBot(client as any);
    try {
      await bot.onSubscribedMessage(thread, userMessage("follow-up", {
        id: "1700000000.000004",
        isMention: true,
      }));
    } finally {
      // assertions below inspect captured writes before restoring stdout.
    }

    const writes = stdoutSpy.mock.calls.map(([chunk]) => String(chunk));
    stdoutSpy.mockRestore();
    expect(writes.some((line) => line.includes('"event":"slack_stream_fallback"')
      && line.includes('"level":"info"'))).toBe(true);
    expect(writes.some((line) => line.includes('"event":"slack_stream_fallback"')
      && line.includes('"level":"warn"'))).toBe(false);
  });

  it("suppresses the pre-start failure message when a live execution hits a Slack fallback error", async () => {
    const client = createImmediateStreamClient();
    client.getExecution = vi.fn(async () => ({ status: "running" }));

    const post = vi.fn(async (content: AsyncGenerator<StreamChunk> | { markdown: string }) => {
      if ("markdown" in content) {
        throw new Error("fallback-post-failed");
      }
      throw new Error("message_not_in_streaming_state");
    });

    const thread: BotThread = {
      id: "slack:C123:1700000000.000100",
      async subscribe() {},
      async startTyping() {},
      async post(content) {
        return post(content);
      },
    };

    const bot = new SlackBot(client as any);

    await bot.onSubscribedMessage(thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    const markdownCalls = post.mock.calls
      .map(([content]) => content)
      .filter((content): content is { markdown: string } => "markdown" in content)
      .map((content) => content.markdown);
    expect(markdownCalls).not.toContain("Agent request failed before execution started. Please retry.");
  });

  it("retries without triggerKey on 409 idempotency mismatch", async () => {
    let callCount = 0;
    const client = createImmediateStreamClient();
    client.startWorkflowRun = vi.fn(async (opts: any) => {
      callCount += 1;
      if (callCount === 1) {
        const err: any = new Error("Request failed with status code 409");
        err.response = { status: 409, data: { code: "IDEMPOTENCY_PAYLOAD_MISMATCH" } };
        throw err;
      }
      return { execution_id: "exe-retry", status: "waiting" };
    });

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000005",
      isMention: true,
    }));

    expect(client.startWorkflowRun).toHaveBeenCalledTimes(2);
    // First call has triggerKey, retry does not
    expect(client.startWorkflowRun.mock.calls[0][0].triggerKey).toBeDefined();
    expect(client.startWorkflowRun.mock.calls[1][0].triggerKey).toBeUndefined();
    expect(runtime.postedMarkdown).not.toContain("Agent request failed before execution started. Please retry.");
  });

  it("maps failed-permanent hydration to a friendly retry message", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      // Force hydration from the durable execution row.
    })());
    client.getExecution = vi.fn(async () => ({
      status: "failed_permanent",
      terminal_reason: "harness_error",
      error_text: "Connection error.",
    }));

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    expect(streamText(runtime.streamedChunks)).toContain("Agent hit a runtime issue before finishing. Please retry.");
    expect(streamText(runtime.streamedChunks)).not.toContain("Connection error.");
  });

  it("does not treat successful turn text that mentions connection errors as a runtime failure", async () => {
    const result = "Root cause: a database connection error caused stale pool retries.";
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      yield {
        eventId: 1,
        eventKind: "amp_raw_event",
        data: {
          type: "turn.done",
          result,
        },
      };
    })());
    const postMessage = vi.fn(async () => ({ id: "alert-msg" }));
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack, "C_ERROR_CHANNEL");
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    const rendered = streamText(runtime.streamedChunks);
    expect(rendered).toContain(result);
    expect(rendered).not.toContain("Agent hit a runtime issue before finishing. Please retry.");
    expect(postMessage).not.toHaveBeenCalledWith("slack:C_ERROR_CHANNEL", expect.anything());
  });

  it("renders provider harness errors in a Slack code block", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      yield {
        eventId: 1,
        eventKind: "amp_raw_event",
        data: {
          type: "turn.done",
          result: "Model Provider Overloaded Try again in a few seconds.",
          is_error: true,
          error: "Model Provider Overloaded Try again in a few seconds.",
        },
      };
    })());

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    const rendered = streamText(runtime.streamedChunks);
    expect(rendered).toContain("Agent hit a runtime issue before finishing. Please retry.");
    expect(rendered).toContain("```text\nModel Provider Overloaded Try again in a few seconds.\n```");
  });

  it("uses result text as sanitized detail for error events without an error field", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      yield {
        eventId: 1,
        eventKind: "amp_raw_event",
        data: {
          type: "turn.done",
          result: "Provider failed with Authorization: Bearer sk-test at /home/agent/workspace/secret.txt",
          is_error: true,
        },
      };
    })());

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    const rendered = streamText(runtime.streamedChunks);
    expect(rendered).toContain("Agent hit a runtime issue before finishing. Please retry.");
    expect(rendered).toContain("Authorization=[redacted]");
    expect(rendered).toContain("[redacted path]");
    expect(rendered).not.toContain("sk-test");
    expect(rendered).not.toContain("/home/agent/workspace/secret.txt");
  });

  it("maps cancelled hydration to a friendly cancellation message", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      // Force hydration from the durable execution row.
    })());
    client.getExecution = vi.fn(async () => ({
      status: "cancelled",
      terminal_reason: "cancel_requested",
      error_text: "cancel_requested",
    }));

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    expect(streamText(runtime.streamedChunks)).toContain("Request cancelled. Send another message when you want to retry.");
    expect(streamText(runtime.streamedChunks)).not.toContain("cancel_requested");
  });

  it("rewrites streamed file links to GitHub blob URLs before posting to Slack", async () => {
    const client = createImmediateStreamClient();
    client.streamEvents = vi.fn(() => (async function* () {
      yield {
        eventId: 1,
        eventKind: "amp_raw_event",
        data: {
          type: "turn.done",
          result: "See [bot.ts](file:///home/agent/workspace/services/slackbot/src/lib/bot/bot.ts#L1-L5)",
          repo_owner: "paradigmxyz",
          repo_name: "centaur",
          git_commit: "490cd7aed56fb93efd52e4fa3dd06874d762d88a",
          git_ref: "centaur/github-permalinks",
        },
      };
    })());

    const bot = new SlackBot(client as any);
    const runtime = createThread();

    await bot.onSubscribedMessage(runtime.thread, userMessage("follow-up", {
      id: "1700000000.000004",
      isMention: true,
    }));

    const streamedOutput = JSON.stringify(runtime.streamedChunks);
    expect(streamedOutput).toContain(
      "https://github.com/paradigmxyz/centaur/blob/490cd7aed56fb93efd52e4fa3dd06874d762d88a/services/slackbot/src/lib/bot/bot.ts#L1-L5",
    );
    expect(streamedOutput).not.toContain("file:///home/agent/workspace/");
  });

  it("claims only Slack final deliveries and posts completed results once", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-completed",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: { status: "completed", result_text: "final answer" },
        },
        {
          execution_id: "exe-cancelled",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: { status: "cancelled", terminal_reason: "cancel_requested" },
        },
      ],
    }));
    client.listExecutions = vi.fn(async () => ({
      thread_key: normalizedThreadKey,
      executions: [
        { execution_id: "exe-completed", status: "completed" },
        { execution_id: "exe-cancelled", status: "cancelled" },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(client.claimFinalDeliveries).toHaveBeenCalledWith(expect.objectContaining({ platform: "slack" }));
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      { markdown: "final answer" },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-completed", expect.any(String));
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-cancelled", expect.any(String));
  });

  it("adds Amp and commit footer to completed final deliveries", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-completed",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "completed",
            result_text: "final answer",
            agent_thread_id: "T-final-thread",
            repo_context: {
              git_commit: "490cd7aed56fb93efd52e4fa3dd06874d762d88a",
            },
          },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      {
        markdown: [
          "final answer",
          "",
          "[View in Amp](https://ampcode.com/threads/T-final-thread) · `amp threads continue T-final-thread` · `490cd7ae`",
        ].join("\n"),
      },
    );
  });

  it("uses explicit Slack delivery destination for workflow final deliveries", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-workflow",
          thread_key: "workflow:wfr_123:notify",
          delivery: {
            platform: "slack",
            channel: "C999",
            thread_ts: "1700000000.999999",
          },
          final_payload: { status: "completed", result_text: "workflow result" },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).toHaveBeenCalledWith(
      "slack:C999:1700000000.999999",
      { markdown: "workflow result" },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-workflow", expect.any(String));
  });

  it("rewrites final-delivery file links before posting to Slack", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-file-link",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "completed",
            result_text: "See [bot.ts](file:///home/agent/workspace/services/slackbot/src/lib/bot/bot.ts#L1-L5)",
            repo_context: {
              repo_owner: "paradigmxyz",
              repo_name: "centaur",
              git_commit: "490cd7aed56fb93efd52e4fa3dd06874d762d88a",
              git_ref: "centaur/github-permalinks",
            },
          },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      {
        markdown: [
          "See [bot.ts](https://github.com/paradigmxyz/centaur/blob/490cd7aed56fb93efd52e4fa3dd06874d762d88a/services/slackbot/src/lib/bot/bot.ts#L1-L5)",
          "",
          "`490cd7ae`",
        ].join("\n"),
      },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-file-link", expect.any(String));
  });

  it("posts a friendly cancellation message for the latest cancelled final delivery", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-cancelled",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: { status: "cancelled", terminal_reason: "cancel_requested", error_text: "cancel_requested" },
        },
      ],
    }));
    client.listExecutions = vi.fn(async () => ({
      thread_key: normalizedThreadKey,
      executions: [
        { execution_id: "exe-cancelled", status: "cancelled" },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      { markdown: "Request cancelled. Send another message when you want to retry." },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-cancelled", expect.any(String));
  });

  it("defers outbox delivery while the same execution is still streaming locally", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-live",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: { status: "completed", result_text: "should wait" },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    (bot as any).inFlightExecutions.set(normalizedThreadKey, {
      executionId: "exe-live",
      abortController: new AbortController(),
    });

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(client.markFinalFailed).not.toHaveBeenCalled();
    expect(client.markFinalDelivered).not.toHaveBeenCalled();
    expect(client.renewFinalDeliveryLease).toHaveBeenCalledWith(
      "exe-live",
      expect.objectContaining({
        consumerId: expect.any(String),
        leaseSeconds: 90,
      }),
    );
  });

  it("dead-letters workflow deliveries that use channel names", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-workflow-channel-name",
          thread_key: "workflow:wfr_123",
          delivery: { platform: "slack", channel: "paradigm-pulse" },
          final_payload: { status: "completed", result_text: "done" },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(client.markFinalDelivered).not.toHaveBeenCalled();
    expect(client.markFinalFailed).toHaveBeenCalledWith(
      "exe-workflow-channel-name",
      expect.stringContaining("must use a Slack channel id"),
      expect.objectContaining({
        nonRetryable: true,
        errorClass: "invalid_destination",
      }),
    );
  });

  it("dead-letters workflow deliveries missing thread_ts", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-workflow-no-thread-ts",
          thread_key: "workflow:wfr_123",
          delivery: { platform: "slack", channel: "C123456" },
          final_payload: { status: "completed", result_text: "done" },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(client.markFinalFailed).toHaveBeenCalledWith(
      "exe-workflow-no-thread-ts",
      expect.stringContaining("missing delivery.thread_ts"),
      expect.objectContaining({
        nonRetryable: true,
        errorClass: "invalid_destination",
      }),
    );
  });

  it("allows workflow deliveries with explicit channel id and thread_ts", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-workflow-valid-destination",
          thread_key: "workflow:wfr_123",
          delivery: { platform: "slack", channel: "C123456", thread_ts: "1700000000.000100" },
          final_payload: { status: "completed", result_text: "done" },
        },
      ],
    }));
    const postMessage = vi.fn(async () => ({ id: "msg-final" }));
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(postMessage).toHaveBeenCalledWith(
      "slack:C123456:1700000000.000100",
      { markdown: "done" },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith(
      "exe-workflow-valid-destination",
      expect.any(String),
    );
  });

  it("retries final delivery with flattened tables when Slack rejects blocks", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-table",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "completed",
            result_text: [
              "Summary",
              "",
              "| Asset | Value |",
              "| --- | --- |",
              "| BTC | $1.00M |",
            ].join("\n"),
          },
        },
      ],
    }));
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid_blocks"))
      .mockResolvedValue({ id: "msg-safe" });
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][1]).toEqual({
      markdown: [
        "Summary",
        "",
        "- Asset: BTC; Value: $1.00M",
      ].join("\n"),
    });
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-table", expect.any(String));
    expect(client.markFinalFailed).not.toHaveBeenCalled();
  });

  it("maps silence-deadline final delivery to a friendly retry message", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-silent",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "failed_permanent",
            terminal_reason: "silence_deadline_exceeded",
            error_text: "execution made no progress before silence deadline",
          },
        },
      ],
    }));
    const slack = createSlackAdapter({
      postMessage: vi.fn(async () => ({ id: "msg-final" })),
    });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    expect(slack.postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      { markdown: "Agent stopped after making no visible progress. Please retry." },
    );
    expect(slack.postMessage).not.toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      { markdown: "execution made no progress before silence deadline" },
    );
    expect(client.markFinalDelivered).toHaveBeenCalledWith("exe-silent", expect.any(String));
  });

  it("posts runtime error alert to the configured error channel with detail in thread", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-err",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "failed_permanent",
            terminal_reason: "harness_error",
            error_text: "sandbox crashed with OOM",
            result_text: "",
          },
        },
      ],
    }));
    const postMessage = vi.fn(async () => ({ id: "alert-msg-ts" }));
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack, "C_ERROR_CHANNEL");

    await (bot as any).drainFinalDeliveriesOnce();

    // Should have posted to the original thread + alert channel summary + alert channel detail
    expect(postMessage).toHaveBeenCalledWith(
      "slack:C_ERROR_CHANNEL",
      expect.objectContaining({
        markdown: expect.stringContaining("Agent hit a runtime issue"),
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      "slack:C_ERROR_CHANNEL:alert-msg-ts",
      expect.objectContaining({
        markdown: expect.stringContaining("harness_error"),
      }),
    );
  });

  it("does not post to error channel for completed final deliveries that mention connection errors", async () => {
    const client = createImmediateStreamClient();
    const result = "The root cause was a connection error in the database pool.";
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-ok",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "completed",
            result_text: result,
          },
        },
      ],
    }));
    const postMessage = vi.fn(async () => ({ id: "msg-ok" }));
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack, "C_ERROR_CHANNEL");

    await (bot as any).drainFinalDeliveriesOnce();

    // Should post to the original thread only, not the error channel
    expect(postMessage).toHaveBeenCalledWith(
      `slack:${normalizedThreadKey}`,
      { markdown: expect.stringContaining(result) },
    );
    const errorChannelCalls = postMessage.mock.calls.filter(
      (call: any) => typeof call[0] === "string" && call[0].includes("C_ERROR_CHANNEL"),
    );
    expect(errorChannelCalls).toHaveLength(0);
  });

  it("does not post to error channel when no channel is configured", async () => {
    const client = createImmediateStreamClient();
    client.claimFinalDeliveries = vi.fn(async () => ({
      deliveries: [
        {
          execution_id: "exe-err-no-channel",
          thread_key: normalizedThreadKey,
          delivery: { platform: "slack" },
          final_payload: {
            status: "failed_permanent",
            terminal_reason: "harness_error",
            error_text: "oops",
          },
        },
      ],
    }));
    const postMessage = vi.fn(async () => ({ id: "msg-1" }));
    const slack = createSlackAdapter({ postMessage });
    const bot = new SlackBot(client as any, "", slack);

    await (bot as any).drainFinalDeliveriesOnce();

    // Should only post the error to the original thread, not an alert channel
    const allCalls = postMessage.mock.calls.map((c: any) => c[0]);
    expect(allCalls.every((id: string) => id.includes(normalizedThreadKey))).toBe(true);
  });
});
