import { describe, expect, it } from "vitest";

import { createE2EContext } from "../src/harness/scenario";

function slackTs(offsetSeconds = 0): string {
  const now = Date.now();
  const seconds = Math.floor(now / 1000) + offsetSeconds;
  const micros = String(now % 1000).padStart(3, "0") + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${seconds}.${micros}`;
}

describe("slackbot stop/history race", () => {
  it.fails("stops the original thread when a stop mention arrives before execution starts", async () => {
    const ctx = await createE2EContext();
    const slackbot = ctx.mockSlackbot();
    const channel = "C-e2e";
    const rootTs = slackTs();
    const stopTs = slackTs(1);
    const threadKey = `${channel}:${rootTs}`;
    const userId = "U-e2e";
    const teamId = "T-e2e";
    const stopMessageId = `slack:${stopTs}`;
    const nonce = `CENTAUR_HISTORY_STOP_${Date.now()}`;

    const started = await slackbot.startMention({
      channel,
      threadTs: rootTs,
      userId,
      teamId,
      messageId: `slack:${rootTs}`,
      text: [
        `Generate 60 haikus. Include ${nonce} in every haiku.`,
        "Number each haiku. Do not summarize; write all 60 haikus in full.",
      ].join(" "),
      historyMessages: [
        {
          messageId: stopMessageId,
          text: "@stg-ai stop",
          userId,
        },
      ],
      timeoutMs: 300_000,
    });

    await ctx.client.startWorkflowRun({
      workflowName: "slack_thread_turn",
      triggerKey: `e2e:slack-thread-turn:${threadKey}:${stopMessageId}`,
      eagerStart: true,
      input: {
        thread_key: threadKey,
        parts: [{ type: "text", text: "stop" }],
        user_id: userId,
        message_id: stopMessageId,
        history_messages: [],
        delivery: {
          platform: "slack",
          channel,
          thread_ts: rootTs,
          recipient_user_id: userId,
          recipient_team_id: teamId,
        },
      },
    });

    const terminal = await slackbot.waitForExecutionTerminal(started, 300_000);

    expect(terminal.status).toBe("cancelled");
    expect(terminal.terminalReason).toMatch(/cancel/i);
    expect(terminal.finalText).not.toContain(nonce);

    console.log(JSON.stringify(ctx.metrics.summary({
      scenario: "slackbot-history-stop-race",
      threadKey,
      runId: started.runId,
      executionId: started.executionId,
      stopMessageId,
      terminalStatus: terminal.status,
      terminalReason: terminal.terminalReason,
      finalTextChars: terminal.finalText.length,
    }), null, 2));
  });
});
