"use client";

import { useEffect, useMemo, useState } from "react";
import { BASE } from "@/lib/constants";

type StatusListener = (threadKey: string, nextStatus: string | null) => void;

type ThreadStream = {
  es: EventSource;
  listeners: Set<StatusListener>;
  status: string | null;
};

const streamsByKey = new Map<string, ThreadStream>();

function emitStatus(threadKey: string, nextStatus: string | null): void {
  const stream = streamsByKey.get(threadKey);
  if (!stream) return;
  if (stream.status === nextStatus) return;
  stream.status = nextStatus;
  stream.listeners.forEach((listener) => listener(threadKey, nextStatus));
}

function ensureThreadStream(threadKey: string): ThreadStream {
  const existing = streamsByKey.get(threadKey);
  if (existing) return existing;

  const es = new EventSource(
    `${BASE}/api/threads/stream-ui?key=${encodeURIComponent(threadKey)}&live_only=1`,
  );
  const stream: ThreadStream = {
    es,
    listeners: new Set<StatusListener>(),
    status: null,
  };

  es.onmessage = (event) => {
    if (!event.data || event.data === "[DONE]") return;
    try {
      const chunk = JSON.parse(event.data) as {
        type?: string;
        data?: { text?: string };
      };
      if (chunk.type === "data-agent-status") {
        const next = String(chunk.data?.text ?? "").trim();
        emitStatus(threadKey, next || null);
      }
      if (chunk.type === "finish") {
        emitStatus(threadKey, null);
      }
    } catch {
      // Keep stream alive; malformed chunks are ignored.
    }
  };
  es.onerror = () => {
    // EventSource performs its own reconnect logic.
  };

  streamsByKey.set(threadKey, stream);
  return stream;
}

function subscribeThreadStatus(threadKey: string, listener: StatusListener): () => void {
  const stream = ensureThreadStream(threadKey);
  stream.listeners.add(listener);
  listener(threadKey, stream.status);
  return () => {
    const current = streamsByKey.get(threadKey);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.es.close();
      streamsByKey.delete(threadKey);
    }
  };
}

export function useLiveThreadStatus(threadKeys: string[]) {
  const [statusByThread, setStatusByThread] = useState<Record<string, string>>({});
  const normalizedKeySignature = useMemo(() => [...new Set(threadKeys)].sort().join("|"), [threadKeys]);
  const normalizedKeys = useMemo(
    () => (normalizedKeySignature ? normalizedKeySignature.split("|") : []),
    [normalizedKeySignature],
  );

  useEffect(() => {
    const activeKeys = new Set(normalizedKeys);
    setStatusByThread((current) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(current)) {
        if (activeKeys.has(key)) {
          next[key] = value;
          continue;
        }
        changed = true;
      }
      return changed ? next : current;
    });

    if (normalizedKeys.length === 0) {
      setStatusByThread({});
      return;
    }

    const listener: StatusListener = (threadKey, nextStatus) => {
      setStatusByThread((current) => {
        if (!nextStatus) {
          if (!(threadKey in current)) return current;
          const next = { ...current };
          delete next[threadKey];
          return next;
        }
        if (current[threadKey] === nextStatus) return current;
        return { ...current, [threadKey]: nextStatus };
      });
    };
    const unsubscribers = normalizedKeys.map((key) => subscribeThreadStatus(key, listener));

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [normalizedKeySignature]);

  return statusByThread;
}
