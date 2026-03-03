"use client";

import { useMemo } from "react";
import { useLiveThreadStatus } from "@/hooks/use-live-thread-status";
import { isActiveState } from "@/lib/thread-ordering";
import type { ThreadSummary } from "@/lib/types";

export function useThreadPresence(threads: ThreadSummary[]) {
  const activeThreadKeys = useMemo(
    () => {
      const active = threads.filter((thread) => isActiveState(thread.state));
      active.sort((a, b) => {
        const byActivity = (b.last_activity ?? 0) - (a.last_activity ?? 0);
        if (byActivity !== 0) return byActivity;
        return a.slack_thread_key.localeCompare(b.slack_thread_key);
      });
      return active.slice(0, 12).map((thread) => thread.slack_thread_key);
    },
    [threads],
  );
  const liveStatusByThread = useLiveThreadStatus(activeThreadKeys);
  return { activeThreadKeys, liveStatusByThread };
}
