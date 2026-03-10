"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { ActivityFeedV2 } from "@/components/thread/activity-feed-v2";
import { ConnectivityBanner } from "@/components/thread/connectivity-banner";
import { MessageInput } from "@/components/thread/message-input";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { QuickActionChips } from "@/components/thread/quick-action-chips";
import { ThreadDetailHeader } from "@/components/thread/thread-detail-header";
import { ThreadOverlayHost } from "@/components/thread/thread-overlay-host";
import { ThreadScreenFrame } from "@/components/thread/thread-screen-frame";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { threadName } from "@/lib/viewer/thread-name";
import { useThreadDetailScreenModel } from "./use-thread-detail-screen-model";

export function ThreadDetailScreen({ threadKey }: { threadKey: string }) {
  const model = useThreadDetailScreenModel(threadKey);

  if (model.error && !model.thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-destructive text-sm mb-4">{model.error}</p>
          <div className="flex items-center justify-center gap-3">
            <Button
              type="button"
              onClick={() => {
                void model.fetchThread();
              }}
              variant="outline"
              size="xs"
              className="border-border text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Retry
            </Button>
            <Link
              href={model.backHref}
              className="inline-flex min-h-[44px] items-center rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-[var(--dur-fast)] hover:bg-accent hover:text-foreground"
              data-touch-target
            >
              Back to threads
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!model.thread) {
    return (
      <div className="h-dvh md:h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground text-sm inline-flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin text-primary" />
            <Shimmer className="text-sm text-muted-foreground" duration={1.6}>
              Connecting...
            </Shimmer>
          </p>
          <p className="text-muted-foreground text-xs font-mono mt-2">{threadName(threadKey)}</p>
        </div>
      </div>
    );
  }

  return (
    <ThreadScreenFrame
      header={
        <ThreadDetailHeader
          thread={model.thread}
          humanName={model.humanName}
          tokenUsage={model.tokenUsage}
          liveElapsed={model.liveElapsed}
          stableStatus={model.stableStatus}
          isRunning={model.isRunning}
          isEngineer={model.isEngineer}
          phases={model.phases}
          error={model.error}
          interruptError={model.interruptError}
          canInterrupt={model.canInterrupt}
          isInterrupting={model.isInterrupting}
          onInterrupt={() => void model.interruptRun()}
          onRefresh={() => void model.fetchThread()}
          onOpenInfo={model.openInfo}
          onOpenDrawer={model.openMobileSidebar}
          sourceLabel={model.sourceLabel}
          onBack={model.handleBackToSource}
          upHref={model.upHref}
        />
      }
      banner={<ConnectivityBanner isReconnecting={model.isReconnecting} threadState={model.thread.state} />}
      content={
        <ActivityFeedV2
          messages={model.chatMessages}
          state={model.thread.state}
          isStreaming={model.isStreaming}
          participants={model.thread.participants}
          compactMode={model.compactMode}
          onSelectSubagent={model.handleSelectSubagent}
          selectedSubagentKey={model.selectedSubagentKey}
          hasOlderMessages={model.hasOlderMessages}
          isLoadingOlder={model.isLoadingOlder}
          onLoadMore={model.loadOlderMessages}
        />
      }
      footer={
        <>
          <QuickActionChips threadState={model.thread.state} onAction={model.handleQuickAction} />
          <MessageInput
            mode={model.inputMode}
            onSend={model.handleSendMessage}
            onStop={model.canInterrupt ? model.handleStopAgent : undefined}
          />
        </>
      }
      mobileNav={
        <MobileTabBar
          activeThreadHref={`/${encodeURIComponent(threadKey)}`}
          hasRunningAgent={model.isRunning}
          hasError={model.thread.state === "error"}
        />
      }
      overlay={
        <ThreadOverlayHost
          threadKey={threadKey}
          thread={model.thread}
          tokenUsage={model.tokenUsage}
          elapsed={model.liveElapsed}
          canInterrupt={model.canInterrupt}
          isRefreshing={model.isFetchingThread}
          compactMode={model.compactMode}
          infoMobileOnly={false}
          threads={model.threads}
          paletteOpen={model.paletteOpen}
          infoOpen={model.infoOpen}
          selectedSubagentKey={model.selectedSubagentKey}
          selectedSubagentSnapshot={model.selectedSubagentSnapshot}
          slackDeepLink={model.slackDeepLink}
          onCloseInfo={model.closeInfoSheet}
          onCloseSubagent={model.closeSubagentPanel}
          onPaletteOpenChange={model.setPaletteOpen}
          onRefresh={() => void model.fetchThread()}
          onStop={() => void model.interruptRun()}
          onNavigate={model.navigateToThread}
          onCopyUrl={() => {
            navigator.clipboard
              ?.writeText(window.location.href)
              .then(() => toast("Copied link"))
              .catch(() => toast("Failed to copy link"));
          }}
          onToggleCompact={model.toggleCompactMode}
          onOpenShortcuts={model.openShortcuts}
        />
      }
    />
  );
}
