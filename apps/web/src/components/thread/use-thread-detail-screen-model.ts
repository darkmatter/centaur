"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { UIMessage } from "ai";
import type { SubagentStep } from "@/lib/describe";
import { toast } from "sonner";
import { useThreadLayout } from "@/components/thread/thread-layout";
import { THREAD_SHORTCUTS_LABEL } from "@/components/thread/thread-ui-constants";
import { threadName } from "@/lib/viewer/thread-name";
import { useThreadStream } from "@/hooks/use-thread-stream";
import { useThreadDetailActions } from "@/hooks/use-thread-detail-actions";
import { useThreadDetailShortcuts } from "@/hooks/use-thread-detail-shortcuts";
import { useElapsed } from "@/hooks/use-elapsed";
import { useStableStatus } from "@/hooks/use-stable-status";
import { isActiveState, isRunningState } from "@/lib/viewer/thread-ordering";
import { asList, asRecord, asString } from "@/lib/parse-utils";
import { useThreadList } from "@/hooks/use-thread-list";
import { mergeSubagentStep, subagentSelectionKey } from "@/lib/viewer/subagent-steps";
import {
  detailHrefWithEntrySource,
  entrySourceLabel,
  listHrefWithAnchor,
  listQueryFromSearchParams,
  parseEntryAnchor,
  parseEntrySource,
} from "@/lib/viewer/thread-navigation";
import { BASE } from "@/lib/constants";

const TAIL_SIZE = 40;

function parseSubagentActivities(value: unknown): SubagentStep["activities"] {
  const activities = asList(value)
    .map((entry) => {
      const record = asRecord(entry);
      const description = asString(record.description).trim();
      if (!description) return null;
      const toolName = asString(record.toolName || record.tool_name).trim();
      return toolName ? { description, toolName } : { description };
    })
    .filter(
      (entry): entry is NonNullable<SubagentStep["activities"]>[number] =>
        entry !== null,
    );
  return activities.length > 0 ? activities : undefined;
}

export function useThreadDetailScreenModel(threadKey: string) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { openMobileSidebar, closeMobileSidebar, mobileSidebarOpen } = useThreadLayout();
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

  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [selectedSubagentKey, setSelectedSubagentKey] = useState<string | null>(null);
  const initialMessageSent = useRef(false);
  const { threads } = useThreadList();

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
    return () => {
      cancelled = true;
    };
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
      // Silently fail — user can scroll up again.
    } finally {
      setIsLoadingOlder(false);
    }
  }, [chatMessages, hasOlderMessages, isLoadingOlder, setMessages, threadKey]);

  useEffect(() => {
    const initialMessage = searchParams.get("initial_message");
    if (!initialMessage || initialMessageSent.current) return;
    initialMessageSent.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("initial_message");
    window.history.replaceState({}, "", url.pathname + url.search);
    void sendThreadMessage(initialMessage);
  }, [searchParams, sendThreadMessage]);

  const humanName = thread?.thread_name || threadName(threadKey);
  const closeInfoSheet = useCallback(() => setInfoOpen(false), []);
  const closeSubagentPanel = useCallback(() => {
    setSelectedSubagentKey(null);
  }, []);
  const setPaletteOpenExclusive = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setInfoOpen(false);
      setSelectedSubagentKey(null);
    }
    setPaletteOpen(nextOpen);
  }, []);
  const handleSelectSubagent = useCallback((step: SubagentStep) => {
    setInfoOpen(false);
    setPaletteOpen(false);
    setSelectedSubagentKey(subagentSelectionKey(step));
  }, []);

  useEffect(() => {
    setSelectedSubagentKey(null);
  }, [threadKey]);

  const entrySource = parseEntrySource(searchParams.get("entry_source"));
  const entryAnchor = parseEntryAnchor(searchParams.get("entry_anchor"));
  const sourceLabel = entrySourceLabel(entrySource);
  const listQuery = listQueryFromSearchParams(new URLSearchParams(searchParams.toString()));
  const upHref = listQuery ? `/?${listQuery}` : "/";
  const backHref = listHrefWithAnchor(listQuery, entryAnchor);
  const isEngineer = thread?.harness === "engineer" || thread?.harness === "eng";
  const isRunning = thread ? isActiveState(thread.state) : false;
  const isStreaming = chatStatus === "submitted" || chatStatus === "streaming";
  const canInterrupt = !!thread && !isEngineer && isRunningState(thread.state);
  const liveElapsed = useElapsed(thread?.last_activity ?? null, Boolean(isRunning));
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
  const subagentStepsByKey = useMemo(() => {
    const map = new Map<string, SubagentStep>();
    for (const msg of chatMessages) {
      for (const part of msg.parts ?? []) {
        const p = part as Record<string, unknown>;
        if (asString(p.type) !== "data-subagent") continue;
        const data = asRecord(p.data);
        const acceptableBoolean = typeof data.acceptable === "boolean" ? data.acceptable : undefined;
        const step: SubagentStep = {
          id: asString(data.subagent_id) || asString(p.id) || "subagent",
          type: "subagent",
          subagentId: asString(data.subagent_id) || undefined,
          status: asString(data.status) || "running",
          name: asString(data.name) || undefined,
          summary: asString(data.summary) || undefined,
          error: asString(data.error) || undefined,
          phase: asString(data.phase) || undefined,
          model: asString(data.model) || undefined,
          turns: typeof data.turns === "number" ? data.turns : undefined,
          toolCalls: typeof data.tool_calls === "number" ? data.tool_calls : undefined,
          durationS: typeof data.duration_s === "number" ? data.duration_s : undefined,
          inputTokens: typeof data.input_tokens === "number" ? data.input_tokens : undefined,
          outputTokens: typeof data.output_tokens === "number" ? data.output_tokens : undefined,
          totalTokens: typeof data.total_tokens === "number" ? data.total_tokens : undefined,
          costUsd: typeof data.cost_usd === "number" ? data.cost_usd : null,
          branchIndex: typeof data.branch_index === "number" ? data.branch_index : undefined,
          totalBranches: typeof data.total_branches === "number" ? data.total_branches : undefined,
          completed: typeof data.completed === "number" ? data.completed : undefined,
          acceptable: typeof data.acceptable === "number" ? data.acceptable : undefined,
          failed: typeof data.failed === "number" ? data.failed : undefined,
          completedCount: typeof data.completed_count === "number" ? data.completed_count : undefined,
          acceptableCount: typeof data.acceptable_count === "number" ? data.acceptable_count : undefined,
          failedCount: typeof data.failed_count === "number" ? data.failed_count : undefined,
          isAcceptable:
            typeof data.is_acceptable === "boolean"
              ? data.is_acceptable
              : acceptableBoolean,
          maxParallel: typeof data.max_parallel === "number" ? data.max_parallel : undefined,
          activity: asString(data.activity) || undefined,
          activities: parseSubagentActivities(data.activities),
        };
        const key = subagentSelectionKey(step);
        map.set(key, mergeSubagentStep(map.get(key), step));
      }
    }
    return map;
  }, [chatMessages]);
  const selectedSubagentSnapshot = selectedSubagentKey ? subagentStepsByKey.get(selectedSubagentKey) ?? null : null;
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

  const inputMode: "idle" | "running" | "error" = isRunning
    ? "running"
    : thread?.state === "error"
      ? "error"
      : "idle";

  const handleBackToSource = useCallback(() => {
    if (entrySource === "direct" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(backHref, { scroll: false });
  }, [backHref, entrySource, router]);

  useThreadDetailShortcuts({
    paletteOpen,
    setPaletteOpen: setPaletteOpenExclusive,
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
    if (!handoffTarget) return;
    toast("Agent handed off to new thread");
    router.push(`/${encodeURIComponent(handoffTarget)}`);
  }, [handoffTarget, router]);

  const openInfo = useCallback(() => {
    setPaletteOpen(false);
    setSelectedSubagentKey(null);
    setInfoOpen(true);
  }, []);
  const toggleCompactMode = useCallback(() => setCompactMode((value) => !value), []);
  const openShortcuts = useCallback(() => toast(THREAD_SHORTCUTS_LABEL), []);
  const navigateToThread = useCallback(
    (nextThreadKey: string) => {
      router.push(
        detailHrefWithEntrySource(nextThreadKey, {
          source: entrySource,
          listQuery,
          anchor: nextThreadKey,
        }),
        { scroll: false },
      );
    },
    [entrySource, listQuery, router],
  );

  return {
    thread,
    error,
    humanName,
    isFetchingThread,
    isReconnecting,
    isStreaming,
    isRunning,
    isEngineer,
    tokenUsage,
    liveElapsed,
    stableStatus,
    phases,
    inputMode,
    sourceLabel,
    upHref,
    backHref,
    slackDeepLink,
    compactMode,
    chatMessages,
    threads,
    canInterrupt,
    isInterrupting,
    interruptError,
    selectedSubagentKey,
    selectedSubagentSnapshot,
    paletteOpen,
    infoOpen,
    hasOlderMessages,
    isLoadingOlder,
    openMobileSidebar,
    openInfo,
    closeInfoSheet,
    closeSubagentPanel,
    setPaletteOpen: setPaletteOpenExclusive,
    fetchThread,
    handleBackToSource,
    handleSelectSubagent,
    handleSendMessage,
    handleStopAgent,
    handleQuickAction,
    interruptRun,
    loadOlderMessages,
    navigateToThread,
    toggleCompactMode,
    openShortcuts,
  };
}
