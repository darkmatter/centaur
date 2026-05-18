import { describe, expect, it } from "vitest";

import { createE2EContext } from "../src/harness/scenario";

describe("slackbot → api → sandbox → amp", () => {
  it("returns an Amp response to a mock Slackbot", async () => {
    const ctx = await createE2EContext();
    const slackbot = ctx.mockSlackbot();
    const nonce = `CENTAUR_E2E_${Date.now()}`;

    const result = await slackbot.sendMention({
      text: `Reply with exactly ${nonce} and nothing else.`,
    });

    expect(result.threadKey).toMatch(/^C-e2e:/);
    expect(result.runId).toBeTruthy();
    expect(result.executionId).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.finalText).toContain(nonce);

    // Keep latency numbers visible in CI without making the first E2E flaky.
    // Once we have a baseline, these can grow non-flaky thresholds.
    console.log(JSON.stringify(ctx.metrics.summary({
      scenario: "slackbot-basic-turn",
      threadKey: result.threadKey,
      runId: result.runId,
      executionId: result.executionId,
      finalTextChars: result.finalText.length,
      eventCount: result.events.length,
    }), null, 2));
  });
});
