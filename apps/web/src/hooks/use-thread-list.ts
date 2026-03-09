"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadSummary } from "@/lib/types";
import { BASE } from "@/lib/constants";
import {
  filterAndSortThreads,
  getThreadFilterCounts,
  pickActiveThreadHref,
  type ThreadStatusFilter,
} from "@/lib/viewer/thread-selectors";
import { isActiveState } from "@/lib/viewer/thread-ordering";

const THREADS_POLL_INTERVAL_MS = 5000;

type SharedThreadListSnapshot = {
  threads: ThreadSummary[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
};

const sharedSnapshot: SharedThreadListSnapshot = {
  threads: [],
  loading: true,
  isRefreshing: false,
  error: null,
};
const sharedListeners = new Set<() => void>();
let sharedPollTimer: number | null = null;
let activeConsumers = 0;
let isFetching = false;

function notifySharedListeners(): void {
  sharedListeners.forEach((listener) => listener());
}

function updateSharedSnapshot(next: Partial<SharedThreadListSnapshot>): void {
  Object.assign(sharedSnapshot, next);
  notifySharedListeners();
}

async function fetchSharedThreads(showRefreshIndicator: boolean): Promise<void> {
  if (isFetching) return;
  isFetching = true;
  if (showRefreshIndicator) {
    updateSharedSnapshot({ isRefreshing: true });
  }
  try {
    const response = await fetch(`${BASE}/api/threads`);
    if (!response.ok) {
      throw new Error(`threads fetch failed: ${response.status}`);
    }
    const payload = (await response.json()) as { threads?: ThreadSummary[] };
    updateSharedSnapshot({
      threads: Array.isArray(payload.threads) ? payload.threads : [],
      loading: false,
      error: null,
      isRefreshing: false,
    });
  } catch {
    updateSharedSnapshot({
      loading: false,
      error: "Unable to load threads.",
      isRefreshing: false,
    });
  } finally {
    isFetching = false;
  }
}

function startSharedPolling(): void {
  if (sharedPollTimer !== null) return;
  void fetchSharedThreads(false);
  sharedPollTimer = window.setInterval(() => {
    void fetchSharedThreads(false);
  }, THREADS_POLL_INTERVAL_MS);
}

function stopSharedPolling(): void {
  if (sharedPollTimer === null) return;
  window.clearInterval(sharedPollTimer);
  sharedPollTimer = null;
}

type ThreadListState = {
  query: string;
  statusFilter: ThreadStatusFilter;
};

type ThreadListResult = {
  threads: ThreadSummary[];
  filteredThreads: ThreadSummary[];
  counts: Record<ThreadStatusFilter, number>;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  activeCount: number;
  activeThreadHref?: string;
  query: string;
  statusFilter: ThreadStatusFilter;
  setQuery: (value: string) => void;
  setStatusFilter: (value: ThreadStatusFilter) => void;
  refreshThreads: () => Promise<void>;
};

export function useThreadList(initialState?: Partial<ThreadListState>): ThreadListResult {
  const [sharedState, setSharedState] = useState<SharedThreadListSnapshot>(() => ({ ...sharedSnapshot }));
  const [query, setQuery] = useState(initialState?.query ?? "");
  const [statusFilter, setStatusFilter] = useState<ThreadStatusFilter>(
    initialState?.statusFilter ?? "all",
  );

  useEffect(() => {
    const sync = () => setSharedState({ ...sharedSnapshot });
    sharedListeners.add(sync);
    activeConsumers += 1;
    if (activeConsumers === 1) {
      startSharedPolling();
    } else {
      sync();
    }
    return () => {
      sharedListeners.delete(sync);
      activeConsumers = Math.max(0, activeConsumers - 1);
      if (activeConsumers === 0) {
        stopSharedPolling();
      }
    };
  }, []);

  const filteredThreads = useMemo(
    () => filterAndSortThreads(sharedState.threads, query, statusFilter),
    [query, statusFilter, sharedState.threads],
  );
  const counts = useMemo(() => getThreadFilterCounts(sharedState.threads, query), [query, sharedState.threads]);
  const activeCount = useMemo(
    () =>
      sharedState.threads.filter(
        (thread) => isActiveState(thread.state),
      ).length,
    [sharedState.threads],
  );
  const activeThreadHref = useMemo(
    () => pickActiveThreadHref(sharedState.threads),
    [sharedState.threads],
  );
  const refreshThreads = useCallback(async () => fetchSharedThreads(true), []);

  return {
    threads: sharedState.threads,
    filteredThreads,
    counts,
    loading: sharedState.loading,
    isRefreshing: sharedState.isRefreshing,
    error: sharedState.error,
    activeCount,
    activeThreadHref,
    query,
    statusFilter,
    setQuery,
    setStatusFilter,
    refreshThreads,
  };
}
