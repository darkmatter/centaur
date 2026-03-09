import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { generateId } from "ai";
import type { UIMessage } from "ai";
import type { ThreadDetail, ThreadTokenUsage } from "@/lib/types";
import { BASE } from "@/lib/constants";
import { AgentThreadTransport } from "@/lib/viewer/agent-transport";
import { isActiveState } from "@/lib/viewer/thread-ordering";
import { dataPartSchemas } from "@/lib/data-part-schemas";

type SendRoute = "execute";

function coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return 0;
}

function parseTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const inputTokens =
    typeof payload.input_tokens === "number" && Number.isFinite(payload.input_tokens)
      ? coerceNonNegativeInt(payload.input_tokens)
      : null;
  const outputTokens =
    typeof payload.output_tokens === "number" && Number.isFinite(payload.output_tokens)
      ? coerceNonNegativeInt(payload.output_tokens)
      : null;
  const totalTokens =
    coerceNonNegativeInt(payload.total_tokens) ||
    coerceNonNegativeInt(inputTokens) + coerceNonNegativeInt(outputTokens);
  if (totalTokens <= 0) return null;
  const quality = payload.quality === "authoritative" ? "authoritative" : "estimated";
  const breakdown = payload.breakdown === "known" ? "known" : "unknown";
  const models = Array.isArray(payload.models)
    ? payload.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    : [];

  return {
    input_tokens: breakdown === "known" ? inputTokens : null,
    output_tokens: breakdown === "known" ? outputTokens : null,
    total_tokens: totalTokens,
    cost_usd:
      typeof payload.cost_usd === "number" && Number.isFinite(payload.cost_usd)
        ? payload.cost_usd
        : null,
    quality,
    breakdown,
    models,
  };
}

function mergeTokenUsageSnapshots(
  previous: ThreadTokenUsage | null,
  incoming: ThreadTokenUsage | null,
): ThreadTokenUsage | null {
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (incoming.total_tokens > previous.total_tokens) return incoming;
  if (incoming.total_tokens < previous.total_tokens) return previous;

  const quality =
    previous.quality === "authoritative" || incoming.quality === "authoritative"
      ? "authoritative"
      : "estimated";
  const breakdown =
    previous.breakdown === "known" || incoming.breakdown === "known" ? "known" : "unknown";
  const inputTokens =
    breakdown === "known" ? incoming.input_tokens ?? previous.input_tokens ?? null : null;
  const outputTokens =
    breakdown === "known" ? incoming.output_tokens ?? previous.output_tokens ?? null : null;
  const costUsd = incoming.cost_usd ?? previous.cost_usd ?? null;
  const models = Array.from(new Set([...previous.models, ...incoming.models])).sort();

  return {
    total_tokens: previous.total_tokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    quality,
    breakdown,
    models,
  };
}

export function useThreadStream(
  threadKey: string,
  initialThread?: Partial<ThreadDetail> | null,
  initialMessages?: UIMessage[],
) {
  const [thread, setThread] = useState<ThreadDetail | null>(() => {
    if (!initialThread) return null;
    return {
      message_count: 0,
      last_user_message: null,
      participants: [],
      token_usage: null,
      ...initialThread,
    } as ThreadDetail;
  });
  const [error, setError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [isFetchingThread, setIsFetchingThread] = useState(false);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const streamAttachedRef = useRef(false);
  const fetchInFlightRef = useRef(0);
  const fetchThreadRef = useRef<(() => Promise<boolean>) | null>(null);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState<string | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const transport = useMemo(() => new AgentThreadTransport(threadKey), [threadKey]);

  const chat = useChat({
    id: `thread-${threadKey}`,
    generateId,
    transport,
    messages: initialMessages,
    // Don't auto-resume — we control when to connect based on thread state
    resume: false,
    experimental_throttle: 80,
    dataPartSchemas,
    onData: (part) => {
      if (part.type === "data-agent-status") {
        const data = part.data as { text?: string };
        const text = String(data.text ?? "").trim();
        setAgentStatus(text || null);
      } else if (part.type === "data-token-usage") {
        const nextTokenUsage = parseTokenUsage(part.data);
        setThread((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            token_usage: mergeTokenUsageSnapshots(prev.token_usage, nextTokenUsage),
          };
        });
      } else if (part.type === "data-handoff") {
        const data = part.data as { new_thread_key: string; follow: boolean };
        if (data.follow && data.new_thread_key) {
          setHandoffTarget(data.new_thread_key);
        }
      }
    },
    onFinish: () => {
      setAgentStatus(null);

      const refetch = fetchThreadRef.current;
      if (refetch) {
        void refetch();
      }
    },
  });

  useEffect(() => {
    const stop = (chat as { stop?: () => void }).stop;
    stopStreamRef.current = typeof stop === "function" ? stop : null;
  }, [chat]);

  const fetchThread = useCallback(async (options?: { abortPrevious?: boolean }): Promise<boolean> => {
    const abortPrevious = options?.abortPrevious ?? true;
    fetchInFlightRef.current += 1;
    setIsFetchingThread(true);
    if (abortPrevious) {
      fetchAbortRef.current?.abort();
    } else if (fetchAbortRef.current) {
      fetchInFlightRef.current = Math.max(0, fetchInFlightRef.current - 1);
      if (fetchInFlightRef.current === 0) {
        setIsFetchingThread(false);
      }
      return false;
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const requestSeq = fetchSeqRef.current + 1;
    fetchSeqRef.current = requestSeq;
    try {
      const res = await fetch(
        `${BASE}/api/threads/detail?key=${encodeURIComponent(threadKey)}`,
        { signal: controller.signal },
      );
      if (fetchSeqRef.current !== requestSeq) return false;
      if (!res.ok) {
        if (res.status === 404) {
          setThread(null);
          setError(`Thread not found: ${threadKey}`);
        } else {
          setError(`Failed to fetch thread (${res.status})`);
        }
        return false;
      }
      const data = await res.json();
      if (fetchSeqRef.current !== requestSeq) return false;
      if (data.error) {
        const message = String(data.error);
        if (message.toLowerCase().includes("not found")) {
          setThread(null);
        }
        setError(message);
        return false;
      }
      const detail = data as ThreadDetail;
      setThread((prev) => ({
        ...detail,
        token_usage: mergeTokenUsageSnapshots(
          prev?.token_usage ?? null,
          parseTokenUsage((data as { token_usage?: unknown }).token_usage),
        ),
      }));
      setError(null);
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        return false;
      }
      setError("Failed to fetch thread");
      return false;
    } finally {
      fetchInFlightRef.current = Math.max(0, fetchInFlightRef.current - 1);
      if (fetchInFlightRef.current === 0) {
        setIsFetchingThread(false);
      }
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
      }
    }
  }, [threadKey]);

  useEffect(() => {
    fetchThreadRef.current = () => fetchThread();
    return () => {
      fetchThreadRef.current = null;
    };
  }, [fetchThread]);

  useEffect(() => {
    return () => {
      fetchAbortRef.current?.abort();
      fetchAbortRef.current = null;
    };
  }, []);

  const resumeLiveStream = useCallback(() => {
    const resume = (chat as { resumeStream?: () => Promise<void> | void }).resumeStream;
    if (typeof resume === "function") {
      void resume();
    }
  }, [chat]);

  // Reset state when threadKey changes; fetch full detail, then connect SSE only if running
  useEffect(() => {
    let cancelled = false;

    setThread(
      initialThread
        ? ({ message_count: 0, last_user_message: null, participants: [], token_usage: null, ...initialThread } as ThreadDetail)
        : null,
    );
    setError(null);
    setAgentStatus(null);
    setHandoffTarget(null);
    streamAttachedRef.current = false;
    setReconnectExhausted(false);

    // Fetch full thread from Postgres, then decide on SSE.
    // For freshly created ui: threads the session may not exist yet — retry briefly.
    void (async () => {
      const ok = await fetchThread();
      if (!ok && threadKey.startsWith("ui:") && !cancelled) {
        for (let i = 0; i < 4; i++) {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled) return;
          if (await fetchThread()) break;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [threadKey]);

  // Attach stream only when thread is active; re-attach on every active run.
  const threadState = thread?.state;
  useEffect(() => {
    if (!threadState) return;
    if (isActiveState(threadState)) {
      if (streamAttachedRef.current) return;
      streamAttachedRef.current = true;
      setReconnectExhausted(false);
      resumeLiveStream();
      return;
    }
    streamAttachedRef.current = false;
    setReconnectExhausted(false);
  }, [resumeLiveStream, threadState]);

  useEffect(() => {
    if (chat.status !== "error" || !threadState || !isActiveState(threadState)) {
      setReconnectExhausted(false);
      return;
    }
    let attempt = 0;
    let timeoutId = 0;
    let cancelled = false;
    const scheduleAttempt = () => {
      if (cancelled) return;
      if (attempt >= 3) {
        setReconnectExhausted(true);
        return;
      }
      attempt += 1;
      const timeoutMs = Math.min(4000, attempt * 1000);
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        streamAttachedRef.current = false;
        resumeLiveStream();
        scheduleAttempt();
      }, timeoutMs);
    };
    scheduleAttempt();
    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [chat.status, resumeLiveStream, threadState]);

  useEffect(() => {
    if (!reconnectExhausted || chat.status !== "error" || !threadState || !isActiveState(threadState)) return;
    const intervalId = window.setInterval(() => {
      void fetchThread({ abortPrevious: false });
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [chat.status, fetchThread, reconnectExhausted, threadState]);

  // Visibility handler: fetch once if tab was hidden >30s
  useEffect(() => {
    let disconnectTs = 0;
    const handleVisibility = () => {
      if (document.hidden) {
        disconnectTs = Date.now();
        return;
      }
      if (Date.now() - disconnectTs >= 30_000) {
        void fetchThread();
        if (threadState && isActiveState(threadState)) {
          streamAttachedRef.current = false;
          resumeLiveStream();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [fetchThread, resumeLiveStream, threadState]);

  const sendThreadMessage = useCallback(
    async (message: string, route: SendRoute = "execute") => {
      const text = message.trim();
      if (!text) return;
      await chat.sendMessage({ text }, { body: { route } });
    },
    [chat.sendMessage],
  );

  return {
    thread,
    error,
    fetchThread,
    isReconnecting: chat.status === "error" && isActiveState(thread?.state),
    agentStatus,
    tokenUsage: thread?.token_usage ?? null,
    isFetchingThread,
    chatStatus: chat.status,
    sendThreadMessage,
    chatMessages: chat.messages,
    setMessages: chat.setMessages,
    handoffTarget,
  };
}
