"use client";

import type { MutableRefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { Terminal, TerminalActions, TerminalContent, TerminalCopyButton, TerminalHeader, TerminalStatus, TerminalTitle } from "./terminal";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useThreadMotion } from "@/motion/provider";

const PREVIEW_ROWS = 5;
const PREVIEW_ROW_HEIGHT = 22;
const MAX_TRACKED_ROWS = 80;
const TEXT_RENDER_THROTTLE_MS = 90;

type PreviewRow = { id: string; text: string };

function previewRows(output: string): PreviewRow[] {
  const lines = output
    .split(/\r\n|\n|\r/g)
    .map((item) => item.trimEnd())
    .filter(Boolean);
  const start = Math.max(0, lines.length - MAX_TRACKED_ROWS);
  return lines.slice(start).map((text, index) => ({
    id: `line:${start + index}`,
    text,
  }));
}

function useThrottledString(value: string, wait = TEXT_RENDER_THROTTLE_MS): string {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    const remaining = wait - (now - lastRef.current);
    if (remaining <= 0) {
      lastRef.current = now;
      setThrottled(value);
      return;
    }
    const timer = window.setTimeout(() => {
      lastRef.current = Date.now();
      setThrottled(value);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [value, wait]);

  return throttled;
}

function useHeldFlag(active: boolean, wait = 1800): boolean {
  const [held, setHeld] = useState(active);

  useEffect(() => {
    if (active) {
      setHeld(true);
      return;
    }
    const timer = window.setTimeout(() => setHeld(false), wait);
    return () => window.clearTimeout(timer);
  }, [active, wait]);

  return held;
}

function WipeRevealText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { reducedMotion } = useThreadMotion();

  return (
    <motion.div
      className={className}
      style={
        reducedMotion
          ? undefined
          : {
              maskImage: "linear-gradient(to right, black 45%, transparent 60%)",
              WebkitMaskImage: "linear-gradient(to right, black 45%, transparent 60%)",
              maskSize: "240% 100%",
              WebkitMaskSize: "240% 100%",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }
      }
      initial={
        reducedMotion
          ? false
          : {
              opacity: 0,
              filter: "blur(3px)",
              x: -4,
              maskPosition: "100% 0%",
            }
      }
      animate={
        reducedMotion
          ? { opacity: 1 }
          : {
              opacity: 1,
              filter: "blur(0px)",
              x: 0,
              maskPosition: "0% 0%",
            }
      }
      transition={
        reducedMotion
          ? { duration: 0.08 }
          : { type: "spring", stiffness: 420, damping: 38, mass: 0.82 }
      }
    >
      {text}
    </motion.div>
  );
}

function RollingPreviewRow({
  row,
  seen,
}: {
  row: PreviewRow;
  seen: MutableRefObject<Set<string>>;
}) {
  const { reducedMotion } = useThreadMotion();
  const seenBefore = seen.current.has(row.id);

  useEffect(() => {
    seen.current.add(row.id);
  }, [row.id, seen]);

  return (
    <motion.div
      className="h-[22px] min-h-[22px] overflow-hidden"
      style={
        reducedMotion || seenBefore
          ? undefined
          : {
              maskImage: "linear-gradient(to right, black 45%, transparent 60%)",
              WebkitMaskImage: "linear-gradient(to right, black 45%, transparent 60%)",
              maskSize: "240% 100%",
              WebkitMaskSize: "240% 100%",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }
      }
      initial={
        reducedMotion || seenBefore
          ? false
          : {
              opacity: 0,
              filter: "blur(2px)",
              x: -4,
              maskPosition: "100% 0%",
            }
      }
      animate={
        reducedMotion || seenBefore
          ? { opacity: 1 }
          : {
              opacity: 1,
              filter: "blur(0px)",
              x: 0,
              maskPosition: "0% 0%",
            }
      }
      transition={
        reducedMotion
          ? { duration: 0.08 }
          : { type: "spring", stiffness: 420, damping: 38, mass: 0.82 }
      }
    >
      <div className="truncate text-foreground/85">{row.text}</div>
    </motion.div>
  );
}

export function ShellExecutionCard({
  command,
  output,
  exitCode,
  streaming = false,
}: {
  command: string;
  output?: string;
  exitCode?: number;
  streaming?: boolean;
}) {
  const { reducedMotion } = useThreadMotion();
  const throttledOutput = useThrottledString(output ?? "");
  const rows = useMemo(() => previewRows(throttledOutput), [throttledOutput]);
  const [expanded, setExpanded] = useState(!streaming);
  const heldStreaming = useHeldFlag(streaming);
  const rowSeenRef = useRef(new Set<string>());
  const isFailed = typeof exitCode === "number" && exitCode !== 0;
  const combinedOutput = [`$ ${command}`, throttledOutput, exitCode !== undefined ? `[exit ${exitCode}]` : ""]
    .filter(Boolean)
    .join("\n");
  const visibleRows = rows.slice(-PREVIEW_ROWS);
  const hiddenRowCount = Math.max(0, rows.length - visibleRows.length);
  const rowStep = PREVIEW_ROW_HEIGHT;
  const trackOffset = hiddenRowCount * rowStep;
  const showPreview = !expanded;

  useEffect(() => {
    if (!streaming) return;
    setExpanded(false);
  }, [streaming]);

  return (
    <Terminal
      output={combinedOutput}
      isStreaming={streaming}
      className={isFailed ? "border-destructive/30" : "border-border/70"}
    >
      <TerminalHeader>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-[var(--dur-fast)]",
              expanded && "rotate-90",
            )}
          />
          <TerminalTitle>{streaming || heldStreaming ? "Shell" : "Ran shell command"}</TerminalTitle>
        </button>
        <div className="flex items-center gap-1">
          <TerminalStatus />
          {typeof exitCode === "number" && (
            <Badge variant={isFailed ? "destructive" : "secondary"} className="text-xs">
              exit {exitCode}
            </Badge>
          )}
          <TerminalActions>
            <TerminalCopyButton />
          </TerminalActions>
        </div>
      </TerminalHeader>
      {showPreview ? (
        <div className="thread-surface-soft overflow-hidden px-2.5 py-2 font-mono text-[12px] leading-relaxed">
          <WipeRevealText className="mb-1 text-muted-foreground" text={`$ ${command}`} />
          <div className="overflow-hidden [mask-image:linear-gradient(to_bottom,black,black_calc(100%-10px),transparent)]">
            <motion.div
              animate={{ y: -trackOffset }}
              transition={
                reducedMotion
                  ? { duration: 0.08 }
                  : { type: "spring", stiffness: 420, damping: 38, mass: 0.82 }
              }
            >
              <div
                className="space-y-0"
                style={{
                  height: PREVIEW_ROWS * PREVIEW_ROW_HEIGHT,
                  paddingTop: hiddenRowCount * PREVIEW_ROW_HEIGHT,
                }}
              >
                {visibleRows.map((row) => (
                  <RollingPreviewRow key={row.id} row={row} seen={rowSeenRef} />
                ))}
                {rows.length === 0 ? (
                  <div className="h-[22px] text-muted-foreground/70">
                    {reducedMotion ? "Running..." : streaming || heldStreaming ? "Collecting output..." : "No output"}
                  </div>
                ) : null}
              </div>
            </motion.div>
          </div>
          {!streaming && rows.length > PREVIEW_ROWS ? (
            <div className="mt-1 text-[11px] text-muted-foreground/70">
              {rows.length} lines captured
            </div>
          ) : null}
        </div>
      ) : (
        <TerminalContent className="max-h-64" />
      )}
    </Terminal>
  );
}
