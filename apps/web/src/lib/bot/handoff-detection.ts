import type { CanonicalEvent, ContentBlock } from "@/lib/normalize-harness-event";

export type HandoffInfo = {
  toolCallId: string;
  goal: string;
  follow: boolean;
};

export type HandoffResult = {
  toolCallId: string;
  newThreadKey: string;
  follow: boolean;
  goal: string;
};

export class HandoffDetector {
  private pending = new Map<string, HandoffInfo>();

  processEvent(event: CanonicalEvent): HandoffResult | null {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name === "handoff") {
          const input = block.input as { goal?: string; follow?: boolean };
          if (input.follow) {
            this.pending.set(block.id, {
              toolCallId: block.id,
              goal: input.goal || "",
              follow: true,
            });
          }
        }
      }
    }

    if (event.type === "tool" && event.content) {
      for (const block of event.content) {
        const info = this.pending.get(block.tool_use_id);
        if (!info) continue;
        this.pending.delete(block.tool_use_id);

        const newThreadKey = extractThreadKey(block.content);
        if (newThreadKey) {
          return {
            toolCallId: info.toolCallId,
            newThreadKey,
            follow: info.follow,
            goal: info.goal,
          };
        }
      }
    }

    return null;
  }
}

function extractThreadKey(content: unknown): string | null {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");

  // Try JSON parse first — amp emits {"newThreadID": "T-..."}
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const key =
        parsed.newThreadID ||
        parsed.new_thread_key ||
        parsed.thread_key ||
        parsed.slack_thread_key ||
        parsed.newThreadId;
      if (typeof key === "string" && key) return key;
    }
  } catch {
    // not JSON, fall through to regex
  }

  // Regex fallback for non-JSON formats
  const match = text.match(
    /(?:new_thread_key|thread_key|slack_thread_key|newThreadID|newThreadId)\s*[:=]\s*["']?([^\s"',}]+)/,
  );
  return match?.[1] || null;
}
