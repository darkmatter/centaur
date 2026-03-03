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
import { ThreadSidebar, type ThreadSidebarHandle } from "@/components/thread/thread-sidebar";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isTextInputTarget } from "@/lib/thread-utils";
import { cn } from "@/lib/utils";

export const THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY = "threads.sidebar.collapsed.v1";
export const THREAD_SIDEBAR_COLLAPSE_CLASS = "threads-sidebar-collapsed";
const THREAD_SIDEBAR_COLLAPSE_EVENT = "threads-sidebar-collapse-change";

type ThreadLayoutContextValue = {
  mobileSidebarOpen: boolean;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
};

const ThreadLayoutContext = createContext<ThreadLayoutContextValue | null>(null);

function readSidebarCollapsedSnapshot(): boolean {
  if (typeof document !== "undefined" && document.documentElement.classList.contains(THREAD_SIDEBAR_COLLAPSE_CLASS)) {
    return true;
  }
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY) === "1";
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
    window.localStorage.setItem(THREAD_SIDEBAR_COLLAPSE_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Ignore storage failures (private mode, quota, etc).
  }
  document.documentElement.classList.toggle(THREAD_SIDEBAR_COLLAPSE_CLASS, next);
  window.dispatchEvent(new Event(THREAD_SIDEBAR_COLLAPSE_EVENT));
}

function useSidebarCollapsedState(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsedSnapshot,
    () => false,
  );
  const setCollapsed = useCallback((next: boolean) => updateSidebarCollapsed(next), []);
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
  const selectedThreadKey = useMemo(() => parseSelectedThreadKey(pathname), [pathname]);
  const [collapsed, setCollapsed] = useSidebarCollapsedState();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const desktopSidebarRef = useRef<ThreadSidebarHandle>(null);
  const mobileSidebarRef = useRef<ThreadSidebarHandle>(null);
  const mobileSidebarReturnFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const mobileDialogRef = useRef<HTMLElement>(null);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    const returnTarget = mobileSidebarReturnFocusRef.current;
    if (returnTarget) {
      window.requestAnimationFrame(() => returnTarget.focus());
      mobileSidebarReturnFocusRef.current = null;
    }
  }, []);

  const openMobileSidebar = useCallback(() => {
    if (isDesktop) return;
    mobileSidebarReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileSidebarOpen(true);
  }, [isDesktop]);

  useEffect(() => {
    if (isDesktop && mobileSidebarOpen) {
      setMobileSidebarOpen(false);
    }
  }, [isDesktop, mobileSidebarOpen]);

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
        if (selectedThreadKey) {
          // Detail route owns Escape for Back/Up/transient-layer semantics.
          return;
        }
        if (isDesktop) {
          event.preventDefault();
          if (collapsed) {
            setCollapsed(false);
            window.requestAnimationFrame(() => desktopSidebarRef.current?.focusSearch());
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
          window.requestAnimationFrame(() => desktopSidebarRef.current?.focusSearch());
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
          window.requestAnimationFrame(() => desktopSidebarRef.current?.focusSearch());
        } else {
          desktopSidebarRef.current?.focusSearch();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeMobileSidebar, collapsed, isDesktop, mobileSidebarOpen, selectedThreadKey, setCollapsed]);

  useEffect(() => {
    const panel = panelRef.current;
    if (isDesktop || !mobileSidebarOpen) {
      panel?.removeAttribute("inert");
      return;
    }
    panel?.setAttribute("inert", "");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = mobileDialogRef.current;
    const collectFocusable = (): HTMLElement[] => {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])",
        ),
      ).filter((node) => !node.hasAttribute("disabled"));
    };
    const focusable = collectFocusable();
    focusable[0]?.focus();
    const trapTabFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = collectFocusable();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const insideDialog = !!(active && dialog?.contains(active));
      if (event.shiftKey) {
        if (!insideDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!insideDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapTabFocus);
    return () => {
      document.removeEventListener("keydown", trapTabFocus);
      panel?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
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
      <div className="thread-shell flex h-full md:h-[calc(100dvh-41px)]">
        <aside className="thread-shell-sidebar hidden w-[320px] shrink-0 border-r border-border bg-card/20 md:flex">
          <Suspense fallback={<div className="h-full w-full bg-card/20" />}>
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
          className="thread-shell-panel min-h-0 min-w-0 flex-1 bg-background outline-none"
        >
          {children}
        </section>
      </div>

      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 border-0 bg-black/50 p-0 transition-opacity duration-200 ease-out motion-reduce:transition-none opacity-100"
            aria-label="Close thread sidebar"
            onClick={closeMobileSidebar}
          />
          <aside
            ref={mobileDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Threads"
            className="absolute inset-y-0 left-0 flex w-[320px] max-w-[88vw] flex-col overflow-y-auto overscroll-contain border-r border-border bg-background shadow-2xl transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none motion-reduce:transform-none translate-x-0"
          >
            <div className="flex items-center justify-end border-b border-border px-2 py-2">
              <button
                type="button"
                onClick={closeMobileSidebar}
                aria-label="Close thread sidebar"
                className="inline-flex size-8 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
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
          </aside>
        </div>
      ) : null}
    </ThreadLayoutContext.Provider>
  );
}
