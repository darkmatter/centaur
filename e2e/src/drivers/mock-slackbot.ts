import type { CentaurClient, InputContentBlock, WorkflowRunAccepted } from "@centaur/api-client";

import type { E2EMetrics } from "../harness/metrics";

export type MockSlackMention = {
  text: string;
  channel?: string;
  threadTs?: string;
  userId?: string;
  teamId?: string;
  messageId?: string;
  historyMessages?: MockSlackHistoryMessage[];
  timeoutMs?: number;
};

export type MockSlackHistoryMessage = {
  messageId: string;
  text: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export type MockSlackResult = {
  threadKey: string;
  threadTs: string;
  runId: string;
  executionId: string;
  status: string;
  terminalReason?: string;
  finalText: string;
  events: Array<{ eventId: number; eventKind: string; type: string }>;
};

export type StartedMention = {
  threadKey: string;
  threadTs: string;
  runId: string;
  executionId: string;
};

export type StopResult = {
  steerStatus: string;
  previous: Omit<MockSlackResult, "runId" | "threadTs">;
  followUp: MockSlackResult;
};

export type StopOnlyResult = {
  steerStatus: string;
  execution: Omit<MockSlackResult, "runId" | "threadTs">;
  executionCount: number;
};

const TERMINAL_EXECUTION_STATUSES = new Set([
  "completed",
  "failed_permanent",
  "failed_transient",
  "cancelled",
]);

function textFromTerminalPayload(payload: Record<string, unknown>): string {
  const result = typeof payload.result === "string" ? payload.result.trim() : "";
  const resultText = typeof payload.result_text === "string" ? payload.result_text.trim() : "";
  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  const errorText = typeof payload.error_text === "string" ? payload.error_text.trim() : "";
  return result || resultText || error || errorText;
}

function statusFromTerminalPayload(payload: Record<string, unknown>): string {
  return typeof payload.status === "string" ? payload.status : "completed";
}

function terminalReasonFromPayload(payload: Record<string, unknown>): string | undefined {
  const reason = typeof payload.terminal_reason === "string" ? payload.terminal_reason.trim() : "";
  return reason || undefined;
}

function isTerminalExecutionState(payload: Record<string, unknown>): boolean {
  const status = typeof payload.status === "string" ? payload.status : "";
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueSlackThread(channel = "C-e2e"): { threadKey: string; threadTs: string } {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const micros = String(now % 1000).padStart(3, "0") + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  const threadTs = `${seconds}.${micros}`;
  return { threadKey: `${channel}:${threadTs}`, threadTs };
}

export class MockSlackbot {
  constructor(
    private readonly client: CentaurClient,
    private readonly metrics: E2EMetrics,
  ) {}

  async sendMention(input: MockSlackMention): Promise<MockSlackResult> {
    const started = await this.startMention(input);
    const streamResult = await this.collectTerminalResult(
      started.threadKey,
      started.executionId,
      input.timeoutMs ?? 300_000,
    );
    return {
      ...started,
      status: streamResult.status,
      terminalReason: streamResult.terminalReason,
      finalText: streamResult.finalText,
      events: streamResult.events,
    };
  }

  async startMention(input: MockSlackMention): Promise<StartedMention> {
    const channel = input.channel ?? "C-e2e";
    const generated = uniqueSlackThread(channel);
    const threadTs = input.threadTs ?? generated.threadTs;
    const threadKey = input.threadTs ? `${channel}:${threadTs}` : generated.threadKey;
    const userId = input.userId ?? "U-e2e";
    const teamId = input.teamId ?? "T-e2e";
    const messageId = input.messageId ?? `slack:${threadTs}`;
    const parts: InputContentBlock[] = [{ type: "text", text: input.text }];
    const historyMessages = (input.historyMessages ?? []).map((message) => ({
      message_id: message.messageId,
      parts: [{ type: "text", text: message.text }],
      user_id: message.userId ?? userId,
      metadata: message.metadata ?? { platform: "slack", history_backfill: true },
    }));

    this.metrics.mark("workflowRequest");
    const workflow = await this.client.startWorkflowRun({
      workflowName: "slack_thread_turn",
      triggerKey: `e2e:slack-thread-turn:${threadKey}:${messageId}`,
      eagerStart: true,
      input: {
        thread_key: threadKey,
        parts,
        user_id: userId,
        message_id: messageId,
        history_messages: historyMessages,
        delivery: {
          platform: "slack",
          channel,
          thread_ts: threadTs,
          recipient_user_id: userId,
          recipient_team_id: teamId,
        },
      },
    });
    this.metrics.mark("workflowAccepted");

    const executionId = await this.waitForExecutionId(workflow, input.timeoutMs ?? 120_000);
    this.metrics.mark("executionAccepted");
    return {
      threadKey,
      threadTs,
      runId: workflow.run_id,
      executionId,
    };
  }

  async waitForExecutionTerminal(
    started: StartedMention,
    timeoutMs = 180_000,
  ): Promise<Omit<MockSlackResult, "runId" | "threadTs">> {
    const terminal = await this.pollExecutionTerminalResult(
      started.threadKey,
      started.executionId,
      timeoutMs,
    );

    return {
      threadKey: started.threadKey,
      executionId: started.executionId,
      status: terminal.status,
      terminalReason: terminal.terminalReason,
      finalText: terminal.finalText,
      events: terminal.events,
    };
  }

  async sendStop(
    started: StartedMention,
    opts: { text?: string; timeoutMs?: number } = {},
  ): Promise<StopResult> {
    // Mirror SlackBot's live-thread behavior for a second mention: it first
    // interrupts the in-flight execution, then starts a new workflow turn for
    // the follow-up message in the same Slack thread.
    await this.waitForExecutionRunning(
      started.threadKey,
      started.executionId,
      Math.min(opts.timeoutMs ?? 180_000, 60_000),
    );

    const steer = await this.client.steerExecution(started.executionId);

    const followUp = await this.sendMention({
      channel: started.threadKey.split(":", 1)[0],
      threadTs: started.threadTs,
      text: opts.text ?? "Stop the in-flight response. Reply with exactly STOPPED.",
      messageId: `slack:${started.threadTs}:stop`,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });

    const previous = await this.pollExecutionTerminalResult(
      started.threadKey,
      started.executionId,
      opts.timeoutMs ?? 180_000,
    );

    return {
      steerStatus: typeof steer.status === "string" ? steer.status : "unknown",
      previous: {
        threadKey: started.threadKey,
        executionId: started.executionId,
        status: previous.status,
        terminalReason: previous.terminalReason,
        finalText: previous.finalText,
        events: previous.events,
      },
      followUp,
    };
  }

  async stopInFlightOnly(
    started: StartedMention,
    opts: { text?: string; timeoutMs?: number } = {},
  ): Promise<StopOnlyResult> {
    await this.waitForExecutionRunning(
      started.threadKey,
      started.executionId,
      Math.min(opts.timeoutMs ?? 180_000, 60_000),
    );

    const steer = await this.client.steerExecution(started.executionId, {
      contentBlocks: [
        {
          type: "text",
          text: opts.text ?? "send message",
        },
      ],
      messageId: `slack:${started.threadTs}:steer-only`,
      metadata: { platform: "slack", e2e: true },
    });

    const terminal = await this.pollExecutionTerminalResult(
      started.threadKey,
      started.executionId,
      opts.timeoutMs ?? 180_000,
    );
    const listed = await this.client.listExecutions(started.threadKey, 10);

    return {
      steerStatus: typeof steer.status === "string" ? steer.status : "unknown",
      executionCount: listed.executions.length,
      execution: {
        threadKey: started.threadKey,
        executionId: started.executionId,
        status: terminal.status,
        terminalReason: terminal.terminalReason,
        finalText: terminal.finalText,
        events: terminal.events,
      },
    };
  }

  private async waitForExecutionId(
    workflow: WorkflowRunAccepted,
    timeoutMs: number,
  ): Promise<string> {
    if (workflow.execution_id) return workflow.execution_id;

    const deadline = Date.now() + timeoutMs;
    let latest = workflow;
    while (Date.now() < deadline) {
      latest = await this.client.getWorkflowRun(workflow.run_id);
      if (latest.execution_id) return latest.execution_id;
      if (["completed", "failed", "cancelled"].includes(latest.status)) {
        throw new Error(
          `workflow reached ${latest.status} before exposing execution_id: ${latest.error_text ?? ""}`,
        );
      }
      await sleep(1_000);
    }

    throw new Error(`workflow did not expose execution_id within ${timeoutMs}ms`);
  }

  private async waitForExecutionRunning(
    threadKey: string,
    executionId: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const execution = await this.client.getExecution(executionId);
      const status = typeof execution.status === "string" ? execution.status : "";
      if (status === "running") return;
      if (TERMINAL_EXECUTION_STATUSES.has(status)) {
        throw new Error(
          `execution ${executionId} reached ${status} before it could be stopped`,
        );
      }
      await sleep(100);
    }

    throw new Error(
      `execution ${executionId} for thread ${threadKey} did not start running within ${timeoutMs}ms`,
    );
  }

  private async pollExecutionTerminalResult(
    threadKey: string,
    executionId: string,
    timeoutMs: number,
  ): Promise<{
    status: string;
    terminalReason?: string;
    finalText: string;
    events: MockSlackResult["events"];
  }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const execution = await this.client.getExecution(executionId);
      const status = statusFromTerminalPayload(execution);
      if (isTerminalExecutionState(execution)) {
        return {
          status,
          terminalReason: terminalReasonFromPayload(execution),
          finalText: textFromTerminalPayload(execution),
          events: [{ eventId: 0, eventKind: "execution_record", type: "execution.state" }],
        };
      }
      await sleep(100);
    }

    throw new Error(`execution ${executionId} for thread ${threadKey} did not complete within ${timeoutMs}ms`);
  }

  private async collectTerminalResult(
    threadKey: string,
    executionId: string,
    timeoutMs: number,
  ): Promise<{
    status: string;
    terminalReason?: string;
    finalText: string;
    events: MockSlackResult["events"];
  }> {
    const deadline = Date.now() + timeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const events: MockSlackResult["events"] = [];

    try {
      this.metrics.mark("streamStarted");
      for await (const event of this.client.streamEvents({
        threadKey,
        executionId,
        afterEventId: 0,
        signal: ac.signal,
      })) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for terminal event for execution ${executionId}`);
        }

        const type = typeof event.data.type === "string" ? event.data.type : "";
        events.push({ eventId: event.eventId, eventKind: event.eventKind, type });
        if (events.length === 1) this.metrics.mark("firstEvent");

        if (type === "turn.done") {
          this.metrics.mark("turnDone");
          return {
            status: statusFromTerminalPayload(event.data),
            terminalReason: terminalReasonFromPayload(event.data),
            finalText: textFromTerminalPayload(event.data),
            events,
          };
        }

        if (type === "execution.state" && isTerminalExecutionState(event.data)) {
          this.metrics.mark("turnDone");
          return {
            status: statusFromTerminalPayload(event.data),
            terminalReason: terminalReasonFromPayload(event.data),
            finalText: textFromTerminalPayload(event.data),
            events,
          };
        }
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
    }

    const execution = await this.client.getExecution(executionId);
    const fallbackText = textFromTerminalPayload(execution);
    if (fallbackText && isTerminalExecutionState(execution)) {
      this.metrics.mark("turnDone");
      return {
        status: statusFromTerminalPayload(execution),
        terminalReason: terminalReasonFromPayload(execution),
        finalText: fallbackText,
        events,
      };
    }

    throw new Error(`execution ${executionId} did not complete within ${timeoutMs}ms`);
  }
}
