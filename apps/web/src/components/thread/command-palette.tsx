"use client";

import type { ComponentType } from "react";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useHaptics } from "@/components/haptics-provider";
import {
  CommandSurfaceIcon,
  ThreadContextIcon,
} from "@/components/thread/icons/thread-icons";
import { buildThreadActionItems } from "@/lib/thread-actions";
import { threadName } from "@/lib/viewer/thread-name";
import type { ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  threads: ThreadSummary[];
  currentThreadKey: string;
  compactMode: boolean;
  canInterrupt: boolean;
  isRefreshing: boolean;
  onNavigate: (threadKey: string) => void;
  onRefresh: () => void;
  onStop: () => void;
  onCopyUrl: () => void;
  onToggleCompact: () => void;
  onOpenSlack: (() => void) | null;
  onOpenShortcuts: () => void;
};

type PaletteAction = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string;
  disabled?: boolean;
  keywords?: string;
  run: () => void;
};

function harnessAbbrev(harness: ThreadSummary["harness"]): string {
  if (harness === "claude-code") return "CC";
  if (harness === "pi-mono") return "PI";
  return harness.toUpperCase();
}

function runAndClose(
  run: () => void,
  onOpenChange: (nextOpen: boolean) => void,
  hapticTrigger: () => void,
): void {
  hapticTrigger();
  onOpenChange(false);
  run();
}

export function CommandPalette({
  open,
  onOpenChange,
  threads,
  currentThreadKey,
  compactMode,
  canInterrupt,
  isRefreshing,
  onNavigate,
  onRefresh,
  onStop,
  onCopyUrl,
  onToggleCompact,
  onOpenSlack,
  onOpenShortcuts,
}: CommandPaletteProps) {
  const { trigger } = useHaptics();
  const navigationItems = threads
    .filter((thread) => thread.slack_thread_key !== currentThreadKey);

  const actions: PaletteAction[] = buildThreadActionItems({
    canInterrupt,
    isRefreshing,
    compactMode,
    onRefresh,
    onStop,
    onCopyUrl,
    onToggleCompact,
    onOpenSlack,
    onOpenShortcuts,
  });

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="overlay-backdrop fixed inset-0 z-40"
      className={cn(
        "fixed left-1/2 cmd-palette-top z-50 cmd-palette-w -translate-x-1/2 overflow-hidden rounded-md border border-border/90 bg-card/98 text-foreground shadow-dialog outline-none",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/90 px-3 py-2.5">
        <Search className="size-3.5 text-muted-foreground" />
        <Command.Input
          placeholder="Type a command or search…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/90"
        />
      </div>
      <Command.List className="max-h-palette-max overflow-y-auto p-2">
        <Command.Empty className="px-2 py-4 text-center text-sm text-muted-foreground">
          No results.
        </Command.Empty>

        <Command.Group heading="Navigation" className="text-xs text-muted-foreground">
          {navigationItems.map((thread) => {
            const name = thread.thread_name || threadName(thread.slack_thread_key);
            return (
              <Command.Item
                key={thread.slack_thread_key}
                value={`thread ${name} ${thread.slack_thread_key}`}
                keywords={[thread.harness, thread.state, String(thread.turn_count)]}
                onSelect={() => runAndClose(() => onNavigate(thread.slack_thread_key), onOpenChange, () => trigger("medium"))}
                className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground data-[selected=true]:bg-accent/80"
              >
                <ThreadContextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <span>{harnessAbbrev(thread.harness)}</span>
                  <span>{thread.turn_count}t</span>
                </span>
              </Command.Item>
            );
          })}
        </Command.Group>

        <Command.Separator className="my-1 h-px bg-border" />

        <Command.Group heading="Actions" className="text-xs text-muted-foreground">
          {actions.map((action) => (
            <Command.Item
              key={action.id}
              value={action.label}
              keywords={action.keywords?.split(/\s+/)}
              disabled={action.disabled}
              onSelect={() => runAndClose(action.run, onOpenChange, () => trigger("medium"))}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground data-[selected=true]:bg-accent/80",
                action.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              )}
            >
              <action.icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{action.label}</span>
              {action.shortcut ? (
                <span className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {action.shortcut}
                </span>
              ) : null}
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="border-t border-border/90 px-3 py-2 text-xs text-muted-foreground">
        <CommandSurfaceIcon className="mr-1 inline size-3 align-icon-nudge" />
        <span className="font-mono">Enter</span> to run • <span className="font-mono">Esc</span> to close
      </div>
    </Command.Dialog>
  );
}
