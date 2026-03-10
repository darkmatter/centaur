import type { UIMessage } from "ai";
import type { ToolCall, SubagentStep } from "@/lib/describe";
import type { ThreadDetail, ThreadSummary, ThreadTokenUsage, Participant } from "@/lib/types";

const FIXTURE_NOW_S = Date.UTC(2026, 2, 9, 18, 0, 0) / 1000;

export const fixtureParticipants: Participant[] = [
  { id: "U123", name: "Arjun", username: "arjun", avatar_url: null },
  { id: "U456", name: "Kit", username: "kit", avatar_url: null },
];

export const fixtureTokenUsage: ThreadTokenUsage = {
  total_tokens: 48231,
  input_tokens: 35111,
  output_tokens: 13120,
  cost_usd: 0.143,
  quality: "authoritative",
  breakdown: "known",
  models: ["claude-sonnet-4"],
};

export const fixtureThreadDetail: ThreadDetail = {
  slack_thread_key: "slack:C123:1730000000.000100",
  harness: "amp",
  state: "running",
  created_at: FIXTURE_NOW_S - 60 * 20,
  last_activity: FIXTURE_NOW_S - 5,
  message_count: 14,
  last_user_message: "Investigate thread viewer motion and improve shell previews.",
  token_usage: fixtureTokenUsage,
  thread_name: "Thread Viewer Motion Refresh",
  participants: fixtureParticipants,
};

export const fixtureThreadSummaries: ThreadSummary[] = [
  {
    slack_thread_key: "slack:C123:1730000000.000100",
    harness: "amp",
    state: "running",
    created_at: FIXTURE_NOW_S - 60 * 20,
    last_activity: FIXTURE_NOW_S - 5,
    turn_count: 5,
    thread_name: "Thread Viewer Motion Refresh",
    first_message: "[review] Audit thread viewer motion and shell behavior",
    last_user_message: "Investigate thread viewer motion and improve shell previews.",
    participants: fixtureParticipants,
  },
  {
    slack_thread_key: "slack:C123:1730000000.000200",
    harness: "claude-code",
    state: "error",
    created_at: FIXTURE_NOW_S - 60 * 120,
    last_activity: FIXTURE_NOW_S - 60 * 9,
    turn_count: 2,
    thread_name: "Deploy Error Triage",
    first_message: "[review] Why did the deploy fail?",
    last_user_message: "Why did the deploy fail?",
    participants: fixtureParticipants,
  },
  {
    slack_thread_key: "slack:C123:1730000000.000300",
    harness: "codex",
    state: "working",
    created_at: FIXTURE_NOW_S - 60 * 42,
    last_activity: FIXTURE_NOW_S - 18,
    turn_count: 4,
    thread_name: "Panel Interaction Audit",
    first_message: "[implement] Unify mobile overlays around one panel primitive",
    last_user_message: "Make the mobile sheet feel more native on iPhone.",
    participants: fixtureParticipants,
  },
  {
    slack_thread_key: "slack:C123:1730000000.000400",
    harness: "claude-code",
    state: "stopped",
    created_at: FIXTURE_NOW_S - 60 * 180,
    last_activity: FIXTURE_NOW_S - 60 * 28,
    turn_count: 7,
    thread_name: "UIKit Follow-up Pass",
    first_message: "[publish] Refresh examples and fixture coverage",
    last_user_message: "Bring the UI kit up to date with the latest viewer.",
    participants: fixtureParticipants,
  },
];

export const fixtureToolCalls: ToolCall[] = [
  {
    id: "tool-1",
    name: "shell",
    input: { command: "rg \"thread\" apps/slackbot/src" },
    output: "apps/slackbot/src/components/thread/thread-detail-header.tsx\napps/slackbot/src/components/thread/activity-feed-v2.tsx",
    rawOutput: "apps/slackbot/src/components/thread/thread-detail-header.tsx\napps/slackbot/src/components/thread/activity-feed-v2.tsx",
    state: "done",
    uiState: "output-available",
  },
  {
    id: "tool-2",
    name: "read_file",
    input: { path: "apps/slackbot/src/components/thread/thread-detail-header.tsx" },
    output: "Read thread-detail-header.tsx",
    rawOutput: { summary: "Read thread-detail-header.tsx" },
    state: "done",
    uiState: "output-available",
  },
];

export const fixtureSubagent: SubagentStep = {
  id: "subagent:demo:working",
  type: "subagent",
  subagentId: "subagent-working",
  status: "working",
  name: "Panel Interaction Audit",
  summary: "Validating the shared panel choreography and focus behavior.",
  activity: "Validating focus return and drag-to-dismiss behavior",
  activities: [
    { description: "Read responsive-panel.tsx", toolName: "Read" },
    { description: "Read thread-info-sheet.tsx", toolName: "Read" },
    { description: "Compared focus and drag behavior across overlays", toolName: "Search" },
  ],
  phase: "review",
  turns: 4,
  toolCalls: 12,
  durationS: 94,
  inputTokens: 24000,
  outputTokens: 4200,
  totalTokens: 28200,
  model: "claude-sonnet-4",
  completed: 1,
  totalBranches: 3,
};

export const fixtureSubagentCompleted: SubagentStep = {
  id: "subagent:demo:completed",
  type: "subagent",
  subagentId: "subagent-completed",
  status: "completed",
  name: "Shell Regression Probe",
  summary: "Confirmed the rolling shell preview stays lively without introducing noisy motion.",
  activities: [
    { description: "Ran long-output shell fixture", toolName: "Shell" },
    { description: "Compared preview and expanded shell states", toolName: "Read" },
  ],
  phase: "review",
  turns: 3,
  toolCalls: 8,
  durationS: 61,
  inputTokens: 12800,
  outputTokens: 2600,
  totalTokens: 15400,
  model: "claude-sonnet-4",
};

export const fixtureSubagentFailed: SubagentStep = {
  id: "subagent:demo:failed",
  type: "subagent",
  subagentId: "subagent-failed",
  status: "failed",
  name: "Fixture Regression Audit",
  error: "Fixture review caught stale assumptions before the refresh was finalized.",
  phase: "verify",
  turns: 1,
  toolCalls: 2,
  durationS: 33,
  model: "claude-sonnet-4",
};

const rawFixtureThreadMessages = [
  {
    id: "fixture-user-1",
    role: "user",
    parts: [
      {
        id: "fixture-user-1-text",
        type: "text",
        text: "[review] Audit the thread viewer and make the live shell feel closer to opencode without getting noisy.",
      },
    ],
  },
  {
    id: "fixture-assistant-1",
    role: "assistant",
    parts: [
      {
        id: "fixture-reasoning-1",
        type: "reasoning",
        text: "I am checking the shell surface, overlay choreography, subagent detail fidelity, and whether the feed feels alive without turning into motion spam.",
      },
      {
        id: "fixture-system-1",
        type: "data-system-event",
        data: {
          title: "Loaded history",
          text: "Loaded 24 earlier messages from Slack and the thread archive.",
          tone: "info",
        },
      },
      {
        id: "fixture-context-1",
        type: "data-context-message",
        data: {
          id: "fixture-context-message-1",
          turn_id: 11,
          text: "Please keep this high taste and iPhone-native.",
          source: "slack",
          user_id: "U456",
        },
      },
      {
        id: "fixture-tool-1",
        type: "tool-grep",
        toolName: "Grep",
        toolCallId: "fixture-tool-grep",
        input: { pattern: "ResponsivePanel|ThreadOverlayHost", path: "apps/slackbot/src" },
        output:
          "apps/slackbot/src/components/ui/responsive-panel.tsx\napps/slackbot/src/components/thread/thread-overlay-host.tsx",
        state: "output-available",
      },
      {
        id: "fixture-tool-2",
        type: "tool-read",
        toolName: "Read",
        toolCallId: "fixture-tool-read",
        input: { path: "apps/slackbot/src/components/ui/responsive-panel.tsx" },
        output: "Read responsive-panel.tsx",
        state: "output-available",
      },
      {
        id: "fixture-shell-stream",
        type: "data-shell-command",
        data: {
          command: 'rg "ResponsivePanel|ThreadOverlayHost|data-context-message" apps/slackbot/src',
          output:
            "apps/slackbot/src/components/ui/responsive-panel.tsx\napps/slackbot/src/components/thread/thread-overlay-host.tsx\napps/slackbot/src/components/ai-elements/ui-message-renderer.tsx",
          status: "running",
        },
      },
      {
        id: "fixture-subagent-working",
        type: "data-subagent",
        data: {
          subagent_id: fixtureSubagent.subagentId,
          status: fixtureSubagent.status,
          name: fixtureSubagent.name,
          summary: fixtureSubagent.summary,
          activity: fixtureSubagent.activity,
          activities: fixtureSubagent.activities,
          phase: fixtureSubagent.phase,
          turns: fixtureSubagent.turns,
          tool_calls: fixtureSubagent.toolCalls,
          duration_s: fixtureSubagent.durationS,
          input_tokens: fixtureSubagent.inputTokens,
          output_tokens: fixtureSubagent.outputTokens,
          total_tokens: fixtureSubagent.totalTokens,
          model: fixtureSubagent.model,
          completed: fixtureSubagent.completed,
          total_branches: fixtureSubagent.totalBranches,
        },
      },
      {
        id: "fixture-source-1",
        type: "source-url",
        url: "https://github.com/anomalyco/opencode",
        title: "OpenCode reference",
      },
      {
        id: "fixture-text-1",
        type: "text",
        text: "I unified the mobile info sheet onto the shared panel system and concentrated the highest-value motion in the shell surface where the product most needs to feel live.",
      },
    ],
  },
  {
    id: "fixture-assistant-2",
    role: "assistant",
    parts: [
      {
        id: "fixture-phase-1",
        type: "data-phase-progress",
        data: {
          phase: "review",
          turn_id: 12,
        },
      },
      {
        id: "fixture-user-inline-1",
        type: "data-user-message",
        data: {
          id: "thread-ui-user-1",
          turn_id: 12,
          text: "Can you make the UI kit reflect the newest states too?",
          source: "thread_ui",
          user_id: "U123",
        },
      },
      {
        id: "fixture-shell-done",
        type: "data-shell-command",
        data: {
          command: "pnpm lint",
          output: "> eslint src --ext .ts,.tsx\n\nNo problems found.",
          exitCode: 0,
          status: "completed",
        },
      },
      {
        id: "fixture-files-1",
        type: "data-file-changes",
        data: {
          changes: [
            { path: "apps/slackbot/src/components/ui/responsive-panel.tsx", kind: "update" },
            { path: "apps/slackbot/src/components/thread/thread-info-sheet.tsx", kind: "update" },
            { path: "apps/slackbot/src/lib/thread-viewer-fixtures.ts", kind: "update" },
          ],
        },
      },
      {
        id: "fixture-text-2",
        type: "text",
        text: "The UI kit now shows the real feed primitives and the overlay host, so it is useful for taste and regression checks instead of just snapshotting isolated cards.",
      },
    ],
  },
  {
    id: "fixture-user-2",
    role: "user",
    parts: [
      {
        id: "fixture-user-2-text",
        type: "text",
        text: "Show me the failure path too and make sure the examples stay in sync.",
      },
    ],
  },
  {
    id: "fixture-assistant-3",
    role: "assistant",
    parts: [
      {
        id: "fixture-shell-failed",
        type: "data-shell-command",
        data: {
          command: 'rg "fixture|overlay|thread-viewer" apps/slackbot/src',
          output:
            "One fixture assumption drifted after the UIKit surface changed, so the example route had to be brought back into sync with the shipped viewer.",
          exitCode: 1,
          status: "completed",
        },
      },
      {
        id: "fixture-subagent-failed",
        type: "data-subagent",
        data: {
          subagent_id: fixtureSubagentFailed.subagentId,
          status: fixtureSubagentFailed.status,
          name: fixtureSubagentFailed.name,
          error: fixtureSubagentFailed.error,
          phase: fixtureSubagentFailed.phase,
          turns: fixtureSubagentFailed.turns,
          tool_calls: fixtureSubagentFailed.toolCalls,
          duration_s: fixtureSubagentFailed.durationS,
          model: fixtureSubagentFailed.model,
        },
      },
      {
        id: "fixture-system-warn",
        type: "data-system-event",
        data: {
          title: "Verification update",
          text: "The dedicated example route was resynced with the shipped thread viewer after the latest surface refresh.",
          tone: "warn",
        },
      },
      {
        id: "fixture-text-3",
        type: "text",
        text: "After refreshing the fixture contract, the example route stayed aligned with the production viewer again.",
      },
    ],
  },
];

export const fixtureThreadMessages = rawFixtureThreadMessages as unknown as UIMessage[];
