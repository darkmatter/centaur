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
  return state === "running" || state === "working" || state === "stopping";
}

function coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return 0;
}

function extractUsageFromPayload(payload: Record<string, unknown>): { input: number; output: number } {
  let input =
    coerceNonNegativeInt(payload.input_tokens) +
    coerceNonNegativeInt(payload.prompt_tokens) +
    coerceNonNegativeInt(payload.cached_input_tokens) +
    coerceNonNegativeInt(payload.cache_read_input_tokens) +
    coerceNonNegativeInt(payload.cache_creation_input_tokens);
  let output =
    coerceNonNegativeInt(payload.output_tokens) +
    coerceNonNegativeInt(payload.completion_tokens);

  if (input === 0 && output === 0) {
    const total = coerceNonNegativeInt(payload.total_tokens);
    if (total > 0) {
      input = Math.floor(total / 2);
      output = total - input;
    }
  }
  return { input, output };
}

function deriveUsageFromTurns(turns: ThreadDetail["turns"] | undefined): TokenUsage | null {
  if (!turns || turns.length === 0) return null;
  const usageByTurn = new Map<number, { input: number; output: number; authoritative: boolean }>();
  let model: string | null = null;

  for (const turn of turns) {
    const turnId = Number(turn.turn_id || 0);
    if (!Number.isFinite(turnId) || turnId <= 0) continue;
    for (const rawEvent of turn.events || []) {
      const event = (rawEvent ?? {}) as Record<string, unknown>;
      const eventType = String(event.type ?? "");
      const messageUsage = (event.message as Record<string, unknown> | undefined)?.usage;
      const usagePayload =
        (typeof messageUsage === "object" && messageUsage
          ? (messageUsage as Record<string, unknown>)
          : typeof event.usage === "object" && event.usage
            ? (event.usage as Record<string, unknown>)
            : null);
      if (!usagePayload) continue;

      const usage = extractUsageFromPayload(usagePayload);
      if (usage.input === 0 && usage.output === 0) continue;
      const previous = usageByTurn.get(turnId) ?? { input: 0, output: 0, authoritative: false };
      if (eventType === "turn.completed") {
        usageByTurn.set(turnId, { input: usage.input, output: usage.output, authoritative: true });
      } else if (!previous.authoritative) {
        usageByTurn.set(turnId, {
          input: previous.input + usage.input,
          output: previous.output + usage.output,
          authoritative: false,
        });
      }

      const messageModel = String(
        (event.message as Record<string, unknown> | undefined)?.model ?? event.model ?? "",
      ).trim();
      if (messageModel) {
        model = messageModel;
      }
    }
  }

  let input = 0;
  let output = 0;
  let authoritative = usageByTurn.size > 0;
  for (const usage of usageByTurn.values()) {
    input += usage.input;
    output += usage.output;
    authoritative = authoritative && usage.authoritative;
  }
  const total = input + output;
  if (total === 0) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cost_usd: null,
    estimated: !authoritative,
    authoritative,
    model,
  };
}

function maxStepSequence(steps: Step[]): number | undefined {
  let max = -1;
  for (const step of steps) {
    if (typeof step.eventSeq === "number" && step.eventSeq > max) {
      max = step.eventSeq;
    }
  }
  return max > 0 ? max : undefined;
}

function stepTurnId(step: Step): number | undefined {
  if (typeof step.turnId === "number" && Number.isFinite(step.turnId)) {
    return step.turnId;
  }
  const match = step.id.match(/turn-(\d+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactStepTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 240);
}

function toolGroupCallKey(step: Extract<Step, { type: "tool-group" }>): string {
  const ids = step.calls
    .map((call) => call.id.trim() || call.name.trim())
    .filter((value) => value.length > 0);
  if (ids.length > 0) return ids.join("|");
  return compactStepTextKey(step.summary);
}

function semanticMergeKey(step: Step): string {
  const turnId = stepTurnId(step);
  const seq = step.eventSeq;
  if (step.type === "phase" && turnId !== undefined) {
    if (seq !== undefined) return `phase:${turnId}:${seq}:${step.phase}`;
    return `phase:${turnId}:${step.phase}`;
  }
  if (step.type === "user-message" && turnId !== undefined) {
    return `user:${turnId}:${step.text.trim()}`;
  }
  if (step.type === "result" && turnId !== undefined && seq !== undefined) {
    return `result:${turnId}:${seq}:${compactStepTextKey(step.text)}`;
  }
  if (step.type === "thinking" && turnId !== undefined && seq !== undefined) {
    return `thinking:${turnId}:${seq}:${compactStepTextKey(step.text)}`;
  }
  if (step.type === "terminal" && turnId !== undefined && seq !== undefined) {
    return `terminal:${turnId}:${seq}`;
  }
  if (step.type === "error" && turnId !== undefined && seq !== undefined) {
    return `error:${turnId}:${seq}`;
  }
  if (step.type === "system" && turnId !== undefined && seq !== undefined) {
    return `system:${turnId}:${seq}`;
  }
  if (step.type === "file-changes" && turnId !== undefined && seq !== undefined) {
    return `file:${turnId}:${seq}`;
  }
  if (step.type === "subagent" && turnId !== undefined && seq !== undefined) {
    return `subagent:${turnId}:${seq}:${step.subagentId ?? step.id}`;
  }
  if (step.type === "diff" && turnId !== undefined && seq !== undefined) {
    return `diff:${turnId}:${seq}`;
  }
  if (step.type === "tool-group" && turnId !== undefined && seq !== undefined) {
    return `tool:${turnId}:${seq}:${toolGroupCallKey(step)}`;
  }
  if (step.type === "context-group") {
    if (turnId !== undefined) return `context:${turnId}`;
    return `context:${step.id}`;
  }
  return `id:${step.id}`;
}

function mergeStepsPreferLive(historical: Step[], live: Step[]): Step[] {
  const mergedById = new Map<string, Step>();
  for (const step of historical) {
    mergedById.set(semanticMergeKey(step), step);
  }
  for (const step of live) {
    mergedById.set(semanticMergeKey(step), step);
  }
  const indexed = Array.from(mergedById.values()).map((step, index) => ({ step, index }));
  indexed.sort((a, b) => {
    const seqA = a.step.eventSeq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.step.eventSeq ?? Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.step);
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
  const [isFetchingThread, setIsFetchingThread] = useState(false);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const streamAttachedRef = useRef(false);
  const fetchInFlightRef = useRef(0);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const transport = useMemo(() => new AgentThreadTransport(threadKey), [threadKey]);

  const chat = useChat({
    id: `thread-${threadKey}`,
    transport,
    // Don't auto-resume — we control when to connect based on thread state
    resume: false,
    experimental_throttle: 80,
    dataPartSchemas: {
      "agent-status": z.object({ text: z.string() }),
      "phase-progress": z.object({
        phase: z.string(),
        turn_id: z.number(),
        event_seq: z.number().nullable().optional(),
      }),
      "file-changes": z.object({
        changes: z.array(z.object({ path: z.string(), kind: z.string() })),
        event_seq: z.number().nullable().optional(),
      }),
      "shell-command": z.object({
        command: z.string(),
        output: z.unknown().optional(),
        exitCode: z.number().nullable().optional(),
        status: z.string().nullable().optional(),
        event_seq: z.number().nullable().optional(),
      }),
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
        event_seq: z.number().nullable().optional(),
      }),
      "user-message": z.object({
        id: z.string(),
        turn_id: z.number(),
        text: z.string(),
        source: z.string().optional(),
        user_id: z.string().nullable().optional(),
        created_at: z.string().optional(),
        event_seq: z.number().nullable().optional(),
      }),
      "context-message": z.object({
        id: z.string(),
        turn_id: z.number(),
        text: z.string(),
        source: z.string().optional(),
        user_id: z.string().nullable().optional(),
        created_at: z.string().optional(),
        event_seq: z.number().nullable().optional(),
      }),
      "system-event": z.object({
        title: z.string(),
        text: z.string(),
        tone: z.enum(["info", "warn"]).optional(),
        event_seq: z.number().nullable().optional(),
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
            const participants = Array.isArray(data.participants)
              ? data.participants
              : prev?.participants ?? [];
            return { participants, ...data } as unknown as ThreadDetail;
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
      setThread(data as ThreadDetail);
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
    setThread(
      initialThread
        ? ({ turns: [], participants: [], ...initialThread } as ThreadDetail)
        : null,
    );
    setError(null);
    setAgentStatus(null);
    setTokenUsage(null);
    streamAttachedRef.current = false;
    setReconnectExhausted(false);

    // Fetch full thread from Postgres, then decide on SSE.
    // For freshly created ui: threads the session may not exist yet — retry briefly.
    void (async () => {
      const ok = await fetchThread();
      if (!ok && threadKey.startsWith("ui:")) {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (await fetchThread()) break;
        }
      }
    })();
  }, [threadKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Steps from Postgres turns (historical data)
  const historicalSteps = useMemo(
    () => (thread?.turns?.length ? stepsFromTurns(thread.turns) : []),
    [thread?.turns],
  );

  // Steps from live SSE stream (only populated when connected)
  const liveStreamSteps = useMemo(() => stepsFromUiMessages(chat.messages), [chat.messages]);

  const shouldPreferLiveSteps = useMemo(() => {
    if (liveStreamSteps.length === 0) return false;
    const historicalMax = maxStepSequence(historicalSteps);
    if (historicalMax === undefined) return true;
    const liveMax = maxStepSequence(liveStreamSteps);
    if (liveMax === undefined) return liveStreamSteps.length >= historicalSteps.length;
    return liveMax >= historicalMax;
  }, [historicalSteps, liveStreamSteps]);

  // Merge: prefer live stream only once replay catches up.
  const steps: Step[] = useMemo(() => {
    if (shouldPreferLiveSteps) {
      return mergeStepsPreferLive(historicalSteps, liveStreamSteps);
    }
    return historicalSteps;
  }, [historicalSteps, liveStreamSteps, shouldPreferLiveSteps]);

  const derivedTokenUsage = useMemo(() => {
    if (tokenUsage) return tokenUsage;
    return deriveUsageFromTurns(thread?.turns);
  }, [thread?.turns, tokenUsage]);

  return {
    thread,
    error,
    fetchThread,
    isReconnecting: chat.status === "error" && isActiveState(thread?.state),
    agentStatus,
    tokenUsage: derivedTokenUsage,
    isFetchingThread,
    chatStatus: chat.status,
    sendThreadMessage,
    liveSteps: steps,
  };
}
