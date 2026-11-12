import { describe, expect, test } from "bun:test";
import {
  buildFailedReplyBody,
  buildPublicCommentReply,
  CommentReplyCollector,
} from "../src/comment-bot";
import { githubTurnPreamble } from "../src/turn";

describe("GitHub public replies", () => {
  test("ignores streamed reasoning and tool details", () => {
    const collector = new CommentReplyCollector();
    collector.update({ type: "markdown_text", text: "Let me inspect this first." });
    collector.update({
      type: "task_update",
      id: "command-1",
      title: "Command execution",
      status: "complete",
      details: "private command and output",
    });
    expect(collector.failed).toBe(false);
    expect(buildPublicCommentReply({ fallback: "private command and output" }).body)
      .not.toContain("private command");
  });

  test("renders a marked concise terminal result", () => {
    expect(buildPublicCommentReply({
      fallback: "GITHUB_SUMMARY:\nOutcome: Fixed.\nChanges: One commit.\nVerification: Tests passed.\nCI: Running.\nNext: Monitor checks.",
    }).body).toContain("- **Outcome:** Fixed.");
    expect(githubTurnPreamble("Review the issue")).toContain("GITHUB_SUMMARY:");
  });

  test("does not expose raw failures or unmarked transcripts", () => {
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
    expect(buildPublicCommentReply({ fallback: "Let me run private command" }).summaryAvailable)
      .toBe(false);
  });
});

 test("shortens long marked answers without discarding their outcome", () => {
   for (const summary of ["Useful answer. ".repeat(250), Array.from({length: 12}, (_, i) => `Line ${i}`).join("\n")]) {
     const reply = buildPublicCommentReply({ fallback: `GITHUB_SUMMARY:\n${summary}` });
     expect(reply.summaryAvailable).toBe(true);
     expect(reply.body.length).toBeLessThanOrEqual(2000);
     expect(reply.body).toContain("Console");
     expect(reply.body).not.toContain("summary unavailable");
   }
 });
