"use client";

import { LoaderCircle, MessagesSquare } from "lucide-react";
import { useMemo } from "react";
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
import { MessagePartRenderer } from "@/components/ai-elements/message-part-renderer";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Step } from "@/lib/describe";
import { groupStepsByTurn } from "@/lib/thread-hierarchy";
import type { Participant } from "@/lib/types";

export function ActivityFeed({
  steps,
  state,
  isStreaming,
  participants,
  turnDurationsById = {},
  compactMode = false,
}: {
  steps: Step[];
  state?: string;
  isStreaming?: boolean;
  participants?: Participant[];
  turnDurationsById?: Record<number, number>;
  compactMode?: boolean;
}) {
  const participantsById = useMemo(
    () => new Map((participants || []).map((p) => [p.id, p])),
    [participants],
  );
  const turnGroups = useMemo(() => groupStepsByTurn(steps, true), [steps]);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isEmpty = steps.length === 0;
  const isIdle = state === "idle" || state === "stopped";

  return (
    <Conversation
      className="relative flex-1"
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
            ? "gap-2 px-3 py-2 md:gap-2.5 md:px-4 md:py-3"
            : "gap-2.5 px-4 py-3 md:gap-3 md:px-5 md:py-4"
        }
      >
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
                ? "Send a message below to start the agent."
                : "The agent is processing your request."
            }
          />
        ) : (
          turnGroups.map((group) => (
            <Message
              key={group.groupKey}
              from="assistant"
              className="max-w-full rounded-sm border border-border/70 bg-card/50 [content-visibility:auto] [contain-intrinsic-size:220px]"
              data-turn={group.turnId === null ? "context" : String(group.turnId)}
            >
              <MessageContent className={compactMode ? "space-y-1.5 px-2.5 py-2" : "space-y-2 px-3 py-2.5"}>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                <div className="space-y-2">
                  {group.steps.map((step) => (
                    <MessagePartRenderer
                      key={step.id}
                      step={step}
                      participantsById={participantsById}
                      turnDurationsById={turnDurationsById}
                    />
                  ))}
                </div>
              </MessageContent>
            </Message>
          ))
        )}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to latest" />
    </Conversation>
  );
}
