"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, LoaderCircle, X as XIcon, Check } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { describeToolCall, type ToolCall } from "@/lib/describe";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from "@/components/ai-elements/sources";
import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceFrames,
  StackTraceHeader,
} from "@/components/ai-elements/stack-trace";
import { useIsMobile } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { StepSource } from "@/lib/source-utils";

function mapToolState(call: ToolCall): NonNullable<ToolCall["uiState"]> {
  if (call.uiState) return call.uiState;
  if (call.state === "error") return "output-error";
  if (call.state === "done") return "output-available";
  return "input-available";
}

function looksLikeStackTrace(text: string): boolean {
  return /Traceback \(most recent call last\):/m.test(text) || (/^\s*at\s+/m.test(text) && /Error[:]/i.test(text));
}

function PillStatusIcon({ loading, error }: { loading: number; error: number }) {
  if (error > 0) return <XIcon className="size-4 text-destructive flex-shrink-0" />;
  if (loading > 0) return <LoaderCircle className="size-4 text-muted-foreground animate-spin flex-shrink-0" />;
  return <Check className="size-4 text-green-500 flex-shrink-0" />;
}

function shouldAutoExpandTool(call: ToolCall): boolean {
  const state = mapToolState(call);
  return state === "approval-requested" || state === "input-available" || state === "input-streaming" || state === "output-error" || state === "output-denied";
}

const ToolCallItem = memo(function ToolCallItem({ call }: { call: ToolCall }) {
  const output = call.output ?? "";
  const errorText = call.errorText ?? "";
  const sources: StepSource[] = call.sources ?? [];
  const hasInput = Object.keys(call.input || {}).length > 0;
  const isJson = output.trimStart().startsWith("{") || output.trimStart().startsWith("[");
  const hasErrorStack = Boolean(errorText) && looksLikeStackTrace(errorText);
  const [isOpen, setIsOpen] = useState(() => shouldAutoExpandTool(call));

  useEffect(() => {
    if (shouldAutoExpandTool(call)) {
      setIsOpen(true);
    }
  }, [call]);

  return (
    <Tool open={isOpen} onOpenChange={setIsOpen}>
      <ToolHeader
        title={describeToolCall(call.name, call.input)}
        type={`tool-${call.name}` as `tool-${string}`}
        state={mapToolState(call)}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={call.input} /> : null}
        {sources.length > 0 ? (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((source) => (
                <Source key={source.url} href={source.url} title={source.title}>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{source.title}</span>
                    {source.snippet ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{source.snippet}</span>
                    ) : null}
                  </div>
                </Source>
              ))}
            </SourcesContent>
          </Sources>
        ) : null}

        {hasErrorStack ? (
          <StackTrace trace={errorText} defaultOpen className="border-destructive/30">
            <StackTraceHeader>
              <StackTraceError>
                <StackTraceErrorType />
                <StackTraceErrorMessage />
              </StackTraceError>
              <StackTraceActions>
                <StackTraceCopyButton />
              </StackTraceActions>
              <StackTraceExpandButton />
            </StackTraceHeader>
            <StackTraceContent>
              <StackTraceFrames />
            </StackTraceContent>
          </StackTrace>
        ) : null}

        {output ? (
          isJson ? (
            <CodeBlock code={output} language="json" />
          ) : (
            <ToolOutput output={output} errorText={errorText || undefined} />
          )
        ) : errorText && !hasErrorStack ? (
          <ToolOutput output="" errorText={errorText} />
        ) : null}

        {!output && !errorText ? (
          <div className="text-xs text-muted-foreground">Awaiting tool output…</div>
        ) : null}
      </ToolContent>
    </Tool>
  );
});

function hasToolInFlight(call: ToolCall): boolean {
  if (call.uiState) {
    return (
      call.uiState === "input-available" ||
      call.uiState === "input-streaming" ||
      call.uiState === "approval-requested"
    );
  }
  return call.state === "loading" || !call.state;
}

function isToolDone(call: ToolCall): boolean {
  if (call.uiState) {
    return call.uiState === "output-available" || call.uiState === "approval-responded";
  }
  return call.state === "done";
}

function isToolError(call: ToolCall): boolean {
  if (call.uiState) {
    return call.uiState === "output-error" || call.uiState === "output-denied";
  }
  return call.state === "error";
}

export function StepGroup({
  icon: Icon,
  summary,
  calls,
}: {
  icon: React.ComponentType<{ className?: string }>;
  summary: string;
  calls: ToolCall[];
}) {
  const isMobile = useIsMobile();
  const { loadingCount, errorCount, doneCount } = useMemo(() => {
    let loading = 0;
    let error = 0;
    let done = 0;
    for (const call of calls) {
      if (hasToolInFlight(call)) loading += 1;
      if (isToolError(call)) error += 1;
      if (isToolDone(call)) done += 1;
    }
    return { loadingCount: loading, errorCount: error, doneCount: done };
  }, [calls]);
  const manuallyToggled = useRef(false);
  const previousLoadingCount = useRef(loadingCount);
  const hasBeenActive = useRef(false);
  const [forceOpen, setForceOpen] = useState(!isMobile);

  useEffect(() => {
    if (loadingCount > 0) {
      hasBeenActive.current = true;
    }
  }, [loadingCount]);

  useEffect(() => {
    const wasLoading = previousLoadingCount.current > 0;
    previousLoadingCount.current = loadingCount;
    if (isMobile || manuallyToggled.current) return;
    if (loadingCount > 0 || errorCount > 0) {
      setForceOpen(true);
      return;
    }
    if (!wasLoading || !hasBeenActive.current) return;
    const timeout = window.setTimeout(() => setForceOpen(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [errorCount, isMobile, loadingCount]);

  useEffect(() => {
    if (!isMobile && loadingCount > 0) {
      manuallyToggled.current = false;
    }
  }, [isMobile, loadingCount]);

  const isOpen = forceOpen;

  function handleToggle(nextOpen: boolean) {
    manuallyToggled.current = true;
    setForceOpen(nextOpen);
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleToggle}
      className={cn(
        "group rounded-lg md:rounded-none",
        isMobile
          ? "bg-secondary/30 border border-border/30"
          : "border-0 border-l-2 border-l-border/70 bg-transparent pl-1",
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors",
          isMobile ? "min-h-[44px] active:bg-secondary/60" : "hover:bg-accent/50",
        )}
      >
        {isMobile ? (
          <PillStatusIcon loading={loadingCount} error={errorCount} />
        ) : (
          <>
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <Icon className="size-3.5 text-primary" />
          </>
        )}
        <span
          className={cn(
            "truncate flex-1 min-w-0 text-left",
            isMobile ? "text-sm text-muted-foreground" : "text-sm text-foreground",
          )}
        >
          {summary}
        </span>
        {!isMobile && (
          errorCount > 0 ? (
            <CircleX className="ml-auto size-3.5 text-destructive" />
          ) : loadingCount > 0 ? (
            <LoaderCircle className="ml-auto size-3.5 text-muted-foreground animate-spin" />
          ) : (
            <CircleCheck className="ml-auto size-3.5 text-primary" />
          )
        )}
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums flex-shrink-0">
          {doneCount}/{calls.length}
        </span>
        {isMobile && (
          <ChevronRight
            className={cn(
              "size-4 text-muted-foreground/50 transition-transform flex-shrink-0",
              isOpen && "rotate-90",
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2 pl-4 md:pl-6 space-y-2">
        {calls.map((call) => (
          <ToolCallItem key={call.id} call={call} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
