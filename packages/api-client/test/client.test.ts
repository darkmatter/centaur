import { afterEach, describe, expect, it, vi } from "vitest";

import { CentaurClient, type ChatStreamChunk, type StreamEvent } from "../src/client";

async function collectEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function collectChunks(events: AsyncIterable<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const collected: ChatStreamChunk[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sseResponse(body: string, init?: ResponseInit): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      ...init,
    },
  );
}

describe("CentaurClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses SSE ids, events, JSON data, [DONE], and invalid JSON payloads", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "id: 11",
      "event: harness_raw_event",
      'data: {"type":"assistant","message":{"content":"hello"}}',
      "",
      "id: 12",
      "event: done",
      "data: [DONE]",
      "",
      "id: 13",
      "data: not-json",
      "",
      "",
    ].join("\n")));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });

    await expect(collectEvents(client.streamEvents({ threadKey: "thread-1" }))).resolves.toEqual([
      {
        eventId: 11,
        eventKind: "harness_raw_event",
        data: { type: "assistant", message: { content: "hello" } },
      },
      {
        eventId: 13,
        eventKind: "message",
        data: { type: "unknown", raw: "not-json" },
      },
    ]);
  });

  it("URL encodes Slack thread keys in event stream URLs", async () => {
    const fetchMock = vi.fn(async () => sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });

    await collectEvents(client.streamEvents({
      threadKey: "slack:C123:1700000000.000100",
      executionId: "exe-1",
      afterEventId: 42,
      pollMs: 250,
    }));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.local/agent/threads/slack%3AC123%3A1700000000.000100/events?after_event_id=42&execution_id=exe-1&poll_ms=250",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer test-key",
          "X-Centaur-Thread-Key": "slack:C123:1700000000.000100",
        },
      }),
    );
  });

  it("streams Chat SDK chunks directly from the execution chat stream endpoint", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "id: 21",
      "event: chat_stream_chunk",
      'data: {"type":"task_update","id":"tool-1","title":"Command execution","status":"in_progress","details":"```sh\\nprintf ready\\n```"}',
      "",
      "id: 22",
      "event: chat_stream_chunk",
      'data: {"type":"markdown_text","text":"Done"}',
      "",
      "",
    ].join("\n")));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });

    await expect(collectChunks(client.streamChatChunks({
      executionId: "exe:123",
      afterEventId: 20,
      pollMs: 100,
    }))).resolves.toEqual([
      {
        type: "task_update",
        id: "tool-1",
        title: "Command execution",
        status: "in_progress",
        details: "```sh\nprintf ready\n```",
      },
      { type: "markdown_text", text: "Done" },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.local/agent/executions/exe%3A123/chat-stream?after_event_id=20&poll_ms=100",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer test-key" },
      }),
    );
  });

  it("fetches Chat SDK stream context without exposing Centaur delivery shape", async () => {
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });
    const getMock = vi.spyOn(client.http, "get").mockResolvedValue({
      data: {
        execution_id: "exe:123",
        thread_key: "slack:T123:C123:1780000000.123456",
        platform: "slack",
        thread_id: "slack:C123:1780000000.123456",
        stream_options: {
          recipientUserId: "U123",
          recipientTeamId: "T123",
          taskDisplayMode: "plan",
          stopBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Done" } }],
        },
      },
    });

    await expect(client.getChatStreamContext("exe:123")).resolves.toEqual({
      execution_id: "exe:123",
      thread_key: "slack:T123:C123:1780000000.123456",
      platform: "slack",
      thread_id: "slack:C123:1780000000.123456",
      stream_options: {
        recipientUserId: "U123",
        recipientTeamId: "T123",
        taskDisplayMode: "plan",
        stopBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Done" } }],
      },
    });
    expect(getMock).toHaveBeenCalledWith(
      "/agent/executions/exe%3A123/chat-stream/context",
    );
  });

  it("URL encodes Slack thread keys in path-based API calls", async () => {
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });
    const getMock = vi.spyOn(client.http, "get").mockResolvedValue({
      data: { thread_key: "slack:C123:1700000000.000100", executions: [] },
    });
    const postMock = vi.spyOn(client.http, "post").mockResolvedValue({ data: { ok: true } });

    await client.listExecutions("slack:C123:1700000000.000100", 2);
    await client.releaseThread("slack:C123:1700000000.000100", {
      releaseId: "release:1",
      cancelInflight: true,
    });

    expect(getMock).toHaveBeenCalledWith(
      "/agent/threads/slack%3AC123%3A1700000000.000100/executions",
      { params: { limit: 2 } },
    );
    expect(postMock).toHaveBeenCalledWith(
      "/agent/threads/slack%3AC123%3A1700000000.000100/release",
      {
        release_id: "release:1",
        cancel_inflight: true,
      },
    );
  });

  it("throws useful errors for non-OK event stream responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "upstream unavailable",
      { status: 503, statusText: "Service Unavailable" },
    )));
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });

    await expect(
      collectEvents(client.streamEvents({ threadKey: "slack:C123:1700000000.000100" })),
    ).rejects.toThrow(
      "/agent/threads/{thread}/events failed (503): upstream unavailable",
    );
  });

  it("posts the expected steerExecution payload", async () => {
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });
    const postMock = vi.spyOn(client.http, "post").mockResolvedValue({ data: { ok: true } });

    await client.steerExecution("exe:123", {
      contentBlocks: [{ type: "text", text: "replacement" }],
      messageId: "slack:1700000000.000200",
      userId: "U123",
      metadata: { platform: "slack" },
      suppressCancellationDelivery: true,
    });

    expect(postMock).toHaveBeenCalledWith(
      "/agent/executions/exe%3A123/steer",
      {
        content_blocks: [{ type: "text", text: "replacement" }],
        message_id: "slack:1700000000.000200",
        user_id: "U123",
        metadata: {
          platform: "slack",
          steer_replacement: true,
        },
      },
    );
  });

  it("posts the expected final-delivery payloads", async () => {
    const client = new CentaurClient({
      apiUrl: "http://api.local",
      apiKey: "test-key",
    });
    const postMock = vi.spyOn(client.http, "post").mockResolvedValue({ data: { ok: true, deliveries: [] } });

    await client.claimFinalDeliveries({
      consumerId: "slackbot-1",
      limit: 3,
      leaseSeconds: 120,
      platform: "slack",
    });
    await client.renewFinalDeliveryLease("exe:123", {
      consumerId: "slackbot-1",
      leaseSeconds: 90,
    });
    await client.markFinalDelivered("exe:123", "slackbot-1");
    await client.markFinalFailed("exe:123", "rate limited", {
      consumerId: "slackbot-1",
      retryAfterSeconds: 45,
      nonRetryable: true,
      errorClass: "slack_rate_limit",
    });

    expect(postMock).toHaveBeenNthCalledWith(
      1,
      "/agent/final-deliveries/claim",
      {
        consumer_id: "slackbot-1",
        limit: 3,
        lease_seconds: 120,
        platform: "slack",
      },
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      "/agent/final-deliveries/exe%3A123/heartbeat",
      {
        consumer_id: "slackbot-1",
        lease_seconds: 90,
      },
    );
    expect(postMock).toHaveBeenNthCalledWith(
      3,
      "/agent/final-deliveries/exe%3A123/delivered",
      { consumer_id: "slackbot-1" },
    );
    expect(postMock).toHaveBeenNthCalledWith(
      4,
      "/agent/final-deliveries/exe%3A123/failed",
      {
        consumer_id: "slackbot-1",
        error: "rate limited",
        retry_after_seconds: 45,
        non_retryable: true,
        error_class: "slack_rate_limit",
      },
    );
  });
});
