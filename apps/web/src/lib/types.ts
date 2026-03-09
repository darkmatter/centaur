export type Harness = "amp" | "claude-code" | "codex" | "pi-mono" | "eng" | "engineer" | "legal";
export type ThreadState = "running" | "idle" | "stopped" | "stopping" | "working" | "error";

export type ThreadTokenUsage = {
  total_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  quality: "authoritative" | "estimated";
  breakdown: "known" | "unknown";
  models: string[];
};

export type Participant = {
  id: string;
  name: string;
  username?: string | null;
  avatar_url: string | null;
};

export type ThreadDetail = {
  slack_thread_key: string;
  harness: Harness;
  state: ThreadState;
  created_at: number;
  last_activity: number;
  message_count: number;
  last_user_message: string | null;
  token_usage: ThreadTokenUsage | null;
  thread_name: string | null;
  participants?: Participant[];
};

export type ThreadSummary = {
  slack_thread_key: string;
  harness: Harness;
  state: ThreadState;
  created_at: number;
  last_activity: number;
  turn_count: number;
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
