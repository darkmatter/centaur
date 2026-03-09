"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleStop,
  Copy,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { OverlayBackdrop } from "@/components/ui/overlay-backdrop";
import { SheetAction } from "@/components/ui/sheet-action";
import { StateDot } from "@/components/ui/state-dot";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import { cn } from "@/lib/utils";
import {
  tokenUsageBreakdownLabel,
  formatTokenUsageCost,
  formatTokenUsageCount,
  tokenUsageConfidenceLabel,
  tokenUsageModelsList,
} from "@/lib/token-usage";
import type { ThreadDetail, ThreadTokenUsage } from "@/lib/types";

type ThreadInfoSheetProps = {
  open: boolean;
  onClose: () => void;
  thread: ThreadDetail;
  tokenUsage: ThreadTokenUsage | null;
  elapsed: string;
  onRefresh: () => void;
  onStop?: () => void;
  canStop: boolean;
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
  );
  return Array.from(candidates).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0);
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-mono tabular-nums text-foreground mt-0.5">{children}</dd>
    </div>
  );
}

export function ThreadInfoSheet({
  open,
  onClose,
  thread,
  tokenUsage,
  elapsed,
  onRefresh,
  onStop,
  canStop,
}: ThreadInfoSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const dragRafRef = useRef<number>(0);
  const dragPendingRef = useRef(0);
  const draggingRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const touchY = e.touches[0].clientY;
    const fromTop = touchY - sheet.getBoundingClientRect().top;
    if (sheet.scrollTop > 0 || fromTop > 80) {
      dragStartRef.current = null;
      draggingRef.current = false;
      return;
    }
    dragStartRef.current = touchY;
    draggingRef.current = true;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartRef.current === null || !draggingRef.current) return;
    const delta = e.touches[0].clientY - dragStartRef.current;
    if (delta <= 0) return;
    e.preventDefault();
    dragPendingRef.current = delta;
    if (dragRafRef.current) return;
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = 0;
      setDragY(dragPendingRef.current);
    });
  }, []);

  const handleTouchEnd = useCallback(() => {
    const finalDragY = Math.max(dragY, dragPendingRef.current);
    if (dragRafRef.current) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    if (finalDragY > 100) {
      onClose();
    }
    setDragY(0);
    dragStartRef.current = null;
    dragPendingRef.current = 0;
    draggingRef.current = false;
  }, [dragY, onClose]);

  useEffect(() => {
    return () => {
      if (dragRafRef.current) {
        window.cancelAnimationFrame(dragRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      return;
    }
    const sheet = sheetRef.current;
    const previousFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (sheet) {
      const focusable = getFocusableElements(sheet);
      (focusable[0] ?? sheet).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (!sheet) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusableElements(sheet);
      if (focusable.length === 0) {
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !sheet.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !sheet.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocused?.focus();
    };
  }, [open, onClose]);
  const modelList = tokenUsageModelsList(tokenUsage);
  const breakdownLabel = tokenUsageBreakdownLabel(tokenUsage);
  const usageConfidence = tokenUsageConfidenceLabel(tokenUsage);

  const keyParts = thread.slack_thread_key.startsWith("slack:")
    ? thread.slack_thread_key.replace(/^slack:/, "").split(":")
    : [];
  const channelId = keyParts[0] ?? "";
  const threadTs = keyParts[1] ?? "";
  const slackUrl =
    channelId && threadTs
      ? `slack://app_redirect?channel=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}`
      : "";

  function copyLink() {
    if (typeof window === "undefined") return;
    if (!navigator.clipboard?.writeText) return;
    const viewerUrl = `${window.location.origin}/${encodeURIComponent(thread.slack_thread_key)}`;
    void navigator.clipboard
      .writeText(viewerUrl)
      .then(() => onClose())
      .catch(() => {});
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden" aria-modal="true" role="dialog" aria-label="Thread details">
      <OverlayBackdrop className="absolute inset-0 animate-in fade-in duration-base motion-reduce:animate-none" onClick={onClose} />
      <div
        ref={sheetRef}
        tabIndex={-1}
        className={cn(
          "absolute inset-x-0 bottom-0 max-h-dvh-82 overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border/80 bg-card shadow-sheet will-change-transform animate-in slide-in-from-bottom duration-slow ease-emphasized motion-reduce:animate-none",
          dragY > 0 ? "transition-none" : "transition-transform duration-slow ease-emphasized",
        )}
        style={{ transform: dragY > 0 ? `translateY(${dragY}px)` : undefined }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-8 h-1 bg-border rounded-full" />
        </div>

        <div className="px-4 sm:px-5 safe-area-bottom">
          <div className="flex items-center justify-between mt-2">
            <h2 className="text-lg font-semibold text-foreground">
              {thread.thread_name || thread.slack_thread_key}
            </h2>
            <Button
              variant="ghost"
              size="icon-lg"
              className="size-11 text-muted-foreground"
              onClick={onClose}
              aria-label="Close"
              data-touch-target
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <HarnessBadge harness={thread.harness} />
            <span>·</span>
            <StateDot state={thread.state} />
            <span>{thread.state}</span>
            <span>·</span>
            <span>{elapsed}</span>
          </div>

          <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-4 sm:gap-y-4">
            <Stat label="Total tokens">{formatTokenUsageCount(tokenUsage?.total_tokens ?? null)}</Stat>
            <Stat label="Tokens in">{formatTokenUsageCount(tokenUsage?.input_tokens ?? null)}</Stat>
            <Stat label="Tokens out">{formatTokenUsageCount(tokenUsage?.output_tokens ?? null)}</Stat>
            <Stat label="Cost">
              {formatTokenUsageCost(tokenUsage) ?? "--"}
            </Stat>
            <Stat label="Model">{modelList}</Stat>
            <Stat label="Usage">{usageConfidence}</Stat>
            <Stat label="Split">{breakdownLabel}</Stat>
            <Stat label="Messages">{thread.message_count}</Stat>
          </dl>

          {thread.participants && thread.participants.length > 0 && (
            <div className="mt-5 border-t border-border pt-4">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Participants</h3>
              <ParticipantAvatars participants={thread.participants} size={28} max={10} decorative={false} />
            </div>
          )}

          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Actions</h3>

            <SheetAction type="button" onClick={() => { onRefresh(); onClose(); }} data-touch-target>
              <RefreshCw className="size-5" />
              Refresh thread
            </SheetAction>

            {canStop && onStop && (
              <SheetAction type="button" variant="destructive" onClick={() => { onStop(); onClose(); }} data-touch-target>
                <CircleStop className="size-5" />
                Stop agent
              </SheetAction>
            )}

            <SheetAction type="button" onClick={copyLink} data-touch-target>
              <Copy className="size-5" />
              Copy link
            </SheetAction>

            {slackUrl ? (
              <SheetAction asChild data-touch-target>
                <a href={slackUrl}>
                  <ExternalLink className="size-5" />
                  Open in Slack
                </a>
              </SheetAction>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
