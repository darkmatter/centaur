"use client";

import { memo, useMemo, useState } from "react";
import { CheckCircle, ChevronRight, CircleX, LoaderCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useHaptics } from "@/components/haptics-provider";
import { describeToolCall, type ToolCall } from "@/lib/describe";
import { summarizeToolOutput } from "@/lib/viewer/tool-output-detect";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
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
import type { StepSource } from "@/lib/viewer/source-utils";

function mapToolState(call: ToolCall): NonNullable<ToolCall["uiState"]> {
  if (call.uiState) return call.uiState;
  if (call.state === "error") return "output-error";
  if (call.state === "done") return "output-available";
  return "input-available";
}

function looksLikeStackTrace(text: string): boolean {
  return /Traceback \(most recent call last\):/m.test(text) || (/^\s*at\s+/m.test(text) && /Error[:]/i.test(text));
}

const ToolCallItem = memo(function ToolCallItem({ call }: { call: ToolCall }) {
  const output = call.output ?? "";
  const errorText = call.errorText ?? "";
  const sources: StepSource[] = call.sources ?? [];
  const hasInput = Object.keys(call.input || {}).length > 0;
  const hasOutput = call.rawOutput !== undefined || Boolean(output);
  const hasErrorStack = Boolean(errorText) && looksLikeStackTrace(errorText);
  const [isOpen, setIsOpen] = useState(false);
  const { trigger } = useHaptics();
  const outputSummary = useMemo(
    () => summarizeToolOutput(call.rawOutput ?? output, call.name),
    [call.name, call.rawOutput, output],
  );

  function handleToolToggle(next: boolean) {
    trigger("light");
    setIsOpen(next);
  }

  return (
    <Tool open={isOpen} onOpenChange={handleToolToggle}>
      <ToolHeader
        title={describeToolCall(call.name, call.input)}
        detail={hasOutput ? outputSummary : undefined}
        type={`tool-${call.name}` as `tool-${string}`}
        state={mapToolState(call)}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={call.input} toolName={call.name} /> : null}
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

        {hasOutput ? (
          <ToolOutput
            output={output}
            rawOutput={call.rawOutput}
            toolName={call.name}
            hideSources={sources.length > 0}
            errorText={errorText || undefined}
          />
        ) : errorText && !hasErrorStack ? (
          <ToolOutput
            output=""
            rawOutput={call.rawOutput}
            toolName={call.name}
            hideSources={sources.length > 0}
            errorText={errorText}
          />
        ) : null}

        {!hasOutput && !errorText ? (
          <div className="text-xs text-muted-foreground italic">Awaiting output…</div>
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

function GroupStatusIcon({ loading, error }: { loading: number; error: number }) {
  if (error > 0) return <CircleX className="size-3.5 text-destructive shrink-0" />;
  if (loading > 0) return <LoaderCircle className="size-3.5 text-muted-foreground animate-spin shrink-0" />;
  return <CheckCircle className="size-3.5 text-primary shrink-0" />;
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
  const { trigger } = useHaptics();
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
  const [isOpen, setIsOpen] = useState(false);

  function handleToggle(nextOpen: boolean) {
    trigger("light");
    setIsOpen(nextOpen);
  }

  const statusLabel = loadingCount > 0
    ? `${doneCount} of ${calls.length}`
    : errorCount > 0
      ? `${doneCount}/${calls.length}`
      : calls.length === 1
        ? ""
        : `${calls.length}`;

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleToggle}
      className="group rounded-md border border-border/50 bg-card/30"
    >
      <CollapsibleTrigger
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 transition-colors hover:bg-accent/40 active:bg-accent/60 min-h-input-min md:min-h-0"
        data-touch-target
      >
        <ChevronRight className="size-3 text-muted-foreground/60 shrink-0 transition-transform duration-fast group-data-[state=open]:rotate-90" />
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="truncate flex-1 min-w-0 text-left text-label text-foreground/80">
          {summary}
        </span>
        {statusLabel && (
          <span className="text-detail font-mono text-muted-foreground tabular-nums shrink-0">
            {statusLabel}
          </span>
        )}
        <GroupStatusIcon loading={loadingCount} error={errorCount} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 pb-1.5 pl-2 md:pl-3">
        {calls.map((call) => (
          <ToolCallItem key={call.id} call={call} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
