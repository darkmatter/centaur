"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { ActivityFeed } from "@/components/thread/activity-feed";
import { MessageInput } from "@/components/thread/message-input";
import { QuickActionChips } from "@/components/thread/quick-action-chips";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { ThreadInfoSheet } from "@/components/thread/thread-info-sheet";
import { ThreadSidebarDrawer } from "@/components/thread/thread-sidebar-drawer";
import { ThreadDetailHeader } from "@/components/thread/thread-detail-header";
import { threadName } from "@/lib/thread-name";
import { useThreadStream } from "@/hooks/use-thread-stream";
import { useElapsed } from "@/hooks/use-elapsed";
import { useStableStatus } from "@/hooks/use-stable-status";
import { BASE } from "@/lib/constants";
import type { ThreadSummary } from "@/lib/types";

export default function ThreadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const threadKey = decodeURIComponent(params.id as string);
  const [cachedSummary] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`thread:${threadKey}`);
      if (raw) {
        sessionStorage.removeItem(`thread:${threadKey}`);
        return JSON.parse(raw);
      }
    } catch {}
    return null;
  });
  const {
    thread,
    error,
    fetchThread,
    isReconnecting,
    agentStatus,
    tokenUsage,
    chatStatus,
    sendThreadMessage,
    liveSteps,
  } = useThreadStream(threadKey, cachedSummary);
  const humanName = thread?.thread_name || threadName(threadKey);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarThreads, setSidebarThreads] = useState<ThreadSummary[]>([]);
  const closeInfoSheet = useCallback(() => setInfoOpen(false), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const isRunning = thread?.state === "running" || thread?.state === "working";
  const isStreaming = chatStatus === "submitted" || chatStatus === "streaming";
  const canInterrupt = !!thread && isRunning;
  const activeTurnStartedAt =
    thread && thread.turns.length > 0 ? thread.turns[thread.turns.length - 1]?.started_at : null;
  const elapsedAnchor = isRunning ? activeTurnStartedAt : thread?.last_activity;
  const liveElapsed = useElapsed(elapsedAnchor, Boolean(isRunning));
  const stableStatus = useStableStatus(agentStatus);
  const tokenTicker = tokenUsage
    ? `${tokenUsage.total_tokens.toLocaleString()} tok / ${
        tokenUsage.cost_usd === null ? "--" : `$${tokenUsage.cost_usd.toFixed(4)}`
      }${tokenUsage.estimated ? "~" : ""}`
    : null;
  const phases = liveSteps.flatMap((step) => (step.type === "phase" ? [step.phase] : []));
  const latestUserMessage = thread?.turns[thread.turns.length - 1]?.user_message?.trim() ?? "";
  const retryMessage = latestUserMessage || "Please retry the previous request.";

  const inputMode = isRunning ? "running" as const
    : thread?.state === "error" ? "error" as const
    : "idle" as const;

  const interruptRun = useCallback(async (): Promise<boolean> => {
    if (!thread || !canInterrupt || isInterrupting) return false;
    setInterruptError(null);
    setIsInterrupting(true);
    try {
      const res = await fetch(`${BASE}/api/agent/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_thread_key: threadKey }),
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
      fetchThread();
      return true;
    } finally {
      setIsInterrupting(false);
    }
  }, [canInterrupt, fetchThread, isInterrupting, thread, threadKey]);

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (canInterrupt) {
        const interrupted = await interruptRun();
        if (!interrupted) return;
      }
      await sendThreadMessage(text, "execute");
    },
    [canInterrupt, interruptRun, sendThreadMessage],
  );

  const handleStopAgent = useCallback(async () => {
    await interruptRun();
  }, [interruptRun]);

  const handleQuickAction = useCallback((value: string) => {
    if (value === "stop") {
      void interruptRun();
    } else if (value === "retry") {
      void sendThreadMessage(retryMessage, "execute");
    } else if (value === "retry-context") {
      void sendThreadMessage(
        `${retryMessage}\n\nPlease retry with additional detail and include edge cases.`,
        "execute",
      );
    } else {
      void handleSendMessage(value);
    }
  }, [interruptRun, handleSendMessage, retryMessage, sendThreadMessage]);

  useEffect(() => {
    if (!drawerOpen) return;
    fetch(`${BASE}/api/threads`)
      .then((r: Response) => r.json())
      .then((data: { threads?: ThreadSummary[] }) => setSidebarThreads(data.threads ?? []))
      .catch(() => {});
  }, [drawerOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (infoOpen || drawerOpen) {
        return;
      }
      const targetIsInput =
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable='true']");

      if (e.key === "Escape") {
        if (targetIsInput) {
          (e.target as HTMLElement | null)?.blur?.();
          return;
        }
        e.preventDefault();
        router.push("/", { scroll: false });
        return;
      }

      if (targetIsInput) return;

      if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        fetchThread();
        return;
      }

      if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey && canInterrupt) {
        e.preventDefault();
        void interruptRun();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [canInterrupt, drawerOpen, fetchThread, infoOpen, interruptRun, router]);

  const threadState = thread?.state;
  useEffect(() => {
    if (!threadState) return;
    const previousTitle = document.title;
    if (threadState === "working" || threadState === "running") {
      document.title = `Working - ${humanName}`;
    } else if (threadState === "error") {
      document.title = `Error - ${humanName}`;
    } else {
      document.title = `Done - ${humanName}`;
    }
    return () => {
      document.title = previousTitle;
    };
  }, [humanName, threadState]);

  if (error && !thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p role="alert" className="text-destructive text-sm mb-4">{error}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={fetchThread}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer bg-transparent border border-border rounded-sm px-3 py-1"
            >
              Retry
            </button>
            <Link
              href="/"
              className="text-muted-foreground text-xs hover:text-foreground transition-colors rounded-sm"
            >
              Back to threads
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p role="status" className="text-muted-foreground text-sm inline-flex items-center gap-2">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-primary" />
            Connecting...
          </p>
          <p className="text-muted-foreground text-xs font-mono mt-2">{threadName(threadKey)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh md:h-full flex flex-col bg-background overflow-hidden">
      <ThreadDetailHeader
        thread={thread}
        humanName={humanName}
        tokenUsage={tokenUsage}
        tokenTicker={tokenTicker}
        liveElapsed={liveElapsed}
        stableStatus={stableStatus}
        isRunning={isRunning}
        isEng={thread?.harness === "eng" || thread?.harness === "engineer"}
        phases={phases}
        isReconnecting={isReconnecting}
        error={error}
        interruptError={interruptError}
        canInterrupt={canInterrupt}
        isInterrupting={isInterrupting}
        onInterrupt={() => void interruptRun()}
        onRefresh={() => void fetchThread()}
        onOpenInfo={() => setInfoOpen(true)}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      {/* Activity feed - the only scrollable area */}
      <div className="flex-1 min-h-0 max-w-[960px] mx-auto w-full flex flex-col">
        <ActivityFeed
          steps={liveSteps}
          state={thread.state}
          isStreaming={isStreaming}
          participants={thread.participants}
          chatStatus={chatStatus}
        />
      </div>

      {/* Quick action chips (mobile only) */}
      <QuickActionChips threadState={thread.state} onAction={handleQuickAction} />

      {/* Message input - always visible */}
      <MessageInput
        mode={inputMode}
        onSend={handleSendMessage}
        onStop={canInterrupt ? handleStopAgent : undefined}
      />

      {/* Mobile tab bar */}
      <MobileTabBar
        activeThreadHref={`/${encodeURIComponent(threadKey)}`}
        hasRunningAgent={isRunning}
        hasError={thread.state === "error"}
      />

      {/* Overlays */}
      {thread && (
        <ThreadInfoSheet
          open={infoOpen}
          onClose={closeInfoSheet}
          thread={thread}
          tokenUsage={tokenUsage}
          elapsed={liveElapsed}
          onRefresh={fetchThread}
          onStop={canInterrupt ? interruptRun : undefined}
          canStop={canInterrupt}
        />
      )}
      <ThreadSidebarDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        threads={sidebarThreads}
        activeKey={threadKey}
      />
    </div>
  );
}
