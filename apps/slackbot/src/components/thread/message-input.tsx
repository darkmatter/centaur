"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { useHasHover } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

type InputMode = "idle" | "running" | "error";

type MessageInputProps = {
  mode: InputMode;
  onSend: (message: string) => Promise<void>;
  onStop?: () => Promise<void>;
  className?: string;
};

const MAX_ROWS = 6;
const LINE_HEIGHT = 22;
const PADDING_Y = 20;
const MAX_HEIGHT = MAX_ROWS * LINE_HEIGHT + PADDING_Y;

const PLACEHOLDERS: Record<InputMode, string> = {
  idle: "Send a message\u2026",
  running: "Agent is working\u2026",
  error: "Retry with new instructions\u2026",
};

export function MessageInput({ mode, onSend, onStop, className }: MessageInputProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const hasHover = useHasHover();

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useLayoutEffect(resize, [value, resize]);

  const hasText = value.trim().length > 0;
  const showStop = mode === "running" && !hasText && !!onStop;

  function handleSend() {
    const text = value.trim();
    if (!text || submitting) return;
    setValue("");
    // Fire-and-forget: onSend triggers the agent and opens the SSE stream,
    // which stays open until the agent finishes. We don't want to block the
    // input on that — just clear and refocus immediately.
    void onSend(text);
    textareaRef.current?.focus();
  }

  async function handleStop() {
    if (!onStop) return;
    setSubmitting(true);
    try {
      await onStop();
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (composingRef.current || e.nativeEvent.isComposing) return;

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSend();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && hasHover) {
      e.preventDefault();
      void handleSend();
    }
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const start = () => { composingRef.current = true; };
    const end = () => { composingRef.current = false; };
    el.addEventListener("compositionstart", start);
    el.addEventListener("compositionend", end);
    return () => {
      el.removeEventListener("compositionstart", start);
      el.removeEventListener("compositionend", end);
    };
  }, []);

  return (
    <div className={cn("flex-shrink-0 bg-background px-3 pb-3 pt-2", className)}>
      <form
        onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
        className={cn(
          "relative max-w-[720px] mx-auto",
          "rounded-2xl border border-border/60 bg-secondary/40",
          "focus-within:border-border",
          "transition-colors",
        )}
        aria-label="Message composer"
      >
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea
          ref={textareaRef}
          id="chat-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDERS[mode]}
          disabled={submitting}
          rows={1}
          aria-describedby="chat-input-hint"
          className={cn(
            "w-full min-h-[44px] resize-none",
            "text-[16px] md:text-sm leading-[22px]",
            "bg-transparent rounded-2xl pl-4 pr-14 py-3",
            "placeholder:text-muted-foreground text-foreground",
            "outline-none border-none focus:ring-0",
            submitting && "opacity-50",
          )}
          style={{ maxHeight: MAX_HEIGHT, fieldSizing: "content" } as React.CSSProperties}
        />
        <span id="chat-input-hint" className="sr-only">
          {hasHover ? "Press Enter to send, Shift+Enter for a new line" : "Tap send to submit"}
        </span>

        <div className="absolute right-2 bottom-2">
          {submitting ? (
            <button
              type="button"
              disabled
              className="size-8 flex-shrink-0 rounded-full flex items-center justify-center bg-primary/60 text-primary-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
            </button>
          ) : showStop ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              className="size-8 flex-shrink-0 rounded-full flex items-center justify-center bg-destructive/80 text-destructive-foreground transition-all duration-150 ring-2 ring-destructive/30 ring-offset-1 ring-offset-background"
              aria-label="Stop agent"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!hasText}
              className={cn(
                "size-8 flex-shrink-0 rounded-full flex items-center justify-center transition-all duration-150 outline-none",
                hasText
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground/60 pointer-events-none",
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>

      {/* Keyboard hints - desktop only */}
      {hasHover && (
        <div className="max-w-[720px] mx-auto flex items-center gap-3 px-1 pt-1 text-[10px] text-muted-foreground/60">
          {mode === "running" && !hasText ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              Working…
              {onStop && <span className="ml-1 text-muted-foreground/40">Press <kbd className="px-1 py-0.5 rounded border border-border/50 text-[9px] font-mono">S</kbd> to stop</span>}
            </span>
          ) : mode === "error" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-destructive" />
              Error — retry with new instructions
            </span>
          ) : hasText ? (
            <span>
              <kbd className="px-1 py-0.5 rounded border border-border/50 text-[9px] font-mono">↵</kbd> send · <kbd className="px-1 py-0.5 rounded border border-border/50 text-[9px] font-mono">⇧↵</kbd> new line
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
