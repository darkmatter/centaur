"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { useHaptics } from "@/components/haptics-provider";
import { useKeyboardHeight } from "@/hooks/use-visual-viewport";
import { Button } from "@/components/ui/button";
import { ChatTextarea } from "@/components/ui/chat-textarea";
import { SurfaceBar } from "@/components/ui/surface-bar";
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
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const keyboardHeight = useKeyboardHeight();
  const effectiveKeyboardHeight = isFocused ? keyboardHeight : 0;
  const { trigger } = useHaptics();

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useLayoutEffect(resize, [value, resize]);

  const hasText = value.trim().length > 0;
  const showStop = mode === "running" && !!onStop;

  async function handleSend() {
    const text = value.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await onSend(text);
      setValue("");
      window.requestAnimationFrame(() => trigger("success"));
    } catch {
      window.requestAnimationFrame(() => trigger("error"));
      toast("Unable to send message. Please try again.");
    } finally {
      setSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  async function handleStop() {
    if (!onStop) return;
    trigger("warning");
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

    if (e.key === "Enter" && !e.shiftKey) {
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
    <SurfaceBar
      className={cn(
        "flex-shrink-0 border-t border-border/70 px-2.5 py-2",
        className,
      )}
      style={{
        paddingBottom:
          effectiveKeyboardHeight > 0
            ? `${Math.max(8, effectiveKeyboardHeight)}px`
            : "max(8px, env(safe-area-inset-bottom))",
      }}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
        className="thread-surface mx-auto flex max-w-content-max items-end gap-1.5 rounded-xl px-3 py-1.5 md:gap-2 md:px-3.5 md:py-2"
        aria-label="Message composer"
      >
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <ChatTextarea
          ref={textareaRef}
          id="chat-input"
          name="chat-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={PLACEHOLDERS[mode]}
          disabled={submitting}
          rows={1}
          enterKeyHint="send"
          autoComplete="off"
          aria-describedby="chat-input-hint"
        />
        <span id="chat-input-hint" className="sr-only">
          Press Enter to send, Shift+Enter for a new line.
        </span>

        {submitting ? (
          <Button type="button" disabled aria-label="Sending message" variant="default" size="icon-sm" className="flex-shrink-0 rounded-lg bg-primary/60 text-primary-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          </Button>
        ) : (
          <>
            {showStop ? (
              <Button type="button" onClick={() => void handleStop()} variant="destructive" size="icon-sm" className="flex-shrink-0 rounded-lg bg-destructive/80 transition-colors duration-base ease-standard hover:bg-destructive" aria-label="Stop agent">
                <Square aria-hidden="true" className="size-3.5" />
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={!hasText}
              variant="ghost"
              size="icon-sm"
              className={cn(
                "flex-shrink-0 rounded-lg transition-colors duration-base ease-standard",
                hasText
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-muted-foreground/20 text-muted-foreground/30 pointer-events-none",
              )}
              aria-label="Send message"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
          </>
        )}
      </form>
    </SurfaceBar>
  );
}
