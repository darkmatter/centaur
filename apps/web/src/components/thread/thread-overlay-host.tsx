"use client";

import dynamic from "next/dynamic";
import type { SubagentStep } from "@/lib/describe";
import type { ThreadDetail, ThreadSummary, ThreadTokenUsage } from "@/lib/types";
import { SubagentDetailPanel } from "@/components/thread/subagent-detail-panel";

const ThreadInfoSheet = dynamic(
  () => import("@/components/thread/thread-info-sheet").then((module) => module.ThreadInfoSheet),
  { ssr: false },
);

const CommandPalette = dynamic(
  () => import("@/components/thread/command-palette").then((module) => module.CommandPalette),
  { ssr: false },
);

export function ThreadOverlayHost({
  threadKey,
  thread,
  tokenUsage,
  elapsed,
  canInterrupt,
  isRefreshing,
  compactMode,
  infoMobileOnly = true,
  threads,
  paletteOpen,
  infoOpen,
  selectedSubagentKey,
  selectedSubagentSnapshot,
  slackDeepLink,
  onCloseInfo,
  onCloseSubagent,
  onPaletteOpenChange,
  onRefresh,
  onStop,
  onNavigate,
  onCopyUrl,
  onToggleCompact,
  onOpenShortcuts,
}: {
  threadKey: string;
  thread: ThreadDetail | null;
  tokenUsage: ThreadTokenUsage | null;
  elapsed: string;
  canInterrupt: boolean;
  isRefreshing: boolean;
  compactMode: boolean;
  infoMobileOnly?: boolean;
  threads: ThreadSummary[];
  paletteOpen: boolean;
  infoOpen: boolean;
  selectedSubagentKey: string | null;
  selectedSubagentSnapshot: SubagentStep | null;
  slackDeepLink: string | null;
  onCloseInfo: () => void;
  onCloseSubagent: () => void;
  onPaletteOpenChange: (nextOpen: boolean) => void;
  onRefresh: () => void;
  onStop: () => void;
  onNavigate: (threadKey: string) => void;
  onCopyUrl: () => void;
  onToggleCompact: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <>
      <SubagentDetailPanel
        step={selectedSubagentSnapshot}
        open={selectedSubagentKey !== null}
        onClose={onCloseSubagent}
      />
      {thread ? (
        <ThreadInfoSheet
          open={infoOpen}
          onClose={onCloseInfo}
          thread={thread}
          tokenUsage={tokenUsage}
          elapsed={elapsed}
          onRefresh={onRefresh}
          onStop={canInterrupt ? onStop : undefined}
          canStop={canInterrupt}
          mobileOnly={infoMobileOnly}
        />
      ) : null}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={onPaletteOpenChange}
        threads={threads}
        currentThreadKey={threadKey}
        compactMode={compactMode}
        canInterrupt={canInterrupt}
        isRefreshing={isRefreshing}
        onNavigate={onNavigate}
        onRefresh={onRefresh}
        onStop={onStop}
        onCopyUrl={onCopyUrl}
        onToggleCompact={onToggleCompact}
        onOpenSlack={
          slackDeepLink
            ? () => {
                window.open(slackDeepLink, "_blank");
              }
            : null
        }
        onOpenShortcuts={onOpenShortcuts}
      />
    </>
  );
}
