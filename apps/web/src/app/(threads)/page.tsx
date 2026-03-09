"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createIdGenerator } from "ai";
import { Menu, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileHeader } from "@/components/ui/mobile-header";
import { MessageInput } from "@/components/thread/message-input";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { useThreadLayout } from "@/components/thread/thread-layout";
import { useHaptics } from "@/components/haptics-provider";

export default function NewSessionPage() {
  const router = useRouter();
  const { openMobileSidebar } = useThreadLayout();
  const { trigger } = useHaptics();
  const [sending, setSending] = useState(false);
  const generateThreadId = useMemo(() => createIdGenerator({ prefix: "ui", size: 16 }), []);

  const handleSend = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || sending) return;
      setSending(true);

      const threadKey = `ui:${generateThreadId()}`;
      const encoded = encodeURIComponent(threadKey);
      const messageParam = encodeURIComponent(text);
      router.push(`/${encoded}?initial_message=${messageParam}`);
    },
    [generateThreadId, router, sending],
  );

  return (
    <div className="app-shell h-dvh md:h-full flex flex-col bg-background overflow-hidden">
      <MobileHeader
        title="New Session"
        leading={
          <Button
            type="button"
            onClick={() => { trigger("light"); openMobileSidebar(); }}
            variant="ghost"
            size="icon"
            className="size-10 ui-control-icon"
            aria-label="Open thread list"
            data-touch-target
          >
            <Menu className="size-5" />
          </Button>
        }
      />
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 overflow-auto">
        <div className="text-center max-w-md">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-border/80 bg-card/60">
            <MessageSquarePlus className="size-6 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">New Session</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Start a conversation with the AI agent. Your session will appear in the sidebar.
          </p>
        </div>
      </div>

      <MessageInput
        mode={sending ? "running" : "idle"}
        onSend={handleSend}
      />

      <MobileTabBar activeThreadHref="/" hasRunningAgent={false} hasError={false} />
    </div>
  );
}
