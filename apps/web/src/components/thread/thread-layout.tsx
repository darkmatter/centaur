"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHaptics } from "@/components/haptics-provider";
import {
  ThreadSidebar,
  type ThreadSidebarHandle,
} from "@/components/thread/thread-sidebar";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isTextInputTarget } from "@/lib/viewer/thread-utils";

export const THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY =
  "threads.sidebar.collapsed.v1";
export const THREAD_SIDEBAR_COLLAPSE_CLASS = "threads-sidebar-collapsed";
const THREAD_SIDEBAR_COLLAPSE_EVENT = "threads-sidebar-collapse-change";

type ThreadLayoutContextValue = {
  mobileSidebarOpen: boolean;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
};

const ThreadLayoutContext = createContext<ThreadLayoutContextValue | null>(
  null,
);

function readSidebarCollapsedSnapshot(): boolean {
  if (typeof document !== "undefined") {
    if (document.body?.classList.contains(THREAD_SIDEBAR_COLLAPSE_CLASS)) {
      return true;
    }
    if (document.documentElement.classList.contains(THREAD_SIDEBAR_COLLAPSE_CLASS)) {
      return true;
    }
  }
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

function subscribeSidebarCollapsed(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY) return;
    onStoreChange();
  };
  const handleSameTab = () => onStoreChange();
  window.addEventListener("storage", handleStorage);
  window.addEventListener(THREAD_SIDEBAR_COLLAPSE_EVENT, handleSameTab);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(THREAD_SIDEBAR_COLLAPSE_EVENT, handleSameTab);
  };
}

function updateSidebarCollapsed(next: boolean): void {
  try {
    window.localStorage.setItem(
      THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY,
      next ? "1" : "0",
    );
  } catch {
    // Ignore storage failures.
  }
  document.body?.classList.toggle(THREAD_SIDEBAR_COLLAPSE_CLASS, next);
  document.documentElement.classList.remove(THREAD_SIDEBAR_COLLAPSE_CLASS);
  window.dispatchEvent(new Event(THREAD_SIDEBAR_COLLAPSE_EVENT));
}

function useSidebarCollapsedState(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsedSnapshot,
    () => false,
  );
  const setCollapsed = useCallback(
    (next: boolean) => updateSidebarCollapsed(next),
    [],
  );
  return [collapsed, setCollapsed];
}

function parseSelectedThreadKey(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  const encoded = pathname.slice(1).split("/")[0];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function useThreadLayout(): ThreadLayoutContextValue {
  const context = useContext(ThreadLayoutContext);
  if (!context) {
    throw new Error("useThreadLayout must be used inside ThreadLayout");
  }
  return context;
}

export function ThreadLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const selectedThreadKey = useMemo(
    () => parseSelectedThreadKey(pathname),
    [pathname],
  );
  const [collapsed, setCollapsed] = useSidebarCollapsedState();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { trigger } = useHaptics();
  const desktopSidebarRef = useRef<ThreadSidebarHandle>(null);
  const mobileSidebarRef = useRef<ThreadSidebarHandle>(null);
  const mobileSidebarReturnFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const mobileDialogRef = useRef<HTMLDivElement>(null);

  const closeMobileSidebar = useCallback(
    (withFeedback = true) => {
      if (withFeedback) trigger("light");
      setMobileSidebarOpen(false);
      const returnTarget = mobileSidebarReturnFocusRef.current;
      if (returnTarget) {
        window.requestAnimationFrame(() => returnTarget.focus());
        mobileSidebarReturnFocusRef.current = null;
      }
    },
    [trigger],
  );

  const openMobileSidebar = useCallback(() => {
    if (isDesktop) return;
    trigger("medium");
    mobileSidebarReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMobileSidebarOpen(true);
  }, [isDesktop, trigger]);

  useEffect(() => {
    if (isDesktop && mobileSidebarOpen) {
      closeMobileSidebar(false);
    }
  }, [closeMobileSidebar, isDesktop, mobileSidebarOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isTextInputTarget(event.target)) {
          (event.target as HTMLElement | null)?.blur?.();
          return;
        }
        if (mobileSidebarOpen) {
          event.preventDefault();
          closeMobileSidebar();
          return;
        }
        if (selectedThreadKey) return;
        if (isDesktop) {
          event.preventDefault();
          if (collapsed) {
            setCollapsed(false);
            window.requestAnimationFrame(() =>
              desktopSidebarRef.current?.focusSearch(),
            );
          } else {
            desktopSidebarRef.current?.focusSidebar();
          }
        }
        return;
      }

      if (event.altKey || event.ctrlKey) return;
      if (event.metaKey && event.key === "[") {
        event.preventDefault();
        if (!isDesktop) {
          setMobileSidebarOpen(true);
          return;
        }
        if (collapsed) {
          setCollapsed(false);
          window.requestAnimationFrame(() =>
            desktopSidebarRef.current?.focusSearch(),
          );
        } else {
          desktopSidebarRef.current?.focusSidebar();
        }
        return;
      }
      if (event.metaKey && event.key === "]") {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      if (event.metaKey) return;
      if (event.key === "/" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        if (!isDesktop) {
          setMobileSidebarOpen(true);
          return;
        }
        if (collapsed) {
          setCollapsed(false);
          window.requestAnimationFrame(() =>
            desktopSidebarRef.current?.focusSearch(),
          );
        } else {
          desktopSidebarRef.current?.focusSearch();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    closeMobileSidebar,
    collapsed,
    isDesktop,
    mobileSidebarOpen,
    selectedThreadKey,
    setCollapsed,
  ]);

  useEffect(() => {
    const panel = panelRef.current;
    if (isDesktop || !mobileSidebarOpen) {
      panel?.removeAttribute("inert");
      return;
    }
    panel?.setAttribute("inert", "");
    return () => {
      panel?.removeAttribute("inert");
    };
  }, [isDesktop, mobileSidebarOpen]);

  const contextValue = useMemo<ThreadLayoutContextValue>(
    () => ({
      mobileSidebarOpen,
      openMobileSidebar,
      closeMobileSidebar,
    }),
    [closeMobileSidebar, mobileSidebarOpen, openMobileSidebar],
  );

  return (
    <ThreadLayoutContext.Provider value={contextValue}>
      <div className="thread-shell relative flex h-full overflow-hidden md:h-[calc(100dvh-44px)]">
        <aside className="thread-shell-sidebar thread-surface-sidebar relative hidden shrink-0 border-r border-border/60 md:flex">
          <Suspense fallback={<div className="h-full w-full bg-card/35" />}>
            <ThreadSidebar
              ref={desktopSidebarRef}
              selectedThreadKey={selectedThreadKey}
              collapsed={collapsed}
              onCollapsedChange={setCollapsed}
              active={isDesktop}
            />
          </Suspense>
        </aside>
        <section
          ref={panelRef}
          tabIndex={-1}
          className="thread-shell-panel thread-surface-panel min-h-0 min-w-0 flex-1 outline-none"
        >
          {children}
        </section>
      </div>

      <ResponsivePanel
        open={mobileSidebarOpen}
        side="left"
        onClose={() => closeMobileSidebar()}
        panelRef={mobileDialogRef}
        className="md:hidden"
        labelledBy="thread-sidebar-mobile-title"
      >
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <span
            id="thread-sidebar-mobile-title"
            className="text-sm font-medium text-foreground"
          >
            Threads
          </span>
          <Button
            type="button"
            onClick={() => closeMobileSidebar()}
            variant="outline"
            size="icon-lg"
            className="size-11"
            aria-label="Close thread sidebar"
            data-touch-target
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="h-full w-full bg-background" />}>
            <ThreadSidebar
              ref={mobileSidebarRef}
              selectedThreadKey={selectedThreadKey}
              collapsed={false}
              showCollapseToggle={false}
              onNavigate={closeMobileSidebar}
              active={!isDesktop && mobileSidebarOpen}
            />
          </Suspense>
        </div>
      </ResponsivePanel>
    </ThreadLayoutContext.Provider>
  );
}
