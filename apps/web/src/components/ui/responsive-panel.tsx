"use client";

import type { ReactNode, Ref, TouchEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayBackdrop, OverlayPanel } from "@/motion/primitives";
import { cn } from "@/lib/utils";

type ResponsivePanelSide = "left" | "right" | "bottom";

export function ResponsivePanel({
  open,
  side,
  onClose,
  className,
  children,
  labelledBy,
  describedBy,
  panelRef,
  dismissibleByDrag = false,
  mobileOnly = false,
}: {
  open: boolean;
  side: ResponsivePanelSide;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  labelledBy?: string;
  describedBy?: string;
  panelRef?: Ref<HTMLDivElement>;
  dismissibleByDrag?: boolean;
  mobileOnly?: boolean;
}) {
  const internalPanelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusedRef = useRef<HTMLElement | null>(null);
  const dragStartRef = useRef<number | null>(null);
  const dragPendingRef = useRef(0);
  const dragRafRef = useRef<number>(0);
  const draggingRef = useRef(false);
  const [dragY, setDragY] = useState(0);

  const setCombinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalPanelRef.current = node;
      if (!panelRef) return;
      if (typeof panelRef === "function") {
        panelRef(node);
        return;
      }
      (panelRef as { current: HTMLDivElement | null }).current = node;
    },
    [panelRef],
  );

  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (side !== "bottom" || !dismissibleByDrag) return;
      const panel = internalPanelRef.current;
      if (!panel) return;
      const touchY = event.touches[0].clientY;
      const fromTop = touchY - panel.getBoundingClientRect().top;
      if (panel.scrollTop > 0 || fromTop > 80) {
        dragStartRef.current = null;
        draggingRef.current = false;
        return;
      }
      dragStartRef.current = touchY;
      draggingRef.current = true;
    },
    [dismissibleByDrag, side],
  );

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (dragStartRef.current === null || !draggingRef.current) return;
    const delta = event.touches[0].clientY - dragStartRef.current;
    if (delta <= 0) return;
    event.preventDefault();
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
    const panel = internalPanelRef.current;
    previousFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFirst = () => {
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])",
        ),
      ).filter((node) => !node.hasAttribute("disabled"));
      (focusable[0] ?? panel).focus();
    };

    window.requestAnimationFrame(focusFirst);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])",
        ),
      ).filter((node) => !node.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inside = !!(active && panel.contains(active));
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusedRef.current?.focus();
      previousFocusedRef.current = null;
      setDragY(0);
    };
  }, [onClose, open]);

  if (!open) return null;

  const preset = side === "bottom" ? "bottomSheet" : side === "left" ? "drawer" : "sidePanel";
  const panelClassName =
    side === "bottom"
      ? "absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto overscroll-contain rounded-t-[1.125rem] border-t border-border/80 thread-surface-overlay shadow-[0_-12px_36px_rgba(0,0,0,0.38)]"
      : side === "left"
        ? "absolute inset-y-0 left-0 flex w-[360px] max-w-[92vw] flex-col overflow-y-auto overscroll-contain border-r border-border/80 thread-surface-sidebar shadow-[0_24px_80px_rgba(0,0,0,0.6),inset_-1px_0_0_rgba(255,255,255,0.04)]"
        : "absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col overflow-y-auto overscroll-contain border-l border-border/80 thread-surface-overlay shadow-[0_24px_80px_rgba(0,0,0,0.55)]";

  return (
    <div className={cn("fixed inset-0 z-50", mobileOnly && "md:hidden")} aria-hidden={open ? undefined : true}>
      <OverlayBackdrop
        present={open}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <OverlayPanel
        present={open}
        preset={preset}
        panelRef={setCombinedRef}
        role="dialog"
        labelledBy={labelledBy}
        describedBy={describedBy}
        className={cn(panelClassName, className)}
        tabIndex={-1}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </OverlayPanel>
    </div>
  );
}
