"use client";

import { useMemo, useState } from "react";
import { Info, Layers3, RadioTower, SearchCode } from "lucide-react";
import { toast } from "sonner";
import { ActivityFeedV2 } from "@/components/thread/activity-feed-v2";
import { ConnectivityBanner } from "@/components/thread/connectivity-banner";
import { MessageInput } from "@/components/thread/message-input";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { QuickActionChips } from "@/components/thread/quick-action-chips";
import { ThreadDetailHeader } from "@/components/thread/thread-detail-header";
import { ThreadOverlayHost } from "@/components/thread/thread-overlay-host";
import { ThreadStatusTabs } from "@/components/thread/thread-status-tabs";
import { ThreadSummaryCard } from "@/components/thread/thread-summary-card";
import { ThreadScreenFrame } from "@/components/thread/thread-screen-frame";
import { Button } from "@/components/ui/button";
import {
  fixtureSubagentCompleted,
  fixtureSubagentFailed,
  fixtureSubagent,
  fixtureThreadDetail,
  fixtureThreadMessages,
  fixtureThreadSummaries,
  fixtureTokenUsage,
} from "@/lib/thread-viewer-fixtures";
import { ThreadMotionProvider } from "@/motion/provider";
import { subagentSelectionKey } from "@/lib/viewer/subagent-steps";

export default function ThreadViewerUIKitPage() {
  const [infoOpen, setInfoOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedSubagent, setSelectedSubagent] = useState<typeof fixtureSubagent | null>(fixtureSubagent);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [quickActionState, setQuickActionState] = useState<"error" | "stopped">("error");

  const selectedSubagentKey = selectedSubagent ? subagentSelectionKey(selectedSubagent) : null;
  const slackDeepLink = useMemo(() => {
    const keyParts = fixtureThreadDetail.slack_thread_key.replace(/^slack:/, "").split(":");
    const channelId = keyParts[0] ?? "";
    const threadTs = keyParts[1] ?? "";
    if (!channelId || !threadTs) return null;
    return `slack://app_redirect?channel=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}`;
  }, []);

  return (
    <ThreadMotionProvider>
      <ThreadScreenFrame
        header={
          <ThreadDetailHeader
            thread={fixtureThreadDetail}
            humanName={fixtureThreadDetail.thread_name ?? "Demo thread"}
            tokenUsage={fixtureTokenUsage}
            liveElapsed="2m 18s"
            stableStatus="Refining shell previews, overlay choreography, and fixture coverage."
            isRunning
            isEngineer
            phases={["research", "implement", "review"]}
            error={null}
            interruptError={null}
            canInterrupt
            isInterrupting={false}
            onInterrupt={() => toast("Demo: stop requested")}
            onRefresh={() => toast("Demo: refresh requested")}
            onOpenInfo={() => setInfoOpen(true)}
            onOpenDrawer={() => toast("Demo: mobile drawer lives on the thread route")}
            sourceLabel="UIKit Fixture"
            onBack={() => toast("Demo: back navigation")}
            upHref="/uikit"
          />
        }
        banner={<ConnectivityBanner isReconnecting={isReconnecting} threadState={fixtureThreadDetail.state} />}
        content={
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="space-y-4 min-h-0">
              <div className="thread-surface rounded-xl p-3">
                <ThreadStatusTabs
                  value="active"
                  counts={{ all: fixtureThreadSummaries.length, active: 2, error: 1 }}
                  onChange={() => {}}
                />
              </div>

              <div className="thread-surface rounded-xl p-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setInfoOpen(true)}>
                    <Info className="size-3.5" />
                    Info panel
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setPaletteOpen(true)}>
                    <Layers3 className="size-3.5" />
                    Command palette
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSelectedSubagent(fixtureSubagent)}
                  >
                    <SearchCode className="size-3.5" />
                    Live subagent
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSelectedSubagent(fixtureSubagentCompleted)}
                  >
                    Completed
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSelectedSubagent(fixtureSubagentFailed)}
                  >
                    Failed
                  </Button>
                  <Button
                    size="sm"
                    variant={isReconnecting ? "default" : "secondary"}
                    onClick={() => setIsReconnecting((value) => !value)}
                  >
                    <RadioTower className="size-3.5" />
                    {isReconnecting ? "Hide reconnecting" : "Show reconnecting"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={quickActionState === "error" ? "default" : "secondary"}
                    onClick={() => setQuickActionState("error")}
                  >
                    Error chips
                  </Button>
                  <Button
                    size="sm"
                    variant={quickActionState === "stopped" ? "default" : "secondary"}
                    onClick={() => setQuickActionState("stopped")}
                  >
                    Resume chips
                  </Button>
                </div>
                <div className="thread-surface-soft rounded-lg px-3 py-2 text-xs text-muted-foreground">
                  Mobile quick-action preview:{" "}
                  <span className="text-foreground">
                    {quickActionState === "error"
                      ? "Retry, Retry with context"
                      : "Resume"}
                  </span>
                </div>
              </div>

              <div className="thread-surface overflow-hidden rounded-xl">
                {fixtureThreadSummaries.map((thread) => (
                  <ThreadSummaryCard
                    key={thread.slack_thread_key}
                    thread={thread}
                    href="#"
                    density="compact"
                    isSelected={thread.slack_thread_key === fixtureThreadDetail.slack_thread_key}
                    statusSubtitle={
                      thread.state === "running"
                        ? "Rolling shell preview and richer live context"
                        : thread.state === "working"
                          ? "Unifying panel behavior and fixture coverage"
                          : thread.state === "error"
                            ? "Reviewing fixture coverage and failure handling"
                            : "Representative UIKit surface and viewer coverage"
                    }
                    linkProps={{
                      onClick: (event) => {
                        event.preventDefault();
                        toast(`Demo thread: ${thread.thread_name ?? thread.slack_thread_key}`);
                      },
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="thread-surface min-h-0 overflow-hidden rounded-xl">
              <ActivityFeedV2
                messages={fixtureThreadMessages}
                state={fixtureThreadDetail.state}
                isStreaming
                participants={fixtureThreadDetail.participants}
                onSelectSubagent={(step) => setSelectedSubagent(step)}
                selectedSubagentKey={selectedSubagentKey}
              />
            </div>
          </div>
        }
        footer={
          <>
            <QuickActionChips
              threadState={quickActionState}
              onAction={(value) => toast(`Demo quick action: ${value}`)}
            />
            <MessageInput
              mode="running"
              onSend={async (message) => {
                toast(`Demo send: ${message}`);
              }}
              onStop={async () => {
                toast("Demo stop");
              }}
            />
          </>
        }
        mobileNav={
          <MobileTabBar
            activeThreadHref={`/${encodeURIComponent(fixtureThreadDetail.slack_thread_key)}`}
            hasRunningAgent
            hasError={quickActionState === "error"}
          />
        }
        overlay={
          <ThreadOverlayHost
            threadKey={fixtureThreadDetail.slack_thread_key}
            thread={fixtureThreadDetail}
            tokenUsage={fixtureTokenUsage}
            elapsed="2m 18s"
            canInterrupt
            isRefreshing={false}
            compactMode={false}
            infoMobileOnly={false}
            threads={fixtureThreadSummaries}
            paletteOpen={paletteOpen}
            infoOpen={infoOpen}
            selectedSubagentKey={selectedSubagentKey}
            selectedSubagentSnapshot={selectedSubagent}
            slackDeepLink={slackDeepLink}
            onCloseInfo={() => setInfoOpen(false)}
            onCloseSubagent={() => setSelectedSubagent(null)}
            onPaletteOpenChange={setPaletteOpen}
            onRefresh={() => toast("Demo: refresh requested")}
            onStop={() => toast("Demo: stop requested")}
            onNavigate={(threadKey) => {
              toast(`Demo navigate: ${threadKey}`);
              setPaletteOpen(false);
            }}
            onCopyUrl={() => toast("Demo: copied thread URL")}
            onToggleCompact={() => toast("Demo: compact mode toggled")}
            onOpenShortcuts={() => toast("Demo: shortcut sheet")}
          />
        }
      />
    </ThreadMotionProvider>
  );
}
