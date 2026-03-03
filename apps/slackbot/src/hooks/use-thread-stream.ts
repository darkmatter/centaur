import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { z } from "zod";
import type { ThreadDetail } from "@/lib/types";
import { BASE } from "@/lib/constants";
import { AgentThreadTransport } from "@/lib/agent-transport";
import { stepsFromUiMessages } from "@/lib/chat-steps";
import { stepsFromTurns } from "@/lib/turn-steps";
import type { Step } from "@/lib/describe";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  estimated: boolean;
  authoritative: boolean;
  model: string | null;
};

type SendRoute = "execute";

function isActiveState(state: string | undefined): boolean {
  return state === "running" || state === "working";
}

export function useThreadStream(threadKey: string, initialThread?: Partial<ThreadDetail> | null) {
  const [thread, setThread] = useState<ThreadDetail | null>(() => {
    if (!initialThread) return null;
    return {
      turns: [],
      participants: [],
      ...initialThread,
    } as ThreadDetail;
  });
  const [error, setError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  // Whether we've connected (or decided not to connect) the SSE stream
  const [sseConnected, setSseConnected] = useState(false);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const resumeStreamRef = useRef<(() => void) | null>(null);
  const transport = useMemo(() => new AgentThreadTransport(threadKey), [threadKey]);

  const chat = useChat({
    id: `thread-${threadKey}`,
    transport,
    // Don't auto-resume — we control when to connect based on thread state
    resume: false,
    experimental_throttle: 50,
    dataPartSchemas: {
      "agent-status": z.object({ text: z.string() }),
      "phase-progress": z.object({ phase: z.string(), turn_id: z.number() }),
      "file-changes": z.object({ changes: z.array(z.object({ path: z.string(), kind: z.string() })) }),
      "subagent": z.object({
        subagent_id: z.string().nullable().optional(),
        phase: z.string().nullable().optional(),
        status: z.string(),
        name: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
        branch_index: z.number().nullable().optional(),
        total_branches: z.number().nullable().optional(),
        completed: z.number().nullable().optional(),
        acceptable: z.union([z.number(), z.boolean()]).nullable().optional(),
        failed: z.number().nullable().optional(),
        completed_count: z.number().nullable().optional(),
        acceptable_count: z.number().nullable().optional(),
        failed_count: z.number().nullable().optional(),
        is_acceptable: z.boolean().nullable().optional(),
        turns: z.number().nullable().optional(),
        tool_calls: z.number().nullable().optional(),
        duration_s: z.number().nullable().optional(),
        max_parallel: z.number().nullable().optional(),
        input_tokens: z.number().nullable().optional(),
        output_tokens: z.number().nullable().optional(),
        total_tokens: z.number().nullable().optional(),
        cost_usd: z.number().nullable().optional(),
        model: z.string().nullable().optional(),
      }),
      "user-message": z.object({
        id: z.string(),
        turn_id: z.number(),
        text: z.string(),
        source: z.string().optional(),
        user_id: z.string().nullable().optional(),
        created_at: z.string().optional(),
      }),
      "context-message": z.object({
        id: z.string(),
        turn_id: z.number(),
        text: z.string(),
        source: z.string().optional(),
        user_id: z.string().nullable().optional(),
        created_at: z.string().optional(),
      }),
      "token-usage": z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        total_tokens: z.number(),
        cost_usd: z.number().nullable().optional(),
        estimated: z.boolean().optional(),
        authoritative: z.boolean().optional(),
        model: z.string().nullable().optional(),
      }),
      "thread-detail": z.record(z.string(), z.unknown()),
    },
    onData: (part) => {
      if (part.type === "data-agent-status") {
        const data = part.data as { text?: string };
        const text = String(data.text ?? "").trim();
        setAgentStatus(text || null);
      } else if (part.type === "data-thread-detail") {
        const data = part.data as Record<string, unknown>;
        setThread(prev => {
          if (Array.isArray(data.turns)) {
            return { participants: [], ...data } as unknown as ThreadDetail;
          }
          if (prev) {
            return { ...prev, ...data } as ThreadDetail;
          }
          return { turns: [], participants: [], ...data } as unknown as ThreadDetail;
        });
        setError(null);
      } else if (part.type === "data-token-usage") {
        const payload = part.data as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          cost_usd?: number | null;
          estimated?: boolean;
          authoritative?: boolean;
          model?: string | null;
        };
        setTokenUsage({
          input_tokens: Number(payload.input_tokens ?? 0),
          output_tokens: Number(payload.output_tokens ?? 0),
          total_tokens: Number(payload.total_tokens ?? 0),
          cost_usd:
            payload.cost_usd === null || payload.cost_usd === undefined
              ? null
              : Number(payload.cost_usd),
          estimated: Boolean(payload.estimated),
          authoritative: Boolean(payload.authoritative),
          model: payload.model ? String(payload.model) : null,
        });
      }
    },
    onFinish: () => {
      setAgentStatus(null);
    },
  });

  useEffect(() => {
    const stop = (chat as { stop?: () => void }).stop;
    const resume = (chat as { resumeStream?: () => void }).resumeStream;
    stopStreamRef.current = typeof stop === "function" ? stop : null;
    resumeStreamRef.current = typeof resume === "function" ? resume : null;
  }, [chat]);

  const fetchThread = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(
        `${BASE}/api/threads/detail?key=${encodeURIComponent(threadKey)}`
      );
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
      if (data.error) {
        const message = String(data.error);
        if (message.toLowerCase().includes("not found")) {
          setThread(null);
        }
        setError(message);
        return false;
      }
      setThread(data as ThreadDetail);
      setError(null);
      return true;
    } catch {
      setError("Failed to fetch thread");
      return false;
    }
  }, [threadKey]);

  // Reset state when threadKey changes; fetch full detail, then connect SSE only if running
  useEffect(() => {
    setThread(
      initialThread
        ? ({ turns: [], participants: [], ...initialThread } as ThreadDetail)
        : null,
    );
    setError(null);
    setAgentStatus(null);
    setTokenUsage(null);
    setSseConnected(false);

    // Fetch full thread from Postgres, then decide on SSE
    void fetchThread().then((ok) => {
      // SSE connection is handled by the effect that watches thread.state
      if (!ok) setSseConnected(true); // Don't try SSE if fetch failed
    });
  }, [threadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect SSE only when thread is running/working
  // Narrow dependency to thread.state (rule: rerender-dependencies)
  const threadState = thread?.state;
  useEffect(() => {
    if (sseConnected) return;
    if (!threadState) return;

    if (isActiveState(threadState)) {
      setSseConnected(true);
      if (resumeStreamRef.current) {
        resumeStreamRef.current();
      }
    } else {
      setSseConnected(true);
    }
  }, [threadState, sseConnected]);

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
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [fetchThread]);

  const sendThreadMessage = useCallback(
    async (message: string, route: SendRoute = "execute") => {
      const text = message.trim();
      if (!text) return;
      await chat.sendMessage({ text }, { body: { route } });
    },
    [chat.sendMessage],
  );

  // Steps from Postgres turns (historical data)
  const historicalSteps = useMemo(
    () => (thread?.turns?.length ? stepsFromTurns(thread.turns) : []),
    [thread?.turns],
  );

  // Steps from live SSE stream (only populated when connected)
  const liveStreamSteps = useMemo(() => stepsFromUiMessages(chat.messages), [chat.messages]);

  // Merge: if SSE is streaming live data, use those; otherwise use historical.
  // When a user submits a message, useChat instantly pushes it to chat.messages
  // so liveStreamSteps includes the optimistic user message even before SSE data
  // arrives. We append those optimistic steps to historical steps during the gap.
  const steps: Step[] = useMemo(() => {
    if (liveStreamSteps.length > 0) {
      // Check if live steps contain only user-message steps (optimistic, no SSE data yet).
      // In that case, append them to historical steps for a seamless transition.
      const hasAssistantContent = liveStreamSteps.some(
        (s) => s.type !== "user-message",
      );
      if (!hasAssistantContent && historicalSteps.length > 0) {
        return [...historicalSteps, ...liveStreamSteps];
      }
      // SSE stream has assistant data — it replays history + live, so use it as primary
      return liveStreamSteps;
    }
    // No SSE data — render from Postgres turns
    return historicalSteps;
  }, [historicalSteps, liveStreamSteps]);

  return {
    thread,
    error,
    fetchThread,
    isReconnecting: chat.status === "error",
    agentStatus,
    tokenUsage,
    chatStatus: chat.status,
    sendThreadMessage,
    liveSteps: steps,
  };
}
