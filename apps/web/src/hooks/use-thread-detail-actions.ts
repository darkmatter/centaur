import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadDetail } from "@/lib/types";
import { BASE } from "@/lib/constants";

type SendRoute = "execute";

type UseThreadDetailActionsParams = {
  thread: ThreadDetail | null;
  threadKey: string;
  isEngineer: boolean;
  canInterrupt: boolean;
  fetchThread: () => Promise<boolean>;
  sendThreadMessage: (message: string, route: SendRoute) => Promise<void>;
  retryMessage: string;
};

type UseThreadDetailActionsResult = {
  isInterrupting: boolean;
  interruptError: string | null;
  interruptRun: () => Promise<boolean>;
  handleSendMessage: (text: string) => Promise<void>;
  handleStopAgent: () => Promise<void>;
  handleQuickAction: (value: string) => void;
};

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 150;

export function isRunInFlight(state: string | undefined): boolean {
  return state === "running" || state === "working" || state === "stopping";
}

export function buildRetryWithContextMessage(retryMessage: string): string {
  return `${retryMessage}\n\nPlease retry with additional detail and include edge cases.`;
}

export function useThreadDetailActions({
  thread,
  threadKey,
  isEngineer,
  canInterrupt,
  fetchThread,
  sendThreadMessage,
  retryMessage,
}: UseThreadDetailActionsParams): UseThreadDetailActionsResult {
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const sendEpochRef = useRef(0);

  useEffect(() => {
    sendEpochRef.current += 1;
    return () => {
      sendEpochRef.current += 1;
    };
  }, [threadKey]);

  const interruptRun = useCallback(async (): Promise<boolean> => {
    if (!thread || !canInterrupt || isInterrupting) return false;
    setInterruptError(null);
    setIsInterrupting(true);
    try {
      const res = await fetch(`${BASE}/api/agent/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_thread_key: threadKey }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const message =
          typeof data?.error === "string"
            ? data.error
            : `Interrupt failed${res.ok ? "" : ` (${res.status})`}.`;
        setInterruptError(message);
        return false;
      }
      await fetchThread();
      return true;
    } catch {
      setInterruptError("Interrupt failed due to a network error. Please retry.");
      return false;
    } finally {
      setIsInterrupting(false);
    }
  }, [canInterrupt, fetchThread, isInterrupting, thread, threadKey]);

  const handleSendMessage = useCallback(
    async (text: string) => {
      const sendEpoch = sendEpochRef.current;
      const route: SendRoute = "execute";
      const threadState = thread?.state;

      if (route === "execute" && isRunInFlight(threadState) && !isEngineer) {
        if (threadState === "running" || threadState === "working") {
          const interrupted = await interruptRun();
          if (!interrupted) {
            throw new Error("Failed to stop in-flight run before sending message.");
          }
        }

        // Wait briefly for backend state transition to avoid "run already in progress" race.
        let clearToSend = false;
        for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
          if (sendEpochRef.current !== sendEpoch) {
            return;
          }
          try {
            const res = await fetch(`${BASE}/api/threads/detail?key=${encodeURIComponent(threadKey)}`);
            if (res.ok) {
              const data = (await res.json()) as { state?: string };
              if (!isRunInFlight(String(data.state ?? ""))) {
                clearToSend = true;
                break;
              }
            }
          } catch {
            // Keep polling through transient network errors.
          }
          await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
        }

        if (!clearToSend) {
          throw new Error("Run is still stopping. Please retry sending in a moment.");
        }
      }

      if (sendEpochRef.current !== sendEpoch) return;
      await sendThreadMessage(text, route);
    },
    [interruptRun, isEngineer, sendThreadMessage, thread?.state, threadKey],
  );

  const handleStopAgent = useCallback(async () => {
    await interruptRun();
  }, [interruptRun]);

  const handleQuickAction = useCallback(
    (value: string) => {
      if (value === "stop") {
        void interruptRun();
      } else if (value === "retry") {
        void sendThreadMessage(retryMessage, "execute");
      } else if (value === "retry-context") {
        void sendThreadMessage(buildRetryWithContextMessage(retryMessage), "execute");
      } else {
        void handleSendMessage(value);
      }
    },
    [handleSendMessage, interruptRun, retryMessage, sendThreadMessage],
  );

  return {
    isInterrupting,
    interruptError,
    interruptRun,
    handleSendMessage,
    handleStopAgent,
    handleQuickAction,
  };
}
