export type Harness = "amp" | "claude-code" | "codex" | "pi-mono" | "eng" | "engineer";
export type ThreadState = "running" | "idle" | "stopped" | "stopping" | "working" | "error";

export type Turn = {
  turn_id: number;
  user_message: string;
  events: Record<string, unknown>[];
  result: string;
  user_id?: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  timed_out: boolean;
  duration_s: number;
};

export type Participant = {
  id: string;
  name: string;
  avatar_url: string | null;
};

export type ThreadDetail = {
  slack_thread_key: string;
  container_id: string;
  harness: Harness;
  engine?: "amp" | "claude-code" | "codex" | "pi-mono";
  persona?: string | null;
  agent_thread_id: string | null;
  state: ThreadState;
  created_at: number;
  last_activity: number;
  turns: Turn[];
  thread_name: string | null;
  participants?: Participant[];
};

export type ThreadSummary = {
  slack_thread_key: string;
  container_id: string;
  harness: Harness;
  engine?: "amp" | "claude-code" | "codex" | "pi-mono";
  persona?: string | null;
  agent_thread_id: string | null;
  state: ThreadState;
  created_at: number;
  last_activity: number;
  turn_count: number;
  last_result: string;
  first_message?: string;
  last_user_message?: string;
  thread_name: string | null;
  participants?: Participant[];
};

export const PHASES = [
  "research",
  "plan",
  "clarify",
  "implement",
  "review",
  "publish",
] as const;

export type Phase = (typeof PHASES)[number];
