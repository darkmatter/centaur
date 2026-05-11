import { describe, expect, it } from "vitest";

import { createE2EContext } from "../src/harness/scenario";

describe("slackbot steering", () => {
  it("stops an in-flight long generation when a stop message is sent", async () => {
    const ctx = await createE2EContext();
    const slackbot = ctx.mockSlackbot();
    const nonce = `CENTAUR_STEER_${Date.now()}`;

    const started = await slackbot.startMention({
      text: [
        `Write 40 haiku about ephemeral Kubernetes clusters. Include ${nonce} in every haiku.`,
        "Number each haiku. Do not summarize; write all 40 haiku in full.",
      ].join(" "),
      timeoutMs: 300_000,
    });

    const stopped = await slackbot.sendStop(started, { timeoutMs: 180_000 });

    expect(["steered", "cancel_requested", "cancelled"]).toContain(stopped.steerStatus);
    expect(stopped.previous.status).toBe("cancelled");
    expect(stopped.previous.terminalReason).toMatch(/cancel/i);
    expect(stopped.followUp.status).toBe("completed");
    expect(stopped.followUp.finalText).toMatch(/STOPPED/i);

    // A non-stopped run would usually contain the nonce many times. Keep the
    // assertion intentionally loose because Amp may emit a short acknowledgement
    // after steering instead of a hard cancellation.
    const nonceCount = stopped.previous.finalText.split(nonce).length - 1;
    expect(nonceCount).toBeLessThan(5);

    console.log(JSON.stringify(ctx.metrics.summary({
      scenario: "slackbot-steering-stop",
      threadKey: started.threadKey,
      runId: started.runId,
      executionId: started.executionId,
      steerStatus: stopped.steerStatus,
      previousStatus: stopped.previous.status,
      previousTerminalReason: stopped.previous.terminalReason,
      previousFinalTextChars: stopped.previous.finalText.length,
      previousEventCount: stopped.previous.events.length,
      followUpExecutionId: stopped.followUp.executionId,
      followUpStatus: stopped.followUp.status,
      followUpFinalTextChars: stopped.followUp.finalText.length,
      followUpEventCount: stopped.followUp.events.length,
    }), null, 2));
  });

  it("does not surface Amp interrupt steering as a failed agent execution", async () => {
    const ctx = await createE2EContext();
    const slackbot = ctx.mockSlackbot();
    const nonce = `CENTAUR_STEER_CANCEL_${Date.now()}`;

    const started = await slackbot.startMention({
      text: [
        `Write 60 haiku about warm Kubernetes sandboxes. Include ${nonce} in every haiku.`,
        "Number each haiku. Do not summarize; write all 60 haiku in full.",
      ].join(" "),
      timeoutMs: 300_000,
    });

    const stopped = await slackbot.stopInFlightOnly(started, {
      text: "send message",
      timeoutMs: 180_000,
    });

    expect(["steered", "cancel_requested", "cancelled"]).toContain(stopped.steerStatus);
    expect(stopped.execution.status).toBe("cancelled");
    expect(stopped.execution.terminalReason).toBe("cancel_requested");
    expect(stopped.execution.finalText).not.toMatch(/agent execution failed/i);
    expect(stopped.execution.finalText).not.toMatch(/User cancelled \(SIGINT\/SIGTERM\)/i);
    expect(stopped.executionCount).toBe(1);

    console.log(JSON.stringify(ctx.metrics.summary({
      scenario: "slackbot-steering-cancel-no-failure",
      threadKey: started.threadKey,
      runId: started.runId,
      executionId: started.executionId,
      steerStatus: stopped.steerStatus,
      terminalStatus: stopped.execution.status,
      terminalReason: stopped.execution.terminalReason,
      finalTextChars: stopped.execution.finalText.length,
      executionCount: stopped.executionCount,
    }), null, 2));
  });
});
