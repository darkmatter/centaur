import type { ThreadState, ThreadSummary } from "@/lib/types";

const THREAD_STATE_RANK: Record<ThreadState, number> = {
  error: 0,
  stopping: 1,
  running: 2,
  working: 2,
  idle: 3,
  stopped: 4,
};

export function isRunningState(state: ThreadState): boolean {
  return state === "running" || state === "working";
}

export function isActiveState(state: ThreadState): boolean {
  return isRunningState(state) || state === "stopping";
}

function compareThreadSummary(a: ThreadSummary, b: ThreadSummary): number {
  const rankDelta = THREAD_STATE_RANK[a.state] - THREAD_STATE_RANK[b.state];
  if (rankDelta !== 0) return rankDelta;

  const activityDelta = (b.last_activity ?? 0) - (a.last_activity ?? 0);
  if (activityDelta !== 0) return activityDelta;

  const createdDelta = (b.created_at ?? 0) - (a.created_at ?? 0);
  if (createdDelta !== 0) return createdDelta;

  return a.slack_thread_key.localeCompare(b.slack_thread_key);
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort(compareThreadSummary);
}
