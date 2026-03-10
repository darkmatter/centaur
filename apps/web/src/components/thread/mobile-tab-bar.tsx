"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutList, Zap } from "lucide-react";
import { useHaptics } from "@/components/haptics-provider";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { SurfaceBar } from "@/components/ui/surface-bar";
import { cn } from "@/lib/utils";
import { useKeyboardHeight } from "@/hooks/use-visual-viewport";

type MobileTabBarProps = {
  activeThreadHref?: string;
  hasRunningAgent?: boolean;
  hasError?: boolean;
};

export function MobileTabBar({ activeThreadHref, hasRunningAgent, hasError }: MobileTabBarProps) {
  const pathname = usePathname();
  const keyboardHeight = useKeyboardHeight();
  const keyboardOpen = keyboardHeight > 0;
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { trigger } = useHaptics();

  const isThreads = pathname === "/";
  const isActive = pathname.length > 1 && !pathname.startsWith("/api/");
  if (keyboardOpen) return null;

  function scrollCurrentViewToTop() {
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
    if (isThreads) {
      const list = document.querySelector<HTMLElement>("[data-thread-list-scroll='true']");
      if (list) {
        list.scrollTo({ top: 0, behavior });
        return;
      }
    }
    if (isActive) {
      const feed = document.querySelector<HTMLElement>("[data-thread-feed-scroll='true']");
      if (feed) {
        feed.scrollTo({ top: 0, behavior });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior });
  }

  function handleThreadsTab() {
    trigger("selection");
    if (isThreads) {
      scrollCurrentViewToTop();
      return;
    }
  }

  function handleActiveTab() {
    trigger("selection");
    if (isActive) {
      scrollCurrentViewToTop();
      return;
    }
  }

  const threadsClassName = cn(
    "relative flex w-full min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-2 transition-colors duration-fast",
    isThreads
      ? "border border-primary/40 bg-primary/14 text-primary"
      : "border border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
  );
  const activeClassName = cn(
    "relative flex w-full min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-2 transition-colors duration-fast",
    isActive
      ? "border border-primary/40 bg-primary/14 text-primary"
      : "border border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
  );
  const activeHref = activeThreadHref || "/";

  return (
    <SurfaceBar
      asChild
      className="md:hidden flex-shrink-0 flex items-center justify-center border-t border-border/70 px-3 min-h-tab-bar safe-area-bottom-sm transition-opacity-transform duration-base ease-standard"
    >
      <nav aria-label="Thread navigation">
      <div className="thread-surface-soft grid w-full max-w-sidebar-w grid-cols-2 gap-1.5 rounded-xl p-1.5">
      {isThreads ? (
        <Button
          type="button"
          aria-current="page"
          onClick={handleThreadsTab}
          variant="ghost"
          className={threadsClassName}
          data-touch-target
        >
          <LayoutList className="size-5" />
          <span className="text-label font-medium">Threads</span>
        </Button>
      ) : (
        <Link href="/" scroll={false} aria-current={undefined} onClick={() => trigger("selection")} className={threadsClassName} data-touch-target>
          {hasError && !isThreads && (
            <span className="absolute top-1.5 right-3 size-1.5 rounded-full bg-destructive" />
          )}
          <LayoutList className="size-5" />
          <span className="text-label font-medium">Threads</span>
        </Link>
      )}

      {isActive ? (
        <Button
          type="button"
          aria-current="page"
          onClick={handleActiveTab}
          variant="ghost"
          className={activeClassName}
          data-touch-target
        >
          {hasRunningAgent && (
            <span className="absolute top-1.5 right-3 size-2 rounded-full bg-primary" />
          )}
          <Zap className="size-5" />
          <span className="text-label font-medium">Active</span>
        </Button>
      ) : (
        <Link href={activeHref} scroll={false} aria-current={undefined} onClick={() => trigger("selection")} className={activeClassName} data-touch-target>
          {hasRunningAgent && (
            <span className="absolute top-1.5 right-3 size-2 rounded-full bg-primary" />
          )}
          <Zap className="size-5" />
          <span className="text-label font-medium">Active</span>
        </Link>
      )}
      </div>
    </nav></SurfaceBar>
  );
}
