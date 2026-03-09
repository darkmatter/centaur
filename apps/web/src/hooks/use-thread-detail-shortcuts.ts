import { useEffect } from "react";
import { toast } from "sonner";
import { THREAD_SHORTCUTS_LABEL } from "@/components/thread/thread-ui-constants";

type UseThreadDetailShortcutsParams = {
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean) => void;
  infoOpen: boolean;
  setInfoOpen: (value: boolean) => void;
  mobileSidebarOpen: boolean;
  closeMobileSidebar: () => void;
  handleBackToSource: () => void;
  fetchThread: () => Promise<boolean>;
  canInterrupt: boolean;
  interruptRun: () => Promise<boolean>;
  toggleCompactMode: () => void;
};

const INPUT_SELECTOR = "input, textarea, select, [contenteditable='true']";
const INTERACTIVE_SELECTOR = "a,button,[role='button'],[tabindex]:not([tabindex='-1'])";

function isShortcutInputTarget(target: HTMLElement | null): boolean {
  return !!target?.closest(INPUT_SELECTOR);
}

function isShortcutInteractiveTarget(target: HTMLElement | null): boolean {
  return !!target?.closest(INTERACTIVE_SELECTOR);
}

export function useThreadDetailShortcuts({
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
  toggleCompactMode,
}: UseThreadDetailShortcutsParams): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const targetIsInput = isShortcutInputTarget(target);
      const targetIsInteractive = isShortcutInteractiveTarget(target);

      if (event.key === "Escape") {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          return;
        }
        if (infoOpen) {
          event.preventDefault();
          setInfoOpen(false);
          return;
        }
        if (mobileSidebarOpen) {
          event.preventDefault();
          closeMobileSidebar();
          return;
        }
        if (targetIsInput) {
          target?.blur?.();
          return;
        }
        event.preventDefault();
        handleBackToSource();
        return;
      }

      if (targetIsInput) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        toggleCompactMode();
        return;
      }

      if (event.shiftKey && event.key === "?") {
        event.preventDefault();
        toast(THREAD_SHORTCUTS_LABEL);
        return;
      }

      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !targetIsInteractive &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        void fetchThread();
        return;
      }

      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !targetIsInteractive &&
        event.key.toLowerCase() === "s" &&
        canInterrupt
      ) {
        event.preventDefault();
        void interruptRun();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    canInterrupt,
    closeMobileSidebar,
    fetchThread,
    handleBackToSource,
    infoOpen,
    interruptRun,
    mobileSidebarOpen,
    paletteOpen,
    setInfoOpen,
    setPaletteOpen,
    toggleCompactMode,
  ]);
}
