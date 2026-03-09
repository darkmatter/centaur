"use client";

/**
 * ActivityFeed v2 — renders UIMessage[] directly from Chat SDK.
 *
 * Replaces the Step[]-based ActivityFeed. Instead of:
 *   turns → stepsFromTurns → Step[] → groupStepsByTurn → MessagePartRenderer
 * we now do:
 *   UIMessage[] → message.parts → UIMessageRenderer
 *
 * This component can be used alongside the existing ActivityFeed during migration.
 */

import { ChevronUp, LoaderCircle, MessagesSquare } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { UIMessageRenderer } from "@/components/ai-elements/ui-message-renderer";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { SubagentStep } from "@/lib/describe";
import type { Participant } from "@/lib/types";

export const ActivityFeedV2 = memo(function ActivityFeedV2({
  messages,
  state,
  isStreaming,
  participants,
  compactMode = false,
  onSelectSubagent,
  selectedSubagentKey,
  hasOlderMessages = false,
  isLoadingOlder = false,
  onLoadMore,
}: {
  messages: UIMessage[];
  state?: string;
  isStreaming?: boolean;
  participants?: Participant[];
  compactMode?: boolean;
  onSelectSubagent?: (step: SubagentStep) => void;
  selectedSubagentKey?: string | null;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onLoadMore?: () => void;
}) {
  const participantsById = useMemo(
    () => new Map((participants || []).map((p) => [p.id, p])),
    [participants],
  );
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isEmpty = messages.length === 0;
  const isIdle = state === "idle" || state === "stopped";

  // Intersection observer: auto-load older messages when scrolled to top
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasOlderMessages || isLoadingOlder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasOlderMessages, isLoadingOlder]);

  // Filter to only assistant messages that have parts (skip empty)
  const assistantMessages = useMemo(
    () =>
      messages.filter(
        (msg) =>
          msg.role === "assistant" && msg.parts && msg.parts.length > 0,
      ),
    [messages],
  );

  return (
    <Conversation
      className="relative flex-1 min-w-0"
      aria-label="Thread activity"
      aria-busy={isStreaming}
      aria-live={isStreaming ? "off" : "polite"}
      initial={reduceMotion ? "instant" : "smooth"}
      resize={isStreaming || reduceMotion ? "instant" : "smooth"}
      data-thread-feed-scroll="true"
    >
      <ConversationContent
        className={
          compactMode
            ? "gap-1 px-1.5 py-1.5 md:gap-2 md:px-3 md:py-2.5"
            : "gap-1.5 px-2 py-2 md:gap-2.5 md:px-3 md:py-3"
        }
      >
        {/* Sentinel for loading older messages on scroll-up */}
        {hasOlderMessages && !isEmpty && (
          <div ref={sentinelRef} className="flex items-center justify-center py-2">
            {isLoadingOlder ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground/60" />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onLoadMore}
                className="text-muted-foreground/60 hover:text-muted-foreground"
              >
                <ChevronUp className="size-3" />
                Load earlier messages
              </Button>
            )}
          </div>
        )}

        {isEmpty ? (
          <ConversationEmptyState
            icon={
              isIdle ? (
                <MessagesSquare className="size-8 text-muted-foreground/70" />
              ) : (
                <LoaderCircle className="size-8 animate-spin text-muted-foreground/70" />
              )
            }
            title={isIdle ? "No activity yet" : "Waiting for events"}
            description={
              isIdle
                ? "Start with a prompt to kick off this thread."
                : "Agent activity appears here as soon as tools run."
            }
          />
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              from={message.role === "user" ? "user" : "assistant"}
              className="group max-w-full rounded-md border border-border/40 bg-card/20 content-auto"
            >
              <MessageContent
                className={
                  compactMode
                    ? "space-y-1 px-1.5 py-1 md:px-2 md:py-1.5"
                    : "space-y-1.5 px-2 py-1.5 md:space-y-2 md:px-2.5 md:py-2"
                }
              >
                <UIMessageRenderer
                  message={message}
                  participantsById={participantsById}
                  onSelectSubagent={onSelectSubagent}
                  selectedSubagentKey={selectedSubagentKey}
                />
              </MessageContent>
            </Message>
          ))
        )}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to latest" />
    </Conversation>
  );
});
