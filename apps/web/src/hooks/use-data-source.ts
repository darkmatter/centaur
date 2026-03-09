"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DataSource } from "@/components/dashboard/types";
import { BASE } from "@/lib/constants";

export type DataSourceResult = {
  data: Record<string, unknown>[];
  isLoading: boolean;
  isRefreshing: boolean;
  lastUpdated: Date | null;
  error: string | null;
};

async function fetchSqlData(
  query: string,
  target: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE}/api/data/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, target }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchApiData(
  endpoint: string,
  params: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  const res = await fetch(`${BASE}${endpoint}${qs}`, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export function useDataSource(
  source: DataSource | undefined,
  initialData: readonly Record<string, unknown>[],
): DataSourceResult {
  const [data, setData] = useState<Record<string, unknown>[]>(
    () => initialData as Record<string, unknown>[],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(
    async (isInitial: boolean) => {
      if (!source || source.type === "inline") return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (isInitial) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      try {
        let result: Record<string, unknown>[];
        if (source.type === "sql") {
          result = await fetchSqlData(
            source.query,
            source.target ?? "internal",
            controller.signal,
          );
        } else {
          result = await fetchApiData(
            source.endpoint,
            source.params,
            controller.signal,
          );
        }
        if (!controller.signal.aborted) {
          setData(result);
          setLastUpdated(new Date());
          setError(null);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Fetch failed");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [source],
  );

  // Initial fetch
  useEffect(() => {
    if (!source || source.type === "inline") return;
    hasFetchedRef.current = false;
    void fetchData(true);
    hasFetchedRef.current = true;

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchData, source]);

  // Polling
  useEffect(() => {
    if (!source || source.type === "inline") return;
    const interval = source.refreshInterval;
    if (!interval || interval <= 0) return;

    const id = window.setInterval(() => {
      void fetchData(false);
    }, interval * 1000);

    return () => window.clearInterval(id);
  }, [fetchData, source]);

  // If no data source, just return the initial data
  if (!source || source.type === "inline") {
    return {
      data: initialData as Record<string, unknown>[],
      isLoading: false,
      isRefreshing: false,
      lastUpdated: null,
      error: null,
    };
  }

  return { data, isLoading, isRefreshing, lastUpdated, error };
}
