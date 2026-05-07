import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { ProgressTracker } from "../src/lib/bot/progress-tracker";
import {
  splitSlackMessage,
  parsePromptSelectorFlag,
  extractFlagSelector,
  bareFlagGreeting,
  rewriteSlackFileLinks,
} from "../src/lib/bot/bot";
import { normalizeHarnessEvent, type CanonicalEvent } from "@centaur/harness-events";
import { CentaurClient } from "@centaur/api-client";
import { log } from "../src/lib/logger";
import { SlackApiCallError } from "../src/lib/slack/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function finalMessage(t: ProgressTracker): string {
  return (t.resultText || t.lastAssistantText).trim();
}

// Mirror of the content block resolution logic in bot.ts — kept in sync.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

async function resolveAttachmentBlocks(
  attachments: Array<{ url?: string; name?: string; mimeType?: string; fetchData?: () => Promise<Buffer> }>,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const att of attachments) {
    if (!att.fetchData || !att.mimeType) continue;
    try {
      const data = await att.fetchData();
      const b64 = data.toString("base64");
      if (att.mimeType.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: att.mimeType, data: b64 },
        });
      } else {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: att.mimeType, data: b64 },
        });
      }
    } catch {
      // skip failed fetches
    }
  }
  return blocks;
}

function parseSSEFile(filePath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const payload = trimmed.slice(6);
    try {
      events.push(JSON.parse(payload));
    } catch {
      // skip
    }
  }
  return events;
}

function replayFixture(name: string) {
  const filePath = path.join(
    __dirname,
    "../src/lib/bot/fixtures",
    `${name}.sse`,
  );
  const rawEvents = parseSSEFile(filePath);
  const tracker = new ProgressTracker();
  const allCanonical: CanonicalEvent[] = [];
  const allChunks: unknown[] = [];
  let turnDoneResult = "";

  for (const raw of rawEvents) {
    if (raw.type === "turn.done") {
      turnDoneResult = typeof raw.result === "string" ? raw.result : "";
    }
    const canonical = normalizeHarnessEvent("amp", raw);
    for (const ce of canonical) {
      allCanonical.push(ce);
      allChunks.push(...tracker.update(ce));
    }
  }

  return { tracker, allCanonical, allChunks, rawEvents, turnDoneResult };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Attachment annotations
// ═══════════════════════════════════════════════════════════════════════════════

describe("attachment content blocks", () => {
  it("image mimeType → image content block", async () => {
    const blocks = await resolveAttachmentBlocks([
      {
        name: "screenshot.png",
        mimeType: "image/png",
        fetchData: async () => Buffer.from("fake-png-data"),
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect((blocks[0] as any).source.media_type).toBe("image/png");
    expect((blocks[0] as any).source.data).toBe(Buffer.from("fake-png-data").toString("base64"));
  });

  it("non-image mimeType → document content block", async () => {
    const blocks = await resolveAttachmentBlocks([
      {
        name: "report.pdf",
        mimeType: "application/pdf",
        fetchData: async () => Buffer.from("fake-pdf-data"),
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("document");
    expect((blocks[0] as any).source.media_type).toBe("application/pdf");
  });

  it("skips attachments without fetchData", async () => {
    const blocks = await resolveAttachmentBlocks([
      { url: "https://files.slack.com/a", name: "data.csv", mimeType: "text/csv" },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("skips attachments without mimeType", async () => {
    const blocks = await resolveAttachmentBlocks([
      { name: "mystery", fetchData: async () => Buffer.from("data") },
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("mixed image and document attachments", async () => {
    const blocks = await resolveAttachmentBlocks([
      { name: "photo.jpg", mimeType: "image/jpeg", fetchData: async () => Buffer.from("jpg") },
      { name: "doc.xlsx", mimeType: "application/vnd.ms-excel", fetchData: async () => Buffer.from("xlsx") },
      { name: "chart.gif", mimeType: "image/gif", fetchData: async () => Buffer.from("gif") },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("document");
    expect(blocks[2].type).toBe("image");
  });

  it("returns empty array for empty input", async () => {
    const blocks = await resolveAttachmentBlocks([]);
    expect(blocks).toHaveLength(0);
  });

  it("skips attachments where fetchData throws", async () => {
    const blocks = await resolveAttachmentBlocks([
      {
        name: "broken.pdf",
        mimeType: "application/pdf",
        fetchData: async () => { throw new Error("network error"); },
      },
      {
        name: "good.png",
        mimeType: "image/png",
        fetchData: async () => Buffer.from("png-data"),
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
  });

  it("image/svg+xml counts as image", async () => {
    const blocks = await resolveAttachmentBlocks([
      { name: "logo.svg", mimeType: "image/svg+xml", fetchData: async () => Buffer.from("svg") },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
  });

  it("video and audio are documents, not images", async () => {
    const blocks = await resolveAttachmentBlocks([
      { name: "clip.mp4", mimeType: "video/mp4", fetchData: async () => Buffer.from("mp4") },
      { name: "voice.ogg", mimeType: "audio/ogg", fetchData: async () => Buffer.from("ogg") },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("document");
    expect(blocks[1].type).toBe("document");
  });

  it("content blocks include correct base64 source structure", async () => {
    const blocks = await resolveAttachmentBlocks([
      {
        name: "test.pdf",
        mimeType: "application/pdf",
        fetchData: async () => Buffer.from("hello world"),
      },
    ]);
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as { type: "document"; source: { type: string; media_type: string; data: string } };
    expect(block.source.type).toBe("base64");
    expect(block.source.media_type).toBe("application/pdf");
    expect(block.source.data).toBe(Buffer.from("hello world").toString("base64"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ProgressTracker
// ═══════════════════════════════════════════════════════════════════════════════

describe("ProgressTracker", () => {
  it("captures text-only assistant message as finalMessage", () => {
    const t = new ProgressTracker();
    [...t.update({
      type: "assistant",
      message: { content: [{ type: "text", text: "Here is your answer." }] },
    })];
    expect(finalMessage(t)).toBe("Here is your answer.");
  });

  it("last text event wins", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "First." }] } })];
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "Second." }] } })];
    expect(finalMessage(t)).toBe("Second.");
  });

  it("clears preamble when tool_use starts (separate events)", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "Let me look..." }] } })];
    [...t.update({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }] },
    })];
    expect(finalMessage(t)).toBe("");
  });

  it("clears preamble when tool_use starts (same event)", () => {
    const t = new ProgressTracker();
    [...t.update({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me search..." },
          { type: "tool_use", id: "t1", name: "finder", input: { query: "auth" } },
        ],
      },
    })];
    expect(finalMessage(t)).toBe("");
  });

  it("captures final text after tool completes", () => {
    const t = new ProgressTracker();
    [...t.update({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }] },
    })];
    [...t.update({ type: "tool", content: [{ tool_use_id: "t1", content: "data", is_error: false }] })];
    [...t.update({
      type: "assistant",
      message: { content: [{ type: "text", text: "Done fixing the bug." }] },
    })];
    expect(finalMessage(t)).toBe("Done fixing the bug.");
  });

  it("result event takes priority over lastAssistantText", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "Intermediate." }] } })];
    [...t.update({ type: "result", text: "Final from turn.done" })];
    expect(finalMessage(t)).toBe("Final from turn.done");
  });

  it("stream death after tool_use → empty finalMessage", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "Let me check..." }] } })];
    [...t.update({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    })];
    expect(finalMessage(t)).toBe("");
  });

  it("error event produces markdown_text chunk", () => {
    const t = new ProgressTracker();
    const chunks = [...t.update({ type: "error", error: "OOM killed" })];
    expect(chunks.some((c) => c.type === "markdown_text" && "text" in c && (c as any).text.includes("OOM"))).toBe(true);
  });

  it("reasoning event does not affect lastAssistantText", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "reasoning", text: "Thinking hard..." })];
    expect(finalMessage(t)).toBe("");
  });

  it("each tool gets its own unique task ID (no sliding window)", () => {
    const t = new ProgressTracker();
    const starts: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const chunks = [...t.update({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { cmd: `echo ${i}` } }] },
      })];
      starts.push(...chunks.filter((c) => c.type === "task_update"));
      [...t.update({ type: "tool", content: [{ tool_use_id: `t${i}`, content: "ok", is_error: false }] })];
    }
    const ids = (starts as any[]).map((c) => c.id);
    expect(ids).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("10 tools produce 10 unique task IDs — Slack plan block handles display", () => {
    const t = new ProgressTracker();
    const allChunks: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      allChunks.push(...t.update({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { path: `/f${i}` } }] },
      }));
      allChunks.push(...t.update({ type: "tool", content: [{ tool_use_id: `t${i}`, content: "ok", is_error: false }] }));
    }
    const ids = new Set(
      (allChunks as any[])
        .filter((c) => c.type === "task_update")
        .map((c) => c.id),
    );
    expect(ids).toEqual(new Set(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]));
  });

  it("subagent events produce task_update chunks", () => {
    const t = new ProgressTracker();
    const chunks = [...t.update({ type: "subagent", status: "started", subagent_id: "sa-1", name: "Research" })];
    expect(chunks.some((c) => c.type === "task_update" && (c as any).status === "in_progress")).toBe(true);
    expect(t.lastAssistantText).toBe("");
  });

  it("addHandoff clears state and produces task_update", () => {
    const t = new ProgressTracker();
    [...t.update({ type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } })];
    const chunks = [...t.addHandoff("Continue research")];
    expect(t.lastAssistantText).toBe("");
    expect(t.resultText).toBe("");
    expect(chunks.some((c) => c.type === "task_update" && (c as any).title.includes("Continue research"))).toBe(true);
  });
});



// ═══════════════════════════════════════════════════════════════════════════════
// 3. SSE fixture replay
// ═══════════════════════════════════════════════════════════════════════════════

const fixtureDir = path.join(__dirname, "../src/lib/bot/fixtures");
const fixtureFiles = fs.readdirSync(fixtureDir).filter((f) => f.endsWith(".sse"));

describe("SSE fixture replay", () => {
  for (const file of fixtureFiles) {
    const name = file.replace(".sse", "");

    describe(name, () => {
      const { tracker, allCanonical, allChunks, rawEvents, turnDoneResult } =
        replayFixture(name);
      const fm = finalMessage(tracker);

      it("parses raw SSE events", () => {
        expect(rawEvents.length).toBeGreaterThan(0);
      });

      it("produces canonical events", () => {
        expect(allCanonical.length).toBeGreaterThan(0);
      });

      const toolUseEvents = allCanonical.filter(
        (e) =>
          e.type === "assistant" &&
          e.message?.content.some((b: { type: string }) => b.type === "tool_use"),
      );

      if (toolUseEvents.length > 0) {
        it("tool_use events produce task_update chunks", () => {
          const taskUpdates = (allChunks as any[]).filter(
            (c) => c.type === "task_update" && c.id !== "init",
          );
          expect(taskUpdates.length).toBeGreaterThan(0);
        });
      }

      if (turnDoneResult) {
        it("finalMessage matches turn.done result", () => {
          expect(fm).toBe(turnDoneResult);
        });

        it("no dangling active tools at end", () => {
          const activeTools = (tracker as any).activeTools as Map<string, unknown>;
          expect(activeTools.size).toBe(0);
        });
      }

      if (name !== "handoff" && turnDoneResult) {
        it("finalMessage is non-empty", () => {
          expect(fm.length).toBeGreaterThan(0);
        });
      }

      if (toolUseEvents.length > 0 && fm) {
        it("finalMessage is NOT preamble text", () => {
          let firstTextBeforeTool = "";
          let seenToolUse = false;
          for (const ce of allCanonical) {
            if (ce.type === "assistant" && ce.message?.content) {
              for (const block of ce.message.content) {
                if (block.type === "text" && block.text && !seenToolUse) {
                  firstTextBeforeTool = block.text;
                }
                if (block.type === "tool_use") {
                  seenToolUse = true;
                }
              }
            }
          }
          if (firstTextBeforeTool && firstTextBeforeTool !== turnDoneResult) {
            expect(fm).not.toBe(firstTextBeforeTool);
          }
        });
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Simulated stream deaths
// ═══════════════════════════════════════════════════════════════════════════════

describe("simulated stream deaths", () => {
  for (const file of fixtureFiles) {
    const name = file.replace(".sse", "");
    const filePath = path.join(fixtureDir, file);
    const rawEvents = parseSSEFile(filePath);

    // Find first event index that contains tool_use
    let firstToolUseIdx = -1;
    for (let i = 0; i < rawEvents.length; i++) {
      const canonical = normalizeHarnessEvent("amp", rawEvents[i]);
      for (const ce of canonical) {
        if (
          ce.type === "assistant" &&
          ce.message?.content.some((b: { type: string }) => b.type === "tool_use")
        ) {
          firstToolUseIdx = i;
          break;
        }
      }
      if (firstToolUseIdx >= 0) break;
    }

    if (firstToolUseIdx < 0) continue;

    it(`${name}: EOF after first tool_use → empty finalMessage`, () => {
      const tracker = new ProgressTracker();
      for (let i = 0; i <= firstToolUseIdx; i++) {
        const canonical = normalizeHarnessEvent("amp", rawEvents[i]);
        for (const ce of canonical) {
          [...tracker.update(ce)];
        }
      }
      expect(finalMessage(tracker)).toBe("");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. execute streaming bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

describe("execute streams structured progress immediately", () => {
  it("starts the Slack stream on the first task chunk, not the first text chunk", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ execution_id: "exe-structured-first" }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    const streamedChunks = [
      { type: "task_update", id: "read-1", title: "Read - /tmp/input.txt", status: "in_progress" },
      { type: "plan_update", title: "Read - /tmp/input.txt" },
      { type: "markdown_text", text: "Final answer." },
    ];

    vi.spyOn(bot as any, "streamExecution").mockImplementation(async function* () {
      for (const chunk of streamedChunks) {
        yield chunk;
      }
    });
    vi.spyOn(bot as any, "ackFinalDelivery").mockResolvedValue(undefined);
    vi.spyOn(bot as any, "setAssistantTitle").mockResolvedValue(undefined);

    const postedChunks: unknown[] = [];
    const thread = {
      id: "C123456:1770000000.000100",
      post: vi.fn(async (content: AsyncIterable<unknown>) => {
        for await (const chunk of content) {
          postedChunks.push(chunk);
        }
        return { id: "m-1", edit: async () => {} };
      }),
    };

    await (bot as any).execute(thread, thread.id, {
      assignmentGeneration: 7,
      userId: "U123456",
      teamId: "T123456",
    });

    expect(mockClient.execute).toHaveBeenCalledOnce();
    expect(thread.post).toHaveBeenCalledOnce();
    expect(thread.post).toHaveBeenCalledWith(expect.anything(), { taskDisplayMode: "plan" });
    expect(postedChunks).toEqual(streamedChunks);
  });

  it("upgrades streamed table replies through edit() after the stream completes", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ execution_id: "exe-stream-table-upgrade" }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    vi.spyOn(bot as any, "streamExecution").mockImplementation((async function* (
      _threadKey: string,
      _executionId: string,
      tracker: { lastAssistantText: string },
    ) {
      tracker.lastAssistantText = [
        "Summary",
        "",
        "| Time | Block |",
        "| --- | --- |",
        "| 8:00 | Breakfast |",
      ].join("\n");
      yield { type: "markdown_text", text: "\u200b" };
      yield {
        type: "blocks",
        blocks: [
          { type: "markdown", text: "Summary" },
          {
            type: "table",
            rows: [
              [
                { type: "raw_text", text: "Time" },
                { type: "raw_text", text: "Block" },
              ],
              [
                { type: "raw_text", text: "8:00" },
                { type: "raw_text", text: "Breakfast" },
              ],
            ],
          },
        ],
      };
    }) as any);
    vi.spyOn(bot as any, "ackFinalDelivery").mockResolvedValue(undefined);
    vi.spyOn(bot as any, "setAssistantTitle").mockResolvedValue(undefined);

    const edit = vi.fn(async () => {});
    const thread = {
      id: "C123456:1770000000.000200",
      post: vi.fn(async () => ({ id: "m-2", edit })),
    };

    await (bot as any).execute(thread, thread.id, {
      assignmentGeneration: 8,
      userId: "U123456",
      teamId: "T123456",
    });

    expect(thread.post).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith({
      markdown: [
        "Summary",
        "",
        "| Time | Block |",
        "| --- | --- |",
        "| 8:00 | Breakfast |",
      ].join("\n"),
    });
  });

  it.each([
    "user_not_found",
    "restricted_action_thread_locked",
    "no_permission",
  ])("falls back to plain Slack posts when streaming rejects %s", async (errorCode) => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ execution_id: `exe-fallback-${errorCode}` }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    vi.spyOn(bot as any, "streamExecution").mockImplementation((async function* (
      _threadKey: string,
      _executionId: string,
      tracker: { resultText: string },
    ) {
      tracker.resultText = "Final answer from fallback";
      yield { type: "markdown_text", text: "Working..." };
    }) as any);
    const ackSpy = vi.spyOn(bot as any, "ackFinalDelivery").mockResolvedValue(undefined);

    const plainPosts: Array<{ markdown: string }> = [];
    const thread = {
      id: "C123456:1770000000.000300",
      post: vi.fn(async (content: AsyncIterable<unknown> | { markdown: string }) => {
        if (typeof (content as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          throw new SlackApiCallError("chat.startStream", errorCode, { ok: false, error: errorCode });
        }
        plainPosts.push(content as { markdown: string });
        return { id: "m-fallback", edit: async () => {} };
      }),
    };

    await (bot as any).execute(thread, thread.id, {
      assignmentGeneration: 9,
      userId: "U123456",
      teamId: "T123456",
    });

    expect(thread.post).toHaveBeenCalledTimes(2);
    expect(plainPosts).toEqual([{ markdown: "Final answer from fallback" }]);
    expect(ackSpy).toHaveBeenCalledWith(`exe-fallback-${errorCode}`, thread.id, { requireLease: false });
  });

  it.each([
    "user_not_found",
    "restricted_action_thread_locked",
  ])("does not ack final delivery when fallback post fails after %s stream rejection", async (errorCode) => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ execution_id: `exe-fallback-post-fails-${errorCode}` }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    vi.spyOn(bot as any, "streamExecution").mockImplementation((async function* (
      _threadKey: string,
      _executionId: string,
      tracker: { resultText: string },
    ) {
      tracker.resultText = "Final answer that never reaches Slack";
      yield { type: "markdown_text", text: "Working..." };
    }) as any);
    const ackSpy = vi.spyOn(bot as any, "ackFinalDelivery").mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const plainPosts: Array<{ markdown: string }> = [];
    const thread = {
      id: "C123456:1770000000.000500",
      post: vi.fn(async (content: AsyncIterable<unknown> | { markdown: string }) => {
        if (typeof (content as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          throw new SlackApiCallError("chat.startStream", errorCode, { ok: false, error: errorCode });
        }
        plainPosts.push(content as { markdown: string });
        throw new SlackApiCallError("chat.postMessage", "channel_not_found", { ok: false, error: "channel_not_found" });
      }),
    };

    await (bot as any).execute(thread, thread.id, {
      assignmentGeneration: 10,
      userId: "U123456",
      teamId: "T123456",
    });

    expect(thread.post).toHaveBeenCalledTimes(2);
    expect(plainPosts).toEqual([{ markdown: "Final answer that never reaches Slack" }]);
    expect(ackSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("slack_stream_fallback_post_failed", expect.objectContaining({
      error_class: "invalid_destination",
      error_code: "channel_not_found",
      execution_id: `exe-fallback-post-fails-${errorCode}`,
    }));

    warnSpy.mockRestore();
  });

  it("leaves multi-chunk fallback unacked when a later fallback post fails", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ execution_id: "exe-fallback-later-chunk-fails" }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    const longFallback = Array.from({ length: 55 }, (_unused, index) => `Paragraph ${index}`).join("\n\n");
    vi.spyOn(bot as any, "streamExecution").mockImplementation((async function* (
      _threadKey: string,
      _executionId: string,
      tracker: { resultText: string },
    ) {
      tracker.resultText = longFallback;
      yield { type: "markdown_text", text: "Working..." };
    }) as any);
    const ackSpy = vi.spyOn(bot as any, "ackFinalDelivery").mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const deliveredPlainPosts: Array<{ markdown: string }> = [];
    const attemptedPlainPosts: Array<{ markdown: string }> = [];
    const thread = {
      id: "C123456:1770000000.000600",
      post: vi.fn(async (content: AsyncIterable<unknown> | { markdown: string }) => {
        if (typeof (content as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
          throw new SlackApiCallError("chat.startStream", "restricted_action_thread_locked", {
            ok: false,
            error: "restricted_action_thread_locked",
          });
        }
        const payload = content as { markdown: string };
        attemptedPlainPosts.push(payload);
        if (attemptedPlainPosts.length === 2) {
          throw new SlackApiCallError("chat.postMessage", "channel_not_found", { ok: false, error: "channel_not_found" });
        }
        deliveredPlainPosts.push(payload);
        return { id: `m-fallback-${attemptedPlainPosts.length}`, edit: async () => {} };
      }),
    };

    await (bot as any).execute(thread, thread.id, {
      assignmentGeneration: 11,
      userId: "U123456",
      teamId: "T123456",
    });

    expect(thread.post).toHaveBeenCalledTimes(3);
    expect(attemptedPlainPosts).toHaveLength(2);
    expect(deliveredPlainPosts).toHaveLength(1);
    expect(attemptedPlainPosts[0].markdown).toContain("Paragraph 0");
    expect(attemptedPlainPosts[1].markdown).toContain("Paragraph 50");
    expect(ackSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("slack_stream_fallback_post_failed", expect.objectContaining({
      error_class: "invalid_destination",
      error_code: "channel_not_found",
      execution_id: "exe-fallback-later-chunk-fails",
    }));

    warnSpy.mockRestore();
  });

  it("skips assistant title warnings for restricted destinations", async () => {
    const { SlackBot } = await import("../src/lib/bot/bot");
    const slack = {
      setAssistantTitle: vi.fn().mockRejectedValue(new SlackApiCallError(
        "assistant.threads.setTitle",
        "restricted_action_thread_locked",
        { ok: false, error: "restricted_action_thread_locked" },
      )),
    };
    const bot = new SlackBot({} as any, "", slack as any);
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    await (bot as any).setAssistantTitle("C123456:1770000000.000400", {}, "Final answer from fallback");
    await (bot as any).setAssistantTitle("C123456:1770000000.000400", {}, "Final answer from fallback again");

    expect(slack.setAssistantTitle).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith("set_title_skipped", expect.objectContaining({
      error_class: "restricted_destination",
      error_code: "restricted_action_thread_locked",
      retryable: false,
    }));
    expect(warnSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. consumeWire reconnect on graceful EOF (API restart mid-turn)
// ═══════════════════════════════════════════════════════════════════════════════

describe("consumeWire reconnects on graceful EOF without turn.done", () => {
  /**
   * Simulates the exact bug: API restarts mid-turn → SSE iterator returns
   * { done: true } without emitting turn.done → slackbot should reconnect
   * and eventually get the result, NOT show "Agent completed with no output."
   */
  it("treats iterator done (no turn.done) as wire break and reconnects", async () => {
    let streamCalls = 0;

    const mockClient = {
      streamEvents: () => {
        streamCalls++;
        if (streamCalls === 1) {
          return (async function* () {
            yield {
              eventId: 1,
              eventKind: "amp_raw_event",
              data: {
                type: "assistant",
                message: { content: [{ type: "text", text: "Working on it..." }] },
              },
            };
            // EOF without terminal event: should trigger reconnect.
          })();
        }

        return (async function* () {
          yield {
            eventId: 2,
            eventKind: "amp_raw_event",
            data: {
              type: "assistant",
              message: { content: [{ type: "text", text: "Here is the answer." }] },
            },
          };
          yield {
            eventId: 3,
            eventKind: "amp_raw_event",
            data: {
              type: "turn.done",
              turn_id: 1,
              result: "Here is the answer.",
              agent_thread_id: "",
            },
          };
        })();
      },
      markFinalDelivered: async () => ({ ok: true }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    const chunks: any[] = [];
    const streamGen = (bot as any).streamExecution(
      "test:reconnect-1",
      "exe-reconnect-1",
      new ProgressTracker(),
      Date.now(),
      new AbortController().signal,
    );

    for await (const chunk of streamGen) {
      chunks.push(chunk);
    }

    // Verify reconnect happened via a second streamEvents call.
    expect(streamCalls).toBeGreaterThanOrEqual(2);

    // Verify the final output contains the answer (not "Agent completed with no output")
    const finalOutput = chunks
      .flatMap((chunk) => chunk.type === "blocks" ? chunk.blocks : [])
      .filter((block) => block.type === "markdown")
      .map((block) => block.text)
      .join("");
    expect(finalOutput).toContain("Here is the answer.");
    expect(finalOutput).not.toContain("no output");
  });

  it("gives up after max retries and shows no output", { timeout: 30_000 }, async () => {
    const mockClient = {
      streamEvents: () => (async function* () {
        // EOF immediately on every attempt.
      })(),
      markFinalDelivered: async () => ({ ok: true }),
    };

    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    const chunks: any[] = [];
    const streamGen = (bot as any).streamExecution(
      "test:reconnect-exhaust",
      "exe-reconnect-exhaust",
      new ProgressTracker(),
      Date.now(),
      new AbortController().signal,
    );

    for await (const chunk of streamGen) {
      chunks.push(chunk);
    }

    // Should eventually give up and show "no output"
    const markdownChunks = chunks.filter((c) => c.type === "markdown_text");
    expect(markdownChunks.length).toBeGreaterThan(0);
    expect(markdownChunks[markdownChunks.length - 1].text).toContain("no output");
  });

  it("emits structured keepalives without blank markdown", async () => {
    vi.useFakeTimers();
    try {
      const mockClient = {
        streamEvents: () => (async function* () {
          await new Promise(() => {});
        })(),
        markFinalDelivered: async () => ({ ok: true }),
      };

      const { SlackBot } = await import("../src/lib/bot/bot");
      const bot = new SlackBot(mockClient as any);
      const abortController = new AbortController();
      const streamGen = (bot as any).consumeExecutionEvents(
        "test:keepalive",
        "exe-keepalive",
        new ProgressTracker(),
        abortController.signal,
      );

      const firstChunkPromise = streamGen.next();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await firstChunkPromise).toEqual({
        done: false,
        value: { type: "plan_update", title: "Still working…" },
      });

      const secondChunkPromise = streamGen.next();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await secondChunkPromise).toEqual({
        done: false,
        value: { type: "plan_update", title: "Still working…" },
      });

      abortController.abort();
      expect(await streamGen.next()).toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits run metadata as a context block before heading-based answer sections", async () => {
    const mockClient = {
      streamEvents: () => (async function* () {
        yield {
          eventId: 1,
          eventKind: "amp_raw_event",
          data: { type: "system", subtype: "init", session_id: "T-test-thread" },
        };
        yield {
          eventId: 2,
          eventKind: "amp_raw_event",
          data: {
            type: "turn.done",
            turn_id: 1,
            result: "# Summary\n\nHello.",
          },
        };
      })(),
      markFinalDelivered: async () => ({ ok: true }),
    };
    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);

    const chunks: any[] = [];
    for await (const chunk of (bot as any).streamExecution(
      "test:context-block",
      "exe-context-block",
      new ProgressTracker(),
      Date.now() - 1200,
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const contextChunk = chunks.find(
      (chunk) => chunk.type === "blocks" && chunk.blocks[0]?.type === "rich_text",
    );
    const appName = process.env.APP_NAME || "Centaur";
    expect(contextChunk?.blocks[0].elements[0].elements).toEqual([
      { type: "text", text: `${appName} · ` },
      {
        type: "link",
        url: "https://ampcode.com/threads/T-test-thread",
        text: "agent",
      },
      expect.objectContaining({ type: "text", text: expect.stringContaining(" · ") }),
    ]);
    expect(chunks.some((chunk) => chunk.type === "markdown_text" && chunk.text.includes("Centaur"))).toBe(false);
    expect(chunks).toContainEqual({
      type: "blocks",
      blocks: [
        { type: "markdown", text: "# Summary" },
        { type: "markdown", text: "Hello." },
        {
          type: "rich_text",
          elements: [{
            type: "rich_text_section",
            elements: [
              {
                type: "link",
                url: "https://ampcode.com/threads/T-test-thread",
                text: "View in Amp",
              },
              { type: "text", text: " · " },
              {
                type: "text",
                text: "amp threads continue T-test-thread",
                style: { code: true },
              },
            ],
          }],
        },
      ],
    });
  });

  it("uses turn.done agent_thread_id when system init was missed", async () => {
    const mockClient = {
      streamEvents: () => (async function* () {
        yield {
          eventId: 1,
          eventKind: "amp_raw_event",
          data: {
            type: "turn.done",
            turn_id: 1,
            result: "Hello.",
            agent_thread_id: "T-turn-done-thread",
          },
        };
      })(),
      markFinalDelivered: async () => ({ ok: true }),
    } as unknown as CentaurClient
    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient);

    const chunks: any[] = [];
    for await (const chunk of (bot as any).streamExecution(
      "test:turn-done-thread",
      "exe-turn-done-thread",
      new ProgressTracker(),
      Date.now() - 1200,
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(JSON.stringify(chunks)).toContain("https://ampcode.com/threads/T-turn-done-thread");
  });

  it("splits long plain text at Slack's markdown block payload budget", async () => {
    const result = "a".repeat(13_000);
    const mockClient = {
      streamEvents: () => (async function* () {
        yield {
          eventId: 1,
          eventKind: "amp_raw_event",
          data: { type: "turn.done", turn_id: 1, result },
        };
      })(),
      markFinalDelivered: async () => ({ ok: true }),
    };
    const { SlackBot } = await import("../src/lib/bot/bot");
    const bot = new SlackBot(mockClient as any);
    const tracker = new ProgressTracker();

    const chunks: any[] = [];
    for await (const chunk of (bot as any).streamExecution(
      "test:long-plain-text",
      "exe-long-plain-text",
      tracker,
      Date.now() - 1200,
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    const markdownBlocks = chunks
      .flatMap((chunk) => chunk.type === "blocks" ? chunk.blocks : [])
      .filter((block) => block.type === "markdown");
    expect(markdownBlocks).toHaveLength(1);
    expect(markdownBlocks[0].text + tracker.overflowChunks.join("")).toBe(result);
    expect(markdownBlocks[0].text.length).toBeLessThanOrEqual(12_000);
    expect(tracker.overflowChunks).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6b. Prompt selector parsing (flag-only; no auto-routing)
// ═══════════════════════════════════════════════════════════════════════════════

describe("parsePromptSelectorFlag", () => {
  it("extracts --invest", () => {
    expect(parsePromptSelectorFlag("--invest hyperliquid miqs")).toBe("invest");
  });

  it("handles --INVEST (case insensitive)", () => {
    expect(parsePromptSelectorFlag("--INVEST")).toBe("invest");
  });

  it("resolves aliases (claude → claude-code, pi → pi-mono)", () => {
    expect(parsePromptSelectorFlag("--claude do a thing")).toBe("claude-code");
    expect(parsePromptSelectorFlag("--pi analyse")).toBe("pi-mono");
  });

  it("skips reserved non-harness flags", () => {
    expect(parsePromptSelectorFlag("--engine=opus --opus --sonnet --haiku --model")).toBeUndefined();
  });

  it("returns undefined when no flag is present", () => {
    expect(parsePromptSelectorFlag("thoughts on hyperliquid?")).toBeUndefined();
  });

  it("last flag wins (unchanged from legacy single-flag behavior)", () => {
    expect(parsePromptSelectorFlag("--invest --codex")).toBe("codex");
  });

  it("does NOT infer persona from DocSend/Drive URLs or attachments", () => {
    expect(parsePromptSelectorFlag("look at this co https://docsend.com/view/s/abc")).toBeUndefined();
    expect(parsePromptSelectorFlag("https://drive.google.com/file/d/abc")).toBeUndefined();
  });
});

describe("extractFlagSelector — returns stripped text for the agent", () => {
  it("strips the flag token at start", () => {
    const { selector, cleaned } = extractFlagSelector("--invest hyperliquid miqs");
    expect(selector).toBe("invest");
    expect(cleaned).toBe("hyperliquid miqs");
  });

  it("strips the flag at end of string", () => {
    const { selector, cleaned } = extractFlagSelector("hyperliquid miqs --invest");
    expect(selector).toBe("invest");
    expect(cleaned).toBe("hyperliquid miqs");
  });

  it("bare --invest strips to empty text", () => {
    const { selector, cleaned } = extractFlagSelector("--invest");
    expect(selector).toBe("invest");
    expect(cleaned).toBe("");
  });

  it("no flag leaves text untouched", () => {
    const { selector, cleaned } = extractFlagSelector("hyperliquid miqs");
    expect(selector).toBeUndefined();
    expect(cleaned).toBe("hyperliquid miqs");
  });

  it("collapses whitespace across multiple flags", () => {
    const { selector, cleaned } = extractFlagSelector("--invest --codex hyperliquid");
    expect(selector).toBe("codex");
    expect(cleaned).toBe("hyperliquid");
  });

  it("preserves DocSend/URL content in cleaned text when no flag present", () => {
    const { selector, cleaned } = extractFlagSelector("looking at this co https://docsend.com/view/s/abc");
    expect(selector).toBeUndefined();
    expect(cleaned).toBe("looking at this co https://docsend.com/view/s/abc");
  });

  it("ignores unknown --flags and leaves them in text (prevents unknown persona_id errors)", () => {
    const { selector, cleaned } = extractFlagSelector("set --rpc-url https://mainnet.infura.io");
    expect(selector).toBeUndefined();
    expect(cleaned).toBe("set --rpc-url https://mainnet.infura.io");
  });

  it("ignores --installed embedded in technical text", () => {
    const { selector, cleaned } = extractFlagSelector("is foundry --installed on this machine?");
    expect(selector).toBeUndefined();
    expect(cleaned).toBe("is foundry --installed on this machine?");
  });

  it("strips known flags but preserves unknown flags in the same message", () => {
    const { selector, cleaned } = extractFlagSelector("--invest check --rpc-url endpoint");
    expect(selector).toBe("invest");
    expect(cleaned).toBe("check --rpc-url endpoint");
  });
});

describe("bareFlagGreeting (slackbot short-circuit for bare --invest)", () => {
  it("returns Spock greeting for bare --invest with no other content", () => {
    const { selector, cleaned } = extractFlagSelector("--invest");
    expect(bareFlagGreeting(selector, cleaned, 0)).toBe(
      "Spock — Paradigm's investment agent. What are we looking at?",
    );
  });

  it("returns greeting when only the bot mention remains after flag strip", () => {
    // After flag strip, this leaves "<@U0AH5TRP0H0>" — should still trigger the greeting.
    const { selector, cleaned } = extractFlagSelector("<@U0AH5TRP0H0> --invest");
    expect(bareFlagGreeting(selector, cleaned, 0)).toBe(
      "Spock — Paradigm's investment agent. What are we looking at?",
    );
  });

  it("returns undefined when --invest has a payload", () => {
    const { selector, cleaned } = extractFlagSelector("--invest hyperliquid miqs");
    expect(bareFlagGreeting(selector, cleaned, 0)).toBeUndefined();
  });

  it("returns undefined when there are attachments (user dropped a file)", () => {
    const { selector, cleaned } = extractFlagSelector("--invest");
    expect(bareFlagGreeting(selector, cleaned, 1)).toBeUndefined();
  });

  it("returns undefined for unknown flags (not in KNOWN_PROMPT_SELECTORS)", () => {
    const { selector, cleaned } = extractFlagSelector("--legal");
    // --legal is not in the allowlist, so selector is undefined
    expect(selector).toBeUndefined();
    expect(bareFlagGreeting(selector, cleaned, 0)).toBeUndefined();
  });

  it("returns undefined when no flag is present", () => {
    const { selector, cleaned } = extractFlagSelector("hey");
    expect(bareFlagGreeting(selector, cleaned, 0)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. splitSlackMessage
// ═══════════════════════════════════════════════════════════════════════════════

describe("splitSlackMessage", () => {
  it("returns single chunk for short text", () => {
    const chunks = splitSlackMessage("Hello world", 100);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("returns single chunk for text exactly at limit", () => {
    const text = "a".repeat(100);
    expect(splitSlackMessage(text, 100)).toEqual([text]);
  });

  it("splits on paragraph boundary", () => {
    const para1 = "a".repeat(60);
    const para2 = "b".repeat(60);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitSlackMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("splits on newline when no paragraph break available", () => {
    const line1 = "a".repeat(60);
    const line2 = "b".repeat(60);
    const text = `${line1}\n${line2}`;
    const chunks = splitSlackMessage(text, 80);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("splits on space when no newline available", () => {
    const text = "word ".repeat(20).trim(); // 99 chars
    const chunks = splitSlackMessage(text, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard cuts when no natural break point", () => {
    const text = "a".repeat(200);
    const chunks = splitSlackMessage(text, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(100));
    expect(chunks[1]).toBe("a".repeat(100));
  });

  it("handles real-world long response with multiple paragraphs", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"x".repeat(500)}`);
    const text = paragraphs.join("\n\n");
    const chunks = splitSlackMessage(text, 3900);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
    }
    // Reassembling should recover all content
    const reassembled = chunks.join("\n\n");
    for (const para of paragraphs) {
      expect(reassembled).toContain(para);
    }
  });

  it("uses Slack's 40k plain text message limit by default", () => {
    const text = "a".repeat(40_000);
    expect(splitSlackMessage(text)).toEqual([text]);
    const longText = "a".repeat(40_001);
    expect(splitSlackMessage(longText).length).toBeGreaterThanOrEqual(2);
  });
});

describe("rewriteSlackFileLinks", () => {
  it("rewrites workspace file links to the checked-out commit permalink", () => {
    const markdown = "See [bot.ts](file:///home/agent/workspace/services/slackbot/src/lib/bot/bot.ts#L1-L5).";

    expect(rewriteSlackFileLinks(markdown)).toBe(
      markdown,
    );

    expect(rewriteSlackFileLinks(markdown, {
      repoOwner: "paradigmxyz",
      repoName: "centaur",
      gitCommit: "490cd7aed56fb93efd52e4fa3dd06874d762d88a",
    })).toBe(
      "See [bot.ts](https://github.com/paradigmxyz/centaur/blob/490cd7aed56fb93efd52e4fa3dd06874d762d88a/services/slackbot/src/lib/bot/bot.ts#L1-L5).",
    );
  });

  it("rewrites mounted repo links to the checked-out commit when the repo matches", () => {
    const markdown = "See [bot.ts](file:///home/agent/github/paradigmxyz/centaur/services/slackbot/src/lib/bot/bot.ts#L1-L5).";

    expect(rewriteSlackFileLinks(markdown, {
      repoOwner: "paradigmxyz",
      repoName: "centaur",
      gitCommit: "490cd7aed56fb93efd52e4fa3dd06874d762d88a",
    })).toBe(
      "See [bot.ts](https://github.com/paradigmxyz/centaur/blob/490cd7aed56fb93efd52e4fa3dd06874d762d88a/services/slackbot/src/lib/bot/bot.ts#L1-L5).",
    );
  });

  it("falls back to main for other mounted repos when no exact ref is available", () => {
    const markdown = "See [bot.ts](file:///home/agent/github/paradigmxyz/centaur/services/slackbot/src/lib/bot/bot.ts#L1-L5).";

    expect(rewriteSlackFileLinks(markdown)).toBe(
      "See [bot.ts](https://github.com/paradigmxyz/centaur/blob/main/services/slackbot/src/lib/bot/bot.ts#L1-L5).",
    );
  });

  it("leaves non-file links unchanged", () => {
    const markdown = "Open [Centaur](https://github.com/paradigmxyz/centaur).";
    expect(rewriteSlackFileLinks(markdown)).toBe(markdown);
  });
});
