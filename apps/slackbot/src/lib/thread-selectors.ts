import { threadName } from "@/lib/thread-name";
import { isActiveState, isRunningState, sortThreads } from "@/lib/thread-ordering";
import type { ThreadState, ThreadSummary } from "@/lib/types";

export type ThreadStatusFilter = "all" | "active" | "idle" | "error";

export function parsePhaseFromMessage(message: string | undefined): string | null {
  const text = message ?? "";
  const match = text.match(/^\[([^\]]+)\]/);
  return match ? match[1].trim().toLowerCase() : null;
}

export function parseActivePhase(thread: ThreadSummary): string | null {
  return parsePhaseFromMessage(thread.last_user_message) ?? parsePhaseFromMessage(thread.first_message);
}

export function runningSubtitle(thread: ThreadSummary): string | null {
  if (!isRunningState(thread.state)) return null;
  const phase = parseActivePhase(thread);
  if (phase) return `Working on ${phase}...`;
  return "Working...";
}

export function getThreadDisplayName(thread: ThreadSummary): string {
  return thread.thread_name || threadName(thread.slack_thread_key);
}

export function matchesThreadQuery(thread: ThreadSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack =
    `${thread.thread_name ?? ""} ${thread.first_message ?? ""} ${thread.last_result ?? ""} ${thread.slack_thread_key}`.toLowerCase();
  return haystack.includes(normalized);
}

export function matchesThreadStatus(thread: ThreadSummary, filter: ThreadStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActiveState(thread.state);
  if (filter === "idle") return !isActiveState(thread.state) && thread.state !== "error";
  return thread.state === filter;
}

export function filterAndSortThreads(
  threads: ThreadSummary[],
  query: string,
  filter: ThreadStatusFilter,
): ThreadSummary[] {
  return sortThreads(threads).filter((thread) => {
    return matchesThreadQuery(thread, query) && matchesThreadStatus(thread, filter);
  });
}

export function getThreadFilterCounts(threads: ThreadSummary[], query: string): Record<ThreadStatusFilter, number> {
  const filteredByQuery = threads.filter((thread) => matchesThreadQuery(thread, query));
  return {
    all: filteredByQuery.length,
    active: filteredByQuery.filter((thread) => isActiveState(thread.state)).length,
    idle: filteredByQuery.filter(
      (thread) => !isActiveState(thread.state) && thread.state !== "error",
    ).length,
    error: filteredByQuery.filter((thread) => thread.state === "error").length,
  };
}

export function pickActiveThreadHref(threads: ThreadSummary[]): string | undefined {
  const sorted = sortThreads(threads);
  const running = sorted.find((thread) => isActiveState(thread.state));
  const fallback = sorted[0];
  const candidate = running ?? fallback;
  return candidate ? `/${encodeURIComponent(candidate.slack_thread_key)}` : undefined;
}

function stateToFilter(state: ThreadState): ThreadStatusFilter {
  if (state === "error") return "error";
  if (isRunningState(state) || state === "stopping") return "active";
  return "idle";
}
