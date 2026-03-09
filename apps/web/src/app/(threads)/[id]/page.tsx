"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { UIMessage } from "ai";
import { LoaderCircle } from "lucide-react";
import { ActivityFeedV2 } from "@/components/thread/activity-feed-v2";
import { SubagentDetailPanel } from "@/components/thread/subagent-detail-panel";
import type { SubagentStep } from "@/lib/describe";
import { ThreadDetailTelemetry } from "@/components/thread/thread-detail-telemetry";

import { MessageInput } from "@/components/thread/message-input";
import { QuickActionChips } from "@/components/thread/quick-action-chips";
import { ConnectivityBanner } from "@/components/thread/connectivity-banner";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { ThreadDetailHeader } from "@/components/thread/thread-detail-header";
import { useThreadLayout } from "@/components/thread/thread-layout";
import { THREAD_SHORTCUTS_LABEL } from "@/components/thread/thread-ui-constants";
import { threadName } from "@/lib/viewer/thread-name";
import { useThreadStream } from "@/hooks/use-thread-stream";
import { useThreadDetailActions } from "@/hooks/use-thread-detail-actions";
import { useThreadDetailShortcuts } from "@/hooks/use-thread-detail-shortcuts";
import { useElapsed } from "@/hooks/use-elapsed";
import { useStableStatus } from "@/hooks/use-stable-status";
import { isActiveState, isRunningState } from "@/lib/viewer/thread-ordering";
import { asRecord, asString } from "@/lib/parse-utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useThreadList } from "@/hooks/use-thread-list";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { subagentSelectionKey } from "@/lib/viewer/subagent-steps";
import {
  entrySourceLabel,
  listQueryFromSearchParams,
  listHrefWithAnchor,
  parseEntryAnchor,
  parseEntrySource,
  detailHrefWithEntrySource,
} from "@/lib/viewer/thread-navigation";
import { BASE } from "@/lib/constants";

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
    chatMessages,
    setMessages,
    handoffTarget,
  } = useThreadStream(threadKey);

  // Tail-first loading: fetch the newest messages immediately, render the
  // bottom of the conversation, then lazy-load older messages on scroll-up.
  const TAIL_SIZE = 40;
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  useEffect(() => {
    if (!threadKey) return;
    let cancelled = false;
    setHasOlderMessages(false);
    void fetch(`${BASE}/api/messages?key=${encodeURIComponent(threadKey)}&limit=${TAIL_SIZE}`)
      .then((res) => (res.ok ? res.json() : { messages: [], has_more: false }))
      .then((data: { messages: UIMessage[]; has_more: boolean }) => {
        if (cancelled) return;
        if (data.messages.length > 0) {
          setMessages(data.messages);
        }
        setHasOlderMessages(data.has_more);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [threadKey, setMessages]);

  const loadOlderMessages = useCallback(async () => {
    if (isLoadingOlder || !hasOlderMessages || chatMessages.length === 0) return;
    const oldestId = chatMessages[0].id;
    setIsLoadingOlder(true);
    try {
      const res = await fetch(
        `${BASE}/api/messages?key=${encodeURIComponent(threadKey)}&limit=${TAIL_SIZE}&before=${encodeURIComponent(oldestId)}`,
      );
      if (!res.ok) return;
      const data: { messages: UIMessage[]; has_more: boolean } = await res.json();
      if (data.messages.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newMsgs = data.messages.filter((m) => !existingIds.has(m.id));
          return [...newMsgs, ...prev];
        });
      }
      setHasOlderMessages(data.has_more);
    } catch {
      // Silently fail — user can scroll up again
    } finally {
      setIsLoadingOlder(false);
    }
  }, [isLoadingOlder, hasOlderMessages, chatMessages, threadKey, setMessages]);

  // Auto-send initial message from new session page
  const initialMessageSent = useRef(false);
  useEffect(() => {
    const initialMessage = searchParams.get("initial_message");
    if (!initialMessage || initialMessageSent.current) return;
    initialMessageSent.current = true;
    // Clean up the URL
    const url = new URL(window.location.href);
    url.searchParams.delete("initial_message");
    window.history.replaceState({}, "", url.pathname + url.search);
    // Send the message
    void sendThreadMessage(decodeURIComponent(initialMessage));
  }, [searchParams, sendThreadMessage]);

  const humanName = thread?.thread_name || threadName(threadKey);
  const [infoOpen, setInfoOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [selectedSubagentKey, setSelectedSubagentKey] = useState<string | null>(null);
  const [selectedSubagentSnapshot, setSelectedSubagentSnapshot] = useState<SubagentStep | null>(null);
  const { threads } = useThreadList();
  const closeInfoSheet = useCallback(() => setInfoOpen(false), []);
  const closeSubagentPanel = useCallback(() => {
    setSelectedSubagentKey(null);
    setSelectedSubagentSnapshot(null);
  }, []);
  const handleSelectSubagent = useCallback(
    (step: SubagentStep) => {
      setSelectedSubagentKey(subagentSelectionKey(step));
      setSelectedSubagentSnapshot(step);
    },
    [],
  );
  useEffect(() => {
    setSelectedSubagentKey(null);
    setSelectedSubagentSnapshot(null);
  }, [threadKey]);
  const resolvedSelectedSubagent = selectedSubagentSnapshot;
  const entrySource = parseEntrySource(searchParams.get("entry_source"));
  const entryAnchor = parseEntryAnchor(searchParams.get("entry_anchor"));
  const sourceLabel = entrySourceLabel(entrySource);
  const listQuery = listQueryFromSearchParams(new URLSearchParams(searchParams.toString()));
  const upHref = listQuery ? `/?${listQuery}` : "/";
  const backHref = listHrefWithAnchor(listQuery, entryAnchor);
  const isEngineer = thread?.harness === "engineer";
  const isRunning = thread ? isActiveState(thread.state) : false;
  const isStreaming = chatStatus === "submitted" || chatStatus === "streaming";
  const canInterrupt = !!thread && !isEngineer && isRunningState(thread.state);
  const elapsedAnchor = thread?.last_activity ?? null;
  const liveElapsed = useElapsed(elapsedAnchor, Boolean(isRunning));
  const stableStatus = useStableStatus(agentStatus);
  const phases = useMemo(() => {
    const result: string[] = [];
    for (const msg of chatMessages) {
      for (const part of msg.parts ?? []) {
        const p = part as Record<string, unknown>;
        if (asString(p.type) === "data-phase-progress") {
          const phase = asString(asRecord(p.data).phase);
          if (phase) result.push(phase);
        }
      }
    }
    return result;
  }, [chatMessages]);
  const activePhase = phases.length > 0 ? phases[phases.length - 1] : null;
  const latestUserMessage = thread?.last_user_message?.trim() ?? "";
  const retryMessage = latestUserMessage || "Please retry the previous request.";
  const slackDeepLink = useMemo(() => {
    if (!thread?.slack_thread_key?.startsWith("slack:")) return null;
    const [channel, ts] = thread.slack_thread_key.replace(/^slack:/, "").split(":");
    if (!channel || !ts) return null;
    return `slack://app_redirect?channel=${encodeURIComponent(channel)}&thread_ts=${encodeURIComponent(ts)}`;
  }, [thread?.slack_thread_key]);
  const {
    isInterrupting,
    interruptError,
    interruptRun,
    handleSendMessage,
    handleStopAgent,
    handleQuickAction,
  } = useThreadDetailActions({
    thread,
    threadKey,
    isEngineer,
    canInterrupt,
    fetchThread,
    sendThreadMessage,
    retryMessage,
  });

  const inputMode = isRunning
    ? ("running" as const)
    : thread?.state === "error"
      ? ("error" as const)
      : ("idle" as const);

  const handleBackToSource = useCallback(() => {
    if (entrySource === "direct" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(backHref, { scroll: false });
  }, [backHref, entrySource, router]);
  useThreadDetailShortcuts({
    paletteOpen,
    setPaletteOpen,
    infoOpen,
    setInfoOpen,
    mobileSidebarOpen,
    closeMobileSidebar,
    handleBackToSource,
    fetchThread,
    canInterrupt,
    interruptRun,
    toggleCompactMode: () => setCompactMode((value) => !value),
  });

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

  useEffect(() => {
    if (handoffTarget) {
      toast("Agent handed off to new thread");
      router.push(`/${encodeURIComponent(handoffTarget)}`);
    }
  }, [handoffTarget, router]);

  if (error && !thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-destructive text-sm mb-4">{error}</p>
          <div className="flex items-center justify-center gap-3">
            <Button
              type="button"
              onClick={() => {
                void fetchThread();
              }}
              variant="outline"
              size="xs"
              className="border-border text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Retry
            </Button>
            <Link
              href={backHref}
              className="inline-flex min-h-touch items-center rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
              data-touch-target
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
            <Shimmer className="text-sm text-muted-foreground" duration={1.6}>
              Connecting...
            </Shimmer>
          </p>
          <p className="text-muted-foreground text-xs font-mono mt-2">{threadName(threadKey)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell h-dvh md:h-full flex flex-col bg-background overflow-hidden">
      <ThreadDetailHeader
        thread={thread}
        humanName={humanName}
        tokenUsage={tokenUsage}
        liveElapsed={liveElapsed}
        stableStatus={stableStatus}
        isRunning={isRunning}
        isEngineer={isEngineer}
        phases={phases}
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
      <div className="mx-auto flex min-h-0 w-full max-w-content-max flex-1 flex-col px-1 py-1 md:px-3 md:py-2.5">
        <ActivityFeedV2
          messages={chatMessages}
          state={thread.state}
          isStreaming={isStreaming}
          participants={thread.participants}
          compactMode={compactMode}
          onSelectSubagent={handleSelectSubagent}
          selectedSubagentKey={selectedSubagentKey}
          hasOlderMessages={hasOlderMessages}
          isLoadingOlder={isLoadingOlder}
          onLoadMore={loadOlderMessages}
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
      <SubagentDetailPanel
        step={resolvedSelectedSubagent}
        open={selectedSubagentKey !== null}
        onClose={closeSubagentPanel}
      />

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
        onOpenShortcuts={() => toast(THREAD_SHORTCUTS_LABEL)}
      />
    </div>
  );
}
