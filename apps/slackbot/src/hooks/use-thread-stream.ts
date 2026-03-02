import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { z } from "zod";
import type { ThreadDetail } from "@/lib/types";
import { BASE } from "@/lib/constants";
import { AgentThreadTransport } from "@/lib/agent-transport";
import { stepsFromUiMessages } from "@/lib/chat-steps";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  estimated: boolean;
  authoritative: boolean;
  model: string | null;
};

const POLL_MS_VISIBLE = 5000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const RETRY_MAX_ATTEMPTS = 8;

type SendRoute = "reply" | "execute";

export function useThreadStream(threadKey: string) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const resumeStreamRef = useRef<(() => void) | null>(null);
  const transport = useMemo(() => new AgentThreadTransport(threadKey), [threadKey]);
  const chat = useChat({
    id: `thread-${threadKey}`,
    transport,
    resume: true,
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
    },
    onData: (part) => {
      if (part.type === "data-agent-status") {
        const data = part.data as { text?: string };
        const text = String(data.text ?? "").trim();
        setAgentStatus(text || null);
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

  useEffect(() => {
    setThread(null);
    setError(null);
    setIsPolling(false);
    setAgentStatus(null);
    setTokenUsage(null);
    void fetchThread();

    let poll: ReturnType<typeof setTimeout> | null = null;
    let disconnectTs = 0;
    let retryAttempt = 0;

    const stopLiveStream = () => {
      stopStreamRef.current?.();
    };
    const resumeLiveStream = () => {
      resumeStreamRef.current?.();
    };

    const schedulePoll = (ms: number) => {
      if (poll) clearTimeout(poll);
      poll = setTimeout(() => {
        setIsPolling(true);
        void fetchThread()
          .then((ok) => {
            if (ok) {
              retryAttempt = 0;
              schedulePoll(POLL_MS_VISIBLE);
              return;
            }
            retryAttempt = Math.min(retryAttempt + 1, RETRY_MAX_ATTEMPTS);
            const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttempt);
            const jitter = Math.floor(exp * 0.5 * Math.random());
            schedulePoll(Math.min(RETRY_MAX_MS, exp) + jitter);
          })
          .finally(() => setIsPolling(false));
      }, ms);
    };

    const clearPoll = () => {
      if (poll) clearTimeout(poll);
      poll = null;
    };

    const handleVisibility = () => {
      if (document.hidden) {
        clearPoll();
        stopLiveStream();
        disconnectTs = Date.now();
        setIsPolling(false);
        return;
      }

      const away = Date.now() - disconnectTs;
      retryAttempt = 0;
      clearPoll();
      if (away >= 30_000) {
        setIsPolling(true);
        void fetchThread().finally(() => {
          setIsPolling(false);
          resumeLiveStream();
          schedulePoll(POLL_MS_VISIBLE);
        });
        return;
      }
      resumeLiveStream();
      schedulePoll(POLL_MS_VISIBLE);
    };

    if (!document.hidden) {
      schedulePoll(POLL_MS_VISIBLE);
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearPoll();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [threadKey, fetchThread]);

  const sendThreadMessage = useCallback(
    async (message: string, route: SendRoute = "execute") => {
      const text = message.trim();
      if (!text) return;
      await chat.sendMessage({ text }, { body: { route } });
    },
    [chat.sendMessage],
  );

  const liveSteps = useMemo(() => stepsFromUiMessages(chat.messages), [chat.messages]);

  return {
    thread,
    error,
    fetchThread,
    isReconnecting: isPolling || chat.status === "error",
    agentStatus,
    tokenUsage,
    chatStatus: chat.status,
    sendThreadMessage,
    liveSteps,
  };
}
