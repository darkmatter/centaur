"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createIdGenerator } from "ai";
import { Menu, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageInput } from "@/components/thread/message-input";
import { MobileTabBar } from "@/components/thread/mobile-tab-bar";
import { ThreadScreenFrame } from "@/components/thread/thread-screen-frame";
import { useThreadLayout } from "@/components/thread/thread-layout";
import { useHaptics } from "@/components/haptics-provider";

export default function NewSessionPage() {
  const router = useRouter();
  const { openMobileSidebar } = useThreadLayout();
  const { trigger } = useHaptics();
  const [sending, setSending] = useState(false);
  const generateThreadId = useMemo(
    () => createIdGenerator({ prefix: "ui", size: 16 }),
    [],
  );

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
    <ThreadScreenFrame
      header={
        <div className="surface-bar border-b border-border/60 px-3 py-2 md:hidden">
          <div className="flex items-center justify-between">
            <Button
              type="button"
              onClick={() => {
                trigger("light");
                openMobileSidebar();
              }}
              variant="ghost"
              size="icon"
              className="size-10 ui-control-icon"
              aria-label="Open thread list"
              data-touch-target
            >
              <Menu className="size-5" />
            </Button>
            <span className="text-sm font-medium text-foreground">
              New Session
            </span>
            <span className="size-10" aria-hidden="true" />
          </div>
        </div>
      }
      content={
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-border/80 bg-card/60">
              <MessageSquarePlus className="size-6 text-muted-foreground" />
            </div>
            <h1 className="text-lg font-semibold text-foreground">
              New Session
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Start a conversation with the AI agent. Your session will appear
              in the sidebar.
            </p>
          </div>
        </div>
      }
      footer={
        <MessageInput
          mode={sending ? "running" : "idle"}
          onSend={handleSend}
        />
      }
      mobileNav={
        <MobileTabBar
          activeThreadHref="/"
          hasRunningAgent={false}
          hasError={false}
        />
      }
    />
  );
}
