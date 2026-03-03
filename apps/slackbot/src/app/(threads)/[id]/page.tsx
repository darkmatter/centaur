"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { ActivityFeed } from "@/components/thread/activity-feed";
import { MessageInput } from "@/components/thread/message-input";
import { QuickActionChips } from "@/components/thread/quick-action-chips";
import { ConnectivityBanner } from "@/components/thread/connectivity-banner";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { ThreadDetailHeader } from "@/components/thread/thread-detail-header";
import { useThreadLayout } from "@/components/thread/thread-layout";
import { threadName } from "@/lib/thread-name";
import { useThreadStream } from "@/hooks/use-thread-stream";
import { useElapsed } from "@/hooks/use-elapsed";
import { useStableStatus } from "@/hooks/use-stable-status";
import { BASE } from "@/lib/constants";
import { toast } from "sonner";
import { useThreadList } from "@/hooks/use-thread-list";
import {
  entrySourceLabel,
  listQueryFromSearchParams,
  listHrefWithAnchor,
  parseEntryAnchor,
  parseEntrySource,
  detailHrefWithEntrySource,
} from "@/lib/thread-navigation";

const ThreadInfoSheet = dynamic(
  () => import("@/components/thread/thread-info-sheet").then((module) => module.ThreadInfoSheet),
  { ssr: false },
);
const CommandPalette = dynamic(
  () => import("@/components/thread/command-palette").then((module) => module.CommandPalette),
  { ssr: false },
);

export default function ThreadDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { openMobileSidebar, closeMobileSidebar, mobileSidebarOpen } = useThreadLayout();
  const rawThreadKey = typeof params.id === "string" ? params.id : "";
  const threadKey = useMemo(() => {
    try {
      return decodeURIComponent(rawThreadKey);
    } catch {
      return rawThreadKey;
    }
  }, [rawThreadKey]);
  const {
    thread,
    error,
    fetchThread,
    isReconnecting,
    agentStatus,
    tokenUsage,
    isFetchingThread,
    chatStatus,
    sendThreadMessage,
    liveSteps,
  } = useThreadStream(threadKey);
  const humanName = thread?.thread_name || threadName(threadKey);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const sendEpochRef = useRef(0);
  const { threads } = useThreadList();
  const closeInfoSheet = useCallback(() => setInfoOpen(false), []);
  const entrySource = parseEntrySource(searchParams.get("entry_source"));
  const entryAnchor = parseEntryAnchor(searchParams.get("entry_anchor"));
  const sourceLabel = entrySourceLabel(entrySource);
  const listQuery = listQueryFromSearchParams(new URLSearchParams(searchParams.toString()));
  const upHref = listQuery ? `/?${listQuery}` : "/";
  const backHref = listHrefWithAnchor(listQuery, entryAnchor);
  const isEngineer = thread?.harness === "engineer";
  const isRunning =
    thread?.state === "running" || thread?.state === "working" || thread?.state === "stopping";
  const isStreaming = chatStatus === "submitted" || chatStatus === "streaming";
  const canInterrupt =
    !!thread && !isEngineer && (thread.state === "running" || thread.state === "working");
  const activeTurnStartedAt =
    thread && thread.turns.length > 0 ? thread.turns[thread.turns.length - 1]?.started_at : null;
  const elapsedAnchor = isRunning ? activeTurnStartedAt : thread?.last_activity;
  const liveElapsed = useElapsed(elapsedAnchor, Boolean(isRunning));
  const stableStatus = useStableStatus(agentStatus);
  const tokenTicker = tokenUsage
    ? `${tokenUsage.total_tokens.toLocaleString()} tok / ${
        tokenUsage.cost_usd === null ? "--" : `$${tokenUsage.cost_usd.toFixed(4)}`
      }${tokenUsage.estimated ? "~" : ""}`
    : "-- tok / --";
  const phases = liveSteps.flatMap((step) => (step.type === "phase" ? [step.phase] : []));
  const turnDurationsById = useMemo(() => {
    if (!thread) return {};
    return Object.fromEntries(thread.turns.map((turn) => [turn.turn_id, turn.duration_s]));
  }, [thread]);
  const latestUserMessage = thread?.turns[thread.turns.length - 1]?.user_message?.trim() ?? "";
  const retryMessage = latestUserMessage || "Please retry the previous request.";
  const slackDeepLink = useMemo(() => {
    if (!thread?.slack_thread_key?.startsWith("slack:")) return null;
    const [channel, ts] = thread.slack_thread_key.replace(/^slack:/, "").split(":");
    if (!channel || !ts) return null;
    return `slack://app_redirect?channel=${encodeURIComponent(channel)}&thread_ts=${encodeURIComponent(ts)}`;
  }, [thread?.slack_thread_key]);

  useEffect(() => {
    sendEpochRef.current += 1;
    return () => {
      sendEpochRef.current += 1;
    };
  }, [threadKey]);

  const inputMode = isRunning
    ? ("running" as const)
    : thread?.state === "error"
      ? ("error" as const)
      : ("idle" as const);

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
      const route = "execute" as const;
      const threadState = thread?.state;
      const runInFlight =
        threadState === "running" || threadState === "working" || threadState === "stopping";
      if (route === "execute" && runInFlight && !isEngineer) {
        if (threadState === "running" || threadState === "working") {
          const interrupted = await interruptRun();
          if (!interrupted) {
            throw new Error("Failed to stop in-flight run before sending message.");
          }
        }
        // Wait briefly for backend state transition to avoid "run already in progress" race.
        let clearToSend = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (sendEpochRef.current !== sendEpoch) {
            return;
          }
          try {
            const res = await fetch(`${BASE}/api/threads/detail?key=${encodeURIComponent(threadKey)}`);
            if (res.ok) {
              const data = (await res.json()) as { state?: string };
              const currentState = String(data.state ?? "");
              if (
                currentState !== "running" &&
                currentState !== "working" &&
                currentState !== "stopping"
              ) {
                clearToSend = true;
                break;
              }
            }
          } catch {
            // Keep polling through transient network errors.
          }
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        }
        if (!clearToSend) {
          throw new Error("Run is still stopping. Please retry sending in a moment.");
        }
      }
      if (sendEpochRef.current !== sendEpoch) {
        return;
      }
      await sendThreadMessage(text, route);
    },
    [interruptRun, sendThreadMessage, thread?.state, threadKey],
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

  const handleBackToSource = useCallback(() => {
    if (entrySource === "direct" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(backHref, { scroll: false });
  }, [backHref, entrySource, router]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetIsInput =
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable='true']");

      if (e.key === "Escape") {
        if (paletteOpen) {
          e.preventDefault();
          setPaletteOpen(false);
          return;
        }
        if (infoOpen) {
          e.preventDefault();
          setInfoOpen(false);
          return;
        }
        if (mobileSidebarOpen) {
          e.preventDefault();
          closeMobileSidebar();
          return;
        }
        if (targetIsInput) {
          (e.target as HTMLElement | null)?.blur?.();
          return;
        }
        e.preventDefault();
        handleBackToSource();
        return;
      }

      if (targetIsInput) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        setCompactMode((value) => !value);
        return;
      }

      if (e.shiftKey && e.key === "?") {
        e.preventDefault();
        toast("Shortcuts: Cmd/Ctrl+K, R, S, Esc, Cmd+., Shift+?");
        return;
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        fetchThread();
        return;
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "s" && canInterrupt) {
        e.preventDefault();
        void interruptRun();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    canInterrupt,
    closeMobileSidebar,
    fetchThread,
    infoOpen,
    interruptRun,
    mobileSidebarOpen,
    paletteOpen,
    handleBackToSource,
  ]);

  useEffect(() => {
    if (!thread) return;
    const previousTitle = document.title;
    if (thread.state === "working" || thread.state === "running") {
      document.title = `Working - ${humanName}`;
    } else if (thread.state === "error") {
      document.title = `Error - ${humanName}`;
    } else {
      document.title = `Done - ${humanName}`;
    }
    return () => {
      document.title = previousTitle;
    };
  }, [humanName, thread]);

  if (error && !thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-destructive text-sm mb-4">{error}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                void fetchThread();
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer bg-transparent border border-border rounded-sm px-3 py-1"
            >
              Retry
            </button>
            <Link
              href={backHref}
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
          <p className="text-muted-foreground text-sm inline-flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin text-primary" />
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
        isEngineer={isEngineer}
        phases={phases}
        isReconnecting={isReconnecting}
        error={error}
        interruptError={interruptError}
        canInterrupt={canInterrupt}
        isInterrupting={isInterrupting}
        onInterrupt={() => void interruptRun()}
        onRefresh={() => void fetchThread()}
        onOpenInfo={() => setInfoOpen(true)}
        onOpenDrawer={openMobileSidebar}
        sourceLabel={sourceLabel}
        onBack={handleBackToSource}
        upHref={upHref}
      />

      <ConnectivityBanner isReconnecting={isReconnecting} threadState={thread.state} />

      {/* Activity feed - the only scrollable area */}
      <div className="flex-1 min-h-0 max-w-[960px] mx-auto w-full flex flex-col">
        <ActivityFeed
          steps={liveSteps}
          state={thread.state}
          isStreaming={isStreaming}
          participants={thread.participants}
          turnDurationsById={turnDurationsById}
          compactMode={compactMode}
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

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        threads={threads}
        currentThreadKey={threadKey}
        compactMode={compactMode}
        canInterrupt={canInterrupt}
        isRefreshing={isFetchingThread}
        onNavigate={(nextThreadKey) =>
          router.push(
            detailHrefWithEntrySource(nextThreadKey, {
              source: entrySource,
              listQuery,
              anchor: nextThreadKey,
            }),
            { scroll: false },
          )
        }
        onRefresh={() => void fetchThread()}
        onStop={() => void interruptRun()}
        onCopyUrl={() => {
          navigator.clipboard
            ?.writeText(window.location.href)
            .then(() => toast("Copied link"))
            .catch(() => {});
        }}
        onToggleCompact={() => setCompactMode((value) => !value)}
        onOpenSlack={slackDeepLink
          ? () => {
              window.open(slackDeepLink, "_blank");
            }
          : null}
        onOpenShortcuts={() => toast("Shortcuts: Cmd/Ctrl+K, R, S, Esc, Cmd+., Shift+?")}
      />
    </div>
  );
}
