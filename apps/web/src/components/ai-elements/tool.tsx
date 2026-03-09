"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  LoaderCircleIcon,
  XCircleIcon,
} from "lucide-react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";
import { ToolOutputRenderer } from "./tool-output-renderer";
import { detectContentBlocks } from "@/lib/viewer/tool-output-detect";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group/tool w-full", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  detail?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

function StatusIcon({ state }: { state: ToolPart["state"] }) {
  switch (state) {
    case "approval-requested":
      return <ClockIcon className="size-3.5 text-status-warning shrink-0" />;
    case "input-available":
    case "input-streaming":
      return <LoaderCircleIcon className="size-3.5 text-muted-foreground animate-spin shrink-0" />;
    case "output-available":
    case "approval-responded":
      return <CheckCircleIcon className="size-3.5 text-primary shrink-0" />;
    case "output-error":
    case "output-denied":
      return <XCircleIcon className="size-3.5 text-destructive shrink-0" />;
    default:
      return null;
  }
}

export const ToolHeader = ({
  className,
  title,
  detail,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors hover:bg-accent/40",
        className,
      )}
      data-touch-target
      {...props}
    >
      <ChevronRightIcon className="size-3 text-muted-foreground/60 shrink-0 transition-transform duration-fast group-data-[state=open]/tool:rotate-90" />
      <span className="min-w-0 flex-1 truncate text-left text-foreground/80">{title ?? derivedName}</span>
      {detail ? (
        <span className="hidden max-w-[45%] truncate text-detail text-muted-foreground md:block group-data-[state=open]/tool:hidden">
          {detail}
        </span>
      ) : null}
      <span className="ml-auto shrink-0">
        <StatusIcon state={state} />
      </span>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("space-y-2 px-2 pb-2 pt-1 text-popover-foreground", className)}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
  toolName?: string;
};

function formatToolInput(input: Record<string, unknown>, toolName?: string): { code: string; language: string } {
  const name = (toolName ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const isShell = /^(shell|bash|command_execution)$/.test(name);
  const isRead = /^(read_file|read|readfile)$/.test(name);
  const isGrep = /^(grep_search|grep|grepsearch)$/.test(name);
  const isEdit = /^(str_replace|strreplace|edit_file)$/.test(name);
  const isWrite = /^(write_file|write|writefile|create_file|createfile)$/.test(name);

  if (isShell && typeof input.command === "string") {
    const cmd = input.command as string;
    const cwd = input.working_directory ?? input.cwd;
    const prefix = cwd ? `$ cd ${cwd}\n$ ` : "$ ";
    return { code: `${prefix}${cmd}`, language: "bash" };
  }

  if (isRead && typeof input.path === "string") {
    return { code: input.path as string, language: "text" };
  }

  if (isGrep) {
    const parts: string[] = [];
    if (input.pattern) parts.push(`pattern: ${input.pattern}`);
    if (input.path) parts.push(`path: ${input.path}`);
    if (input.glob) parts.push(`glob: ${input.glob}`);
    return { code: parts.join("\n"), language: "text" };
  }

  if (isEdit && typeof input.path === "string") {
    const parts: string[] = [`file: ${input.path}`];
    if (input.old_str || input.old) parts.push(`old: ${input.old_str ?? input.old}`);
    if (input.new_str || input.new) parts.push(`new: ${input.new_str ?? input.new}`);
    return { code: parts.join("\n"), language: "text" };
  }

  if (isWrite && typeof input.path === "string") {
    const content = (input.content ?? input.new_string ?? "") as string;
    const ext = (input.path as string).split(".").pop() ?? "text";
    return { code: content, language: ext };
  }

  if (/^(task|subagent|sub_agent)$/.test(name)) {
    const parts: string[] = [];
    if (input.description) parts.push(`Task: ${input.description}`);
    if (typeof input.prompt === "string") {
      const prompt = (input.prompt as string).slice(0, 200);
      parts.push(prompt);
    }
    if (parts.length > 0) return { code: parts.join("\n"), language: "text" };
  }

  if (/^(web_search|websearch|search)$/.test(name) && (input.query || input.search_query)) {
    return { code: `search: ${input.query ?? input.search_query}`, language: "text" };
  }

  if (/^(web_fetch|read_web_page|readwebpage)$/.test(name) && typeof input.url === "string") {
    return { code: input.url as string, language: "text" };
  }

  if (/^(glob|list_dir|listdir|list)$/.test(name)) {
    const target = input.pattern ?? input.path ?? input.filePattern ?? input.directory;
    if (typeof target === "string") return { code: target as string, language: "text" };
  }

  const entries = Object.entries(input).filter(([, v]) => v != null);
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    return { code: entries[0][1] as string, language: "text" };
  }
  const allSimple = entries.every(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  if (allSimple && entries.length > 0) {
    return { code: entries.map(([k, v]) => `${k}: ${v}`).join("\n"), language: "text" };
  }
  return { code: JSON.stringify(input, null, 2), language: "json" };
}

export const ToolInput = ({ className, input, toolName, ...props }: ToolInputProps) => {
  const { code, language } = formatToolInput(
    input as Record<string, unknown>,
    toolName,
  );
  return (
    <div className={cn("overflow-hidden tool-compact-code", className)} {...props}>
      <div className="rounded-md bg-muted/40">
        <CodeBlock code={code} language={language as import("shiki").BundledLanguage} />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
  rawOutput?: unknown;
  toolName?: string;
  hideSources?: boolean;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  rawOutput,
  toolName,
  hideSources,
  ...props
}: ToolOutputProps) => {
  const hiddenOnlySources =
    !errorText &&
    hideSources &&
    rawOutput !== undefined &&
    detectContentBlocks(rawOutput, { toolName }).every((block) => block.type === "sources");

  if (hiddenOnlySources) {
    return null;
  }

  if (!(output || errorText || rawOutput !== undefined)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (
    rawOutput !== undefined ||
    (typeof output === "object" && !isValidElement(output)) ||
    typeof output === "string"
  ) {
    Output = (
      <ToolOutputRenderer
        output={typeof output === "string" ? output : undefined}
        rawOutput={rawOutput ?? (typeof output === "object" && !isValidElement(output) ? output : undefined)}
        toolName={toolName}
        hideSources={hideSources}
      />
    );
  }

  return (
    <div className={cn("overflow-hidden tool-compact-code", className)} {...props}>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/8 text-destructive"
            : "bg-muted/40 text-foreground",
        )}
      >
        {errorText && <div className="px-2 py-1.5 text-xs">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
