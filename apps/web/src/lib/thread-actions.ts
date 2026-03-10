import type { ComponentType } from "react";
import { ExternalLink, Keyboard, Link2, RefreshCw, Square } from "lucide-react";
import { CompactDensityIcon } from "@/components/thread/icons/thread-icons";

export type ThreadActionItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string;
  disabled?: boolean;
  keywords?: string;
  tone?: "default" | "destructive";
  run: () => void;
};

export function buildThreadActionItems({
  canInterrupt,
  isRefreshing,
  compactMode,
  onRefresh,
  onStop,
  onCopyUrl,
  onToggleCompact,
  onOpenSlack,
  onOpenShortcuts,
}: {
  canInterrupt: boolean;
  isRefreshing: boolean;
  compactMode: boolean;
  onRefresh: () => void;
  onStop: () => void;
  onCopyUrl: () => void;
  onToggleCompact: () => void;
  onOpenSlack: (() => void) | null;
  onOpenShortcuts: () => void;
}): ThreadActionItem[] {
  const actions: ThreadActionItem[] = [
    {
      id: "stop",
      label: "Stop agent",
      icon: Square,
      shortcut: "Alt+S",
      disabled: !canInterrupt,
      keywords: "interrupt cancel halt",
      tone: "destructive",
      run: onStop,
    },
    {
      id: "refresh",
      label: isRefreshing ? "Refreshing thread…" : "Refresh thread",
      icon: RefreshCw,
      shortcut: "Alt+R",
      disabled: isRefreshing,
      keywords: "reload sync",
      run: onRefresh,
    },
    {
      id: "copy-url",
      label: "Copy thread URL",
      icon: Link2,
      keywords: "copy link share",
      run: onCopyUrl,
    },
    {
      id: "toggle-compact",
      label: compactMode ? "Disable compact mode" : "Toggle compact mode",
      icon: CompactDensityIcon,
      shortcut: "Cmd+.",
      keywords: "density compact collapse",
      run: onToggleCompact,
    },
    {
      id: "shortcuts",
      label: "Show keyboard shortcuts",
      icon: Keyboard,
      shortcut: "Shift+?",
      keywords: "help hotkeys",
      run: onOpenShortcuts,
    },
  ];

  if (onOpenSlack) {
    actions.push({
      id: "open-slack",
      label: "Open in Slack",
      icon: ExternalLink,
      keywords: "slack thread",
      run: onOpenSlack,
    });
  }

  return actions;
}
