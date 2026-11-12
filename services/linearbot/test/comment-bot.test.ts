import { describe, expect, it } from "bun:test";
import {
  buildCommentReplyBody,
  buildFailedReplyBody,
  buildThinkingReplyBody,
  CommentReplyCollector,
} from "../src/comment-bot";

describe("Linear public replies", () => {
  it("keeps stream reasoning and tool output out of comments", () => {
    const collector = new CommentReplyCollector();
    collector.update({ type: "markdown_text", text: "Let me inspect this." });
    collector.update({
      type: "task_update",
      id: "command-1",
      title: "Command execution",
      status: "complete",
      details: "private command and output",
    });
    expect(collector.failed).toBe(false);
    expect(buildThinkingReplyBody()).not.toContain("private command");
    expect(buildCommentReplyBody({ fallback: "private command and output" }))
      .not.toContain("private command");
  });

  it("publishes a marked concise terminal outcome", () => {
    expect(buildCommentReplyBody({ fallback: "LINEAR_SUMMARY:\nOutcome: Fixed the issue.\nVerification: Tests passed." }))
      .toBe("Outcome: Fixed the issue.\nVerification: Tests passed.");
  });

  it("uses a fixed failure message", () => {
    const collector = new CommentReplyCollector();
    collector.update({
      type: "task_update",
      id: "failure-1",
      title: "Command execution",
      status: "error",
      details: "private stack trace",
    });
    expect(collector.failed).toBe(true);
    expect(buildFailedReplyBody()).not.toContain("private stack trace");
  });
});

it("shortens long marked answers instead of losing them", () => {
  for (const text of ["Useful answer. ".repeat(250), Array.from({length: 12}, (_, i) => `Line ${i}`).join("\n")]) {
    const body = buildCommentReplyBody({fallback: `LINEAR_SUMMARY:\n${text}`});
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toContain("Console");
    expect(body).not.toContain("summary unavailable");
  }
});
