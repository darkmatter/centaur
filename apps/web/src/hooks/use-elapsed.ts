import { useEffect, useMemo, useState } from "react";
import { timeAgo } from "@/lib/format";

const tickListeners = new Set<() => void>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

function startSharedTicker(): void {
  if (tickInterval || tickListeners.size === 0) return;
  tickInterval = setInterval(() => {
    tickListeners.forEach((listener) => listener());
  }, 1000);
}

function stopSharedTicker(): void {
  if (!tickInterval || tickListeners.size > 0) return;
  clearInterval(tickInterval);
  tickInterval = null;
}

function subscribeSharedTick(listener: () => void): () => void {
  tickListeners.add(listener);
  startSharedTicker();
  return () => {
    tickListeners.delete(listener);
    stopSharedTicker();
  };
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function useElapsed(startedAt: number | null | undefined, isRunning: boolean): string {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning || !startedAt) return;
    return subscribeSharedTick(() => setTick((value) => value + 1));
  }, [isRunning, startedAt]);

  return useMemo(() => {
    if (!startedAt || !Number.isFinite(startedAt)) return "unknown";
    if (!isRunning) return timeAgo(startedAt);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const elapsed = Math.max(0, nowSeconds - Math.floor(startedAt));
    return formatElapsed(elapsed);
  }, [isRunning, startedAt, tick]);
}
