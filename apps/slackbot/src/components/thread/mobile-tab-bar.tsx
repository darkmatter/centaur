"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutList, Zap } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
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

  const isThreads = pathname === "/";
  const isActive = pathname.length > 1 && !pathname.startsWith("/api/");

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
    if (isThreads) {
      scrollCurrentViewToTop();
      return;
    }
  }

  function handleActiveTab() {
    if (isActive) {
      scrollCurrentViewToTop();
      return;
    }
  }

  const threadsClassName = cn(
    "flex flex-col items-center justify-center gap-0.5 py-2 min-w-[64px] relative",
    isThreads ? "text-primary" : "text-muted-foreground",
  );
  const activeClassName = cn(
    "flex flex-col items-center justify-center gap-0.5 py-2 min-w-[64px] relative",
    isActive ? "text-primary" : "text-muted-foreground",
  );
  const activeHref = activeThreadHref || "/";

  return (
    <nav
      className={cn(
        "md:hidden flex-shrink-0 flex items-center justify-around border-t border-border bg-background/90 backdrop-blur-md min-h-[56px] pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-[opacity,transform] duration-200 ease-out",
        keyboardOpen && "min-h-0 h-0 overflow-hidden border-t-0 p-0 opacity-0 pointer-events-none",
      )}
      aria-label="Thread navigation"
    >
      {isThreads ? (
        <button
          type="button"
          aria-current="page"
          onClick={handleThreadsTab}
          className={threadsClassName}
        >
          <LayoutList className="size-5" />
          <span className="text-[10px] font-medium">Threads</span>
        </button>
      ) : (
        <Link href="/" scroll={false} aria-current={undefined} className={threadsClassName}>
          {hasError && !isThreads && (
            <span className="absolute top-1.5 right-3 size-1.5 rounded-full bg-destructive" />
          )}
          <LayoutList className="size-5" />
          <span className="text-[10px] font-medium">Threads</span>
        </Link>
      )}

      {isActive ? (
        <button
          type="button"
          aria-current="page"
          onClick={handleActiveTab}
          className={activeClassName}
        >
          {hasRunningAgent && (
            <span className="absolute top-1.5 right-3 size-2 rounded-full bg-green-500 animate-pulse" />
          )}
          <Zap className="size-5" />
          <span className="text-[10px] font-medium">Active</span>
        </button>
      ) : (
        <Link href={activeHref} scroll={false} aria-current={undefined} className={activeClassName}>
          {hasRunningAgent && (
            <span className="absolute top-1.5 right-3 size-2 rounded-full bg-green-500 animate-pulse" />
          )}
          <Zap className="size-5" />
          <span className="text-[10px] font-medium">Active</span>
        </Link>
      )}
    </nav>
  );
}
