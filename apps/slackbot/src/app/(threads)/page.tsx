"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle, MessageSquare, RefreshCw } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { ThreadSummary } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { BASE } from "@/lib/constants";
import { threadName } from "@/lib/thread-name";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { StateDot } from "@/components/ui/state-dot";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { Progress } from "@/components/ui/progress";
import { PHASES } from "@/lib/types";
import { useElapsed } from "@/hooks/use-elapsed";
import { useLiveThreadStatus } from "@/hooks/use-live-thread-status";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";

function parsePhaseFromMessage(message: string | undefined): string | null {
  const text = message ?? "";
  const match = text.match(/^\[([^\]]+)\]/);
  return match ? match[1].trim().toLowerCase() : null;
}

function parseActivePhase(thread: ThreadSummary): string | null {
  return parsePhaseFromMessage(thread.last_user_message) ?? parsePhaseFromMessage(thread.first_message);
}

function ThreadAge({ thread }: { thread: ThreadSummary }) {
  const isRunning = thread.state === "working" || thread.state === "running";
  const elapsed = useElapsed(thread.last_activity, isRunning);
  return <span>{isRunning ? elapsed : timeAgo(thread.last_activity)}</span>;
}

function runningSubtitle(thread: ThreadSummary): string | null {
  if (thread.state !== "working" && thread.state !== "running") return null;
  const phase = parseActivePhase(thread);
  if (phase) return `Working on ${phase}...`;
  return "Working...";
}

export default function ThreadsPage() {
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "running" | "error">("all");
  const searchRef = useRef<HTMLInputElement>(null);

  async function fetchThreads(showRefreshIndicator = true) {
    if (showRefreshIndicator) setIsRefreshing(true);
    try {
      const res = await fetch(`${BASE}/api/threads`);
      if (!res.ok) {
        throw new Error(`threads fetch failed: ${res.status}`);
      }
      const data = await res.json();
      setThreads(data.threads || []);
      setError(null);
    } catch {
      setError("Unable to load threads.");
    } finally {
      setLoading(false);
      if (showRefreshIndicator) setIsRefreshing(false);
    }
  }

  // Only fetch on mobile — desktop uses the sidebar's own fetch
  useEffect(() => {
    if (isDesktop) {
      setLoading(false);
      return;
    }
    void fetchThreads(false);
    const interval = setInterval(() => void fetchThreads(false), 5000);
    return () => clearInterval(interval);
  }, [isDesktop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const searchedThreads = useMemo(() => {
    return threads.filter((thread) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      const haystack = `${thread.thread_name ?? ""} ${thread.first_message ?? ""} ${thread.last_result ?? ""} ${
        thread.slack_thread_key
      }`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, threads]);

  const counts = useMemo(
    () => ({
      all: searchedThreads.length,
      running: searchedThreads.filter((thread) => thread.state === "working" || thread.state === "running").length,
      error: searchedThreads.filter((thread) => thread.state === "error").length,
    }),
    [searchedThreads],
  );

  const sortedThreads = useMemo(() => {
    const filtered = searchedThreads.filter((thread) => {
      if (stateFilter === "all") return true;
      if (stateFilter === "running") return thread.state === "working" || thread.state === "running";
      return thread.state === stateFilter;
    });

    return [...filtered].sort((a, b) => {
      const aActive = a.state === "working" || a.state === "running" ? 1 : 0;
      const bActive = b.state === "working" || b.state === "running" ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.last_activity ?? 0) - (a.last_activity ?? 0);
    });
  }, [searchedThreads, stateFilter]);
  const activeThreadKeys = useMemo(
    () =>
      sortedThreads
        .filter((thread) => thread.state === "working" || thread.state === "running")
        .slice(0, 8)
        .map((thread) => thread.slack_thread_key),
    [sortedThreads],
  );
  const liveStatusByThread = useLiveThreadStatus(activeThreadKeys);
  const activeCount = useMemo(
    () => threads.filter((thread) => thread.state === "working" || thread.state === "running").length,
    [threads],
  );
  const activeThreadHref = useMemo(() => {
    const byRecent = (a: ThreadSummary, b: ThreadSummary) =>
      (b.last_activity ?? 0) - (a.last_activity ?? 0);
    const running = [...threads]
      .filter((thread) => thread.state === "working" || thread.state === "running")
      .sort(byRecent)[0];
    const recent = [...threads].sort(byRecent)[0];
    const candidate = running ?? recent;
    return candidate ? `/${encodeURIComponent(candidate.slack_thread_key)}` : undefined;
  }, [threads]);

  return (
    <div className="h-full flex flex-col bg-background text-foreground font-sans overflow-hidden">
    {/* Desktop placeholder — sidebar already shows the thread list */}
    <div className="hidden md:flex flex-1 items-center justify-center">
      <div className="text-center">
        <MessageSquare className="size-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">Select a thread from the sidebar to get started</p>
      </div>
    </div>
    {/* Mobile thread list — sidebar is hidden on mobile */}
    <div
      data-thread-list-scroll="true"
      className="md:hidden flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 max-w-[1200px] mx-auto w-full"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
        <div>
          <h1 className="text-base font-semibold text-foreground tracking-tight">
            Threads
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {`${activeCount} active agent${activeCount !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchThreads(true)}
          disabled={isRefreshing}
          aria-busy={isRefreshing}
          className="inline-flex items-center gap-1.5 bg-transparent border border-border rounded-sm text-muted-foreground px-3 py-1 text-xs font-medium cursor-pointer hover:text-foreground transition-colors disabled:opacity-60 disabled:cursor-default"
        >
          <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="mb-4">
        <label htmlFor="thread-filter" className="sr-only">
          Filter threads
        </label>
        <input
          id="thread-filter"
          name="thread-filter"
          aria-label="Filter threads"
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter threads… (/)"
          autoComplete="off"
          className="w-full max-w-[420px] bg-card border border-input rounded-sm px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="mb-4 overflow-x-auto">
        <div className="inline-flex items-center gap-2 min-w-max">
          <button
            type="button"
            onClick={() => setStateFilter("all")}
            className={`rounded-full px-3 min-h-[36px] text-xs font-medium border transition-colors ${
              stateFilter === "all"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary text-secondary-foreground border-border/50"
            }`}
          >
            All {counts.all}
          </button>
          <button
            type="button"
            onClick={() => setStateFilter("running")}
            className={`rounded-full px-3 min-h-[36px] text-xs font-medium border transition-colors ${
              stateFilter === "running"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary text-secondary-foreground border-border/50"
            }`}
          >
            Running {counts.running}
          </button>
          <button
            type="button"
            onClick={() => setStateFilter("error")}
            className={`rounded-full px-3 min-h-[36px] text-xs font-medium border transition-colors ${
              stateFilter === "error"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary text-secondary-foreground border-border/50"
            }`}
          >
            Error {counts.error}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-center py-16 text-sm inline-flex items-center justify-center gap-2 w-full">
          <LoaderCircle className="size-4 animate-spin text-primary" />
          Loading…
        </div>
      ) : error && sortedThreads.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-destructive text-sm mb-3">{error}</p>
          <button
            type="button"
            onClick={() => void fetchThreads(true)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer bg-transparent border border-border rounded-sm px-3 py-1"
          >
            Retry
          </button>
        </div>
      ) : sortedThreads.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-muted-foreground text-sm font-medium mb-1">
            No threads match this filter
          </p>
          <p className="text-muted-foreground text-xs">
            Mention @AI2 in a Slack thread to start one
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:grid md:grid-cols-[repeat(auto-fill,minmax(360px,1fr))] md:gap-2.5">
          {sortedThreads.map((t) => {
            const name = t.thread_name || threadName(t.slack_thread_key);
            const href = `/${encodeURIComponent(t.slack_thread_key)}`;
            const rawTask = t.first_message || t.last_result || "";
            const taskPreview = rawTask.replace(/^\[[\w]+\]\s*/, "").slice(0, 100);
            const isActive = t.state === "working" || t.state === "running";
            const activePhase = parseActivePhase(t);
            const statusSubtitle = liveStatusByThread[t.slack_thread_key] ?? runningSubtitle(t);
            const phaseIndex = activePhase ? PHASES.indexOf(activePhase as (typeof PHASES)[number]) : -1;
            const progress = phaseIndex >= 0 ? ((phaseIndex + 1) / PHASES.length) * 100 : 0;

            return (
              <Link
                key={t.slack_thread_key}
                href={href}
                prefetch={false}
                scroll={false}
                onMouseEnter={() => router.prefetch(href)}
                aria-label={`View thread ${name}, ${t.state}, ${t.turn_count} turns`}
                className={`block bg-card border border-border rounded-sm p-4 no-underline text-inherit hover:bg-accent transition-colors ${
                  isActive ? "border-l-2 border-l-primary" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <HarnessBadge harness={t.harness} />
                    <span className="text-sm text-foreground font-medium truncate">
                      {name}
                    </span>
                    <ParticipantAvatars participants={t.participants} size={20} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StateDot state={t.state} />
                    <span className="text-[11px] text-muted-foreground">
                      {t.state}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
                  <span>
                    {t.turn_count} turn{t.turn_count !== 1 ? "s" : ""}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <ThreadAge thread={t} />
                </div>
                {statusSubtitle ? (
                  <div className="text-xs text-muted-foreground mb-1.5">{statusSubtitle}</div>
                ) : null}

                {taskPreview && (
                  <div className="text-xs text-muted-foreground leading-relaxed line-clamp-1 mt-1">
                    {taskPreview}
                  </div>
                )}
                {isActive && activePhase ? <Progress value={progress} className="h-0.5 mt-3 bg-muted" /> : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
    <MobileTabBar
      activeThreadHref={activeThreadHref}
      hasRunningAgent={activeCount > 0}
      hasError={threads.some((t) => t.state === "error")}
    />
    </div>
  );
}
