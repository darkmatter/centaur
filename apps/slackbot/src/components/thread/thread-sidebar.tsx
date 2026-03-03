"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { StateDot } from "@/components/ui/state-dot";
import { useElapsed } from "@/hooks/use-elapsed";
import { useThreadList } from "@/hooks/use-thread-list";
import { useThreadPresence } from "@/hooks/use-thread-presence";
import { PHASES, type ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { detailHrefWithEntrySource, nextListQueryString } from "@/lib/thread-navigation";
import { isRunningState } from "@/lib/thread-ordering";
import {
  getThreadDisplayName,
  parseActivePhase,
  runningSubtitle,
  type ThreadStatusFilter,
} from "@/lib/thread-selectors";
import { isTextInputTarget } from "@/lib/thread-utils";

export type ThreadSidebarHandle = {
  focusSearch: () => void;
  focusSidebar: () => void;
};

type ThreadSidebarProps = {
  selectedThreadKey: string | null;
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate?: () => void;
  showCollapseToggle?: boolean;
  active?: boolean;
};

function ThreadAge({ thread }: { thread: ThreadSummary }) {
  const elapsed = useElapsed(thread.last_activity, isRunningState(thread.state));
  return <span>{elapsed}</span>;
}

export const ThreadSidebar = forwardRef<ThreadSidebarHandle, ThreadSidebarProps>(function ThreadSidebar(
  {
    selectedThreadKey,
    collapsed,
    onCollapsedChange,
    onNavigate,
    showCollapseToggle = true,
    active = true,
  },
  ref,
) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [focusedThreadKey, setFocusedThreadKey] = useState<string | null>(null);
  const filterId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const cardRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const detailPrefetchAtRef = useRef<Record<string, number>>({});
  const initialQuery = searchParams.get("q") ?? "";
  const initialStatus = (searchParams.get("status") as ThreadStatusFilter | null) ?? "all";
  const {
    threads,
    filteredThreads: sortedThreads,
    counts,
    loading,
    isRefreshing,
    error,
    query,
    statusFilter,
    setQuery,
    setStatusFilter,
    refreshThreads,
  } = useThreadList({
    query: initialQuery,
    statusFilter: initialStatus,
  });
  const sidebarQueryString = useMemo(() => {
    return nextListQueryString(new URLSearchParams(searchParams.toString()), {
      query,
      status: statusFilter,
    });
  }, [query, searchParams, statusFilter]);
  const shouldSyncUrl = active && pathname !== "/";

  useEffect(() => {
    if (!shouldSyncUrl) return;
    if (searchParams.toString() === sidebarQueryString) return;
    const next = sidebarQueryString ? `${pathname}?${sidebarQueryString}` : pathname;
    router.replace(next, { scroll: false });
  }, [pathname, router, searchParams, shouldSyncUrl, sidebarQueryString]);

  useEffect(() => {
    if (sortedThreads.length === 0) {
      setFocusedThreadKey(null);
      return;
    }
    const hasFocused = focusedThreadKey
      ? sortedThreads.some((thread) => thread.slack_thread_key === focusedThreadKey)
      : false;
    if (selectedThreadKey && sortedThreads.some((thread) => thread.slack_thread_key === selectedThreadKey)) {
      setFocusedThreadKey(selectedThreadKey);
      return;
    }
    if (!hasFocused) {
      setFocusedThreadKey(sortedThreads[0].slack_thread_key);
    }
  }, [focusedThreadKey, selectedThreadKey, sortedThreads]);

  const presenceThreads = useMemo(
    () => (active && !collapsed ? sortedThreads.filter((thread) => isRunningState(thread.state)).slice(0, 8) : []),
    [active, collapsed, sortedThreads],
  );
  const { liveStatusByThread } = useThreadPresence(presenceThreads);

  const activeCount = useMemo(
    () => threads.filter((thread) => isRunningState(thread.state)).length,
    [threads],
  );

  const prefetchThread = useCallback(
    (threadKey: string) => {
      const baseHref = `/${encodeURIComponent(threadKey)}`;
      const href = sidebarQueryString ? `${baseHref}?${sidebarQueryString}` : baseHref;
      router.prefetch(href);

      const now = Date.now();
      const previousAt = detailPrefetchAtRef.current[threadKey] ?? 0;
      if (now - previousAt < 15000) return;
      detailPrefetchAtRef.current[threadKey] = now;
      router.prefetch(`/${encodeURIComponent(threadKey)}`);
    },
    [router, sidebarQueryString],
  );

  useEffect(() => {
    if (!active || sortedThreads.length === 0) return;
    sortedThreads.slice(0, 5).forEach((thread) => prefetchThread(thread.slack_thread_key));
  }, [active, prefetchThread, sortedThreads]);

  const openThread = useCallback(
    (threadKey: string) => {
      const href = detailHrefWithEntrySource(threadKey, {
        source: "threads",
        listQuery: sidebarQueryString,
        anchor: threadKey,
      });
      router.push(href);
      onNavigate?.();
    },
    [onNavigate, router, sidebarQueryString],
  );

  const focusThreadAt = useCallback(
    (nextIndex: number) => {
      const next = sortedThreads[nextIndex];
      if (!next) return;
      setFocusedThreadKey(next.slack_thread_key);
      const node = cardRefs.current[next.slack_thread_key];
      node?.focus();
      node?.scrollIntoView({ block: "nearest" });
    },
    [sortedThreads],
  );

  const handleListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextInputTarget(event.target)) return;
      if (sortedThreads.length === 0) return;

      const currentIndex = Math.max(
        0,
        sortedThreads.findIndex((thread) => thread.slack_thread_key === focusedThreadKey),
      );
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "j") {
        event.preventDefault();
        focusThreadAt(Math.min(currentIndex + 1, sortedThreads.length - 1));
        return;
      }
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusThreadAt(Math.max(currentIndex - 1, 0));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusThreadAt(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusThreadAt(sortedThreads.length - 1);
        return;
      }
      if (event.key === "Enter") {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target?.closest("[role='option']")) return;
        event.preventDefault();
        const current = sortedThreads[currentIndex];
        if (current) openThread(current.slack_thread_key);
      }
    },
    [focusThreadAt, focusedThreadKey, openThread, sortedThreads],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusSearch: () => {
        if (collapsed) {
          toggleRef.current?.focus();
          return;
        }
        searchRef.current?.focus();
      },
      focusSidebar: () => {
        if (collapsed) {
          toggleRef.current?.focus();
          return;
        }
        const selected =
          selectedThreadKey && cardRefs.current[selectedThreadKey]
            ? cardRefs.current[selectedThreadKey]
            : focusedThreadKey
              ? cardRefs.current[focusedThreadKey]
              : null;
        if (selected) {
          selected.focus();
          selected.scrollIntoView({ block: "nearest" });
          return;
        }
        searchRef.current?.focus();
      },
    }),
    [collapsed, focusedThreadKey, selectedThreadKey],
  );

  const canToggle = showCollapseToggle && Boolean(onCollapsedChange);

  if (collapsed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-end p-2">
        {canToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={toggleRef}
                type="button"
                onClick={() => onCollapsedChange?.(false)}
                aria-label="Expand sidebar"
                className="inline-flex size-8 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronRight className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Expand sidebar (Cmd+[)</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col" onKeyDown={handleListKeyDown}>
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">Threads</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {activeCount} active agent{activeCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refreshThreads()}
              disabled={isRefreshing || !active}
              className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60"
              aria-busy={isRefreshing}
            >
              <RefreshCw className={cn("size-3", isRefreshing ? "animate-spin" : "")} />
              {isRefreshing ? "..." : "Refresh"}
            </button>
            {canToggle ? (
              <button
                ref={toggleRef}
                type="button"
                onClick={() => onCollapsedChange?.(true)}
                aria-label="Collapse sidebar"
                className="inline-flex size-7 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronLeft className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-2">
          <label htmlFor={filterId} className="sr-only">
            Filter threads
          </label>
          <input
            ref={searchRef}
            id={filterId}
            name={filterId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter threads… (/)"
            autoComplete="off"
            className="h-8 w-full rounded-sm border border-input bg-card px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="mt-2 inline-flex w-full rounded-sm border border-border bg-card p-0.5 text-[11px]">
          {([
            { id: "all", label: `All ${counts.all}` },
            { id: "active", label: `Run ${counts.active}` },
            { id: "error", label: `Err ${counts.error}` },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStatusFilter(item.id)}
              aria-pressed={statusFilter === item.id}
              className={cn(
                "flex-1 rounded-[2px] px-1.5 py-1 text-center text-muted-foreground transition-colors",
                statusFilter === item.id && "bg-accent text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="thread-sidebar-list flex-1 min-h-0 overflow-y-auto px-2.5 py-2" role="listbox" aria-label="Thread list">
        {loading ? (
          <div className="space-y-2 py-1">
            {[0, 1, 2].map((index) => (
              <div key={index} className="rounded-sm border border-border bg-card px-2.5 py-2">
                <div className="h-3.5 w-5/6 rounded bg-secondary animate-pulse" />
                <div className="mt-1.5 h-3 w-2/3 rounded bg-secondary animate-pulse" />
                <div className="mt-1.5 h-3 w-4/5 rounded bg-secondary animate-pulse" />
              </div>
            ))}
          </div>
        ) : error && sortedThreads.length === 0 ? (
          <div className="space-y-2 py-8 text-center">
            <p className="text-xs text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void refreshThreads()}
              className="rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Retry
            </button>
          </div>
        ) : sortedThreads.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            No threads match your filter.
          </div>
        ) : (
          <div className="space-y-2">
            {sortedThreads.map((thread) => {
              const name = getThreadDisplayName(thread);
              const href = detailHrefWithEntrySource(thread.slack_thread_key, {
                source: "threads",
                listQuery: sidebarQueryString,
                anchor: thread.slack_thread_key,
              });
              const rawTask =
                thread.last_user_message || thread.first_message || thread.last_result || "";
              const taskPreview = rawTask.replace(/^\[[\w]+\]\s*/, "").replace(/\s+/g, " ").slice(0, 120);
              const activeState = isRunningState(thread.state);
              const statusSubtitle = liveStatusByThread[thread.slack_thread_key] ?? runningSubtitle(thread);
              const activePhase = parseActivePhase(thread);
              const phaseIndex = activePhase
                ? PHASES.indexOf(activePhase as (typeof PHASES)[number])
                : -1;
              const progress = phaseIndex >= 0 ? ((phaseIndex + 1) / PHASES.length) * 100 : 0;
              const isSelected = selectedThreadKey === thread.slack_thread_key;
              const isFocused = focusedThreadKey === thread.slack_thread_key;

              return (
                <Link
                  key={thread.slack_thread_key}
                  ref={(node) => {
                    cardRefs.current[thread.slack_thread_key] = node;
                  }}
                  href={href}
                  prefetch={false}
                  role="option"
                  aria-selected={isSelected}
                  aria-current={isSelected ? "page" : undefined}
                  tabIndex={isFocused ? 0 : -1}
                  onMouseEnter={() => prefetchThread(thread.slack_thread_key)}
                  onFocus={() => {
                    setFocusedThreadKey(thread.slack_thread_key);
                    prefetchThread(thread.slack_thread_key);
                  }}
                  onClick={() => {
                    setFocusedThreadKey(thread.slack_thread_key);
                    onNavigate?.();
                  }}
                  className={cn(
                    "thread-sidebar-card group block rounded-sm border border-border bg-card px-2.5 py-2 no-underline outline-none select-none transition-[transform,background-color,border-color] duration-180 ease-out hover:bg-accent/50 active:scale-[0.995] focus-visible:ring-1 focus-visible:ring-ring",
                    isSelected && "border-l-2 border-l-primary bg-accent",
                    activeState && "border-l-2 border-l-primary/70",
                  )}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <HarnessBadge harness={thread.harness} className="h-5 px-1.5 text-[9px]" />
                        <span className="truncate text-xs font-medium text-foreground">{name}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <span>
                          {thread.turn_count} turn{thread.turn_count === 1 ? "" : "s"}
                        </span>
                        <span>·</span>
                        <ThreadAge thread={thread} />
                        {thread.participants && thread.participants.length > 0 ? (
                          <>
                            <span>·</span>
                            <ParticipantAvatars participants={thread.participants} size={16} />
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <StateDot state={thread.state} className="size-2.5" />
                      <span>{thread.state}</span>
                    </div>
                  </div>

                  {statusSubtitle ? (
                    <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">{statusSubtitle}</div>
                  ) : null}
                  {taskPreview ? (
                    <>
                      <div className="mt-1 line-clamp-1 text-[11px] leading-relaxed text-muted-foreground/90">
                        {taskPreview}
                      </div>
                      <div className="hidden text-[11px] leading-relaxed text-muted-foreground/80 md:group-hover:line-clamp-2 md:group-hover:block">
                        {taskPreview}
                      </div>
                    </>
                  ) : null}
                  {activePhase ? <Progress value={progress} className="mt-2 h-0.5 bg-muted" /> : null}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
