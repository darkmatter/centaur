"use client";

import { lazy, memo, Suspense, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { RenderErrorBoundary } from "@/components/ai-elements/render-error-boundary";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { useHaptics } from "@/components/haptics-provider";
import type { ComponentNode } from "@/components/dashboard/types";
import {
  detectContentBlocks,
  stringifyToolOutput,
  type ChartBlock,
  type ContentBlock,
  type EntityBlock,
  type TableBlock,
} from "@/lib/viewer/tool-output-detect";

const RenderNode = lazy(() =>
  import("@/components/dashboard/component-renderer").then((module) => ({
    default: module.RenderNode,
  })),
);

function RenderNodeFallback() {
  return <div className="h-24 rounded-md border border-border bg-muted/30 animate-pulse" />;
}

function RawFallback({ rawOutput, output }: { rawOutput: unknown; output?: string }) {
  const code = output ?? stringifyToolOutput(rawOutput) ?? "";
  const language = code.trimStart().startsWith("{") || code.trimStart().startsWith("[") ? "json" : "markdown";
  return <CodeBlock code={code} language={language} />;
}

function toTableNode(block: TableBlock): ComponentNode {
  return {
    type: "data-table",
    title: block.title,
    columns: block.columns,
    data: block.data,
    searchable: true,
    compact: true,
  };
}

function toEntityNode(block: EntityBlock): ComponentNode {
  return {
    type: "detail-kv",
    title: block.title,
    columns: 2,
    items: block.items,
  };
}

function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <Suspense fallback={<RenderNodeFallback />}>
      <RenderNode node={toTableNode(block)} />
    </Suspense>
  );
}

function EntityBlockView({ block }: { block: EntityBlock }) {
  return (
    <Suspense fallback={<RenderNodeFallback />}>
      <RenderNode node={toEntityNode(block)} />
    </Suspense>
  );
}

function ChartBlockView({ block }: { block: ChartBlock }) {
  const [mode, setMode] = useState<"chart" | "table">(block.chartType === "line" ? "chart" : "table");
  const { trigger } = useHaptics();

  const chartNode: ComponentNode =
    block.chartType === "line"
      ? {
          type: "line-chart",
          title: block.title ?? `${block.yKeys.join(", ")} by ${block.xKey}`,
          xKey: block.xKey,
          yKeys: block.yKeys,
          data: block.data,
        }
      : {
          type: "bar-chart",
          title: block.title ?? `${block.yKeys[0] ?? "Value"} by ${block.xKey}`,
          categoryKey: block.xKey,
          valueKey: block.yKeys[0] ?? block.xKey,
          data: block.data,
        };

  const tableNode = toTableNode({
    type: "table",
    title: block.title,
    columns: block.columns,
    data: block.data,
    rowCount: block.rowCount,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          type="button"
          variant={mode === "chart" ? "secondary" : "ghost"}
          onClick={() => {
            trigger("selection");
            setMode("chart");
          }}
        >
          Chart
        </Button>
        <Button
          size="sm"
          type="button"
          variant={mode === "table" ? "secondary" : "ghost"}
          onClick={() => {
            trigger("selection");
            setMode("table");
          }}
        >
          Table
        </Button>
      </div>
      <Suspense fallback={<RenderNodeFallback />}>
        <RenderNode node={mode === "chart" ? chartNode : tableNode} />
      </Suspense>
    </div>
  );
}

function SourcesBlockView({
  items,
}: {
  items: Array<{ url: string; title: string; snippet?: string }>;
}) {
  return (
    <Sources>
      <SourcesTrigger count={items.length} />
      <SourcesContent>
        {items.map((item) => (
          <Source key={item.url} href={item.url} title={item.title}>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{item.title}</span>
              {item.snippet ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">{item.snippet}</span>
              ) : null}
            </div>
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}

function ContentBlockView({
  block,
  hideSources,
}: {
  block: ContentBlock;
  hideSources?: boolean;
}) {
  switch (block.type) {
    case "markdown":
      return (
        <div className="rounded-md border border-border/60 bg-card/60 px-3 py-2">
          <MessageResponse>{block.text}</MessageResponse>
        </div>
      );
    case "table":
      return <TableBlockView block={block} />;
    case "chart":
      return <ChartBlockView block={block} />;
    case "entity":
      return <EntityBlockView block={block} />;
    case "sources":
      return hideSources ? null : <SourcesBlockView items={block.items} />;
    case "image":
      return (
        <a
          href={block.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-md border border-border bg-card/60 px-3 py-2 text-sm text-primary underline-offset-4 hover:underline"
        >
          Open image: {block.url}
        </a>
      );
    case "raw":
      return <RawFallback rawOutput={block.text} output={block.text} />;
    default:
      return null;
  }
}

export const ToolOutputRenderer = memo(function ToolOutputRenderer({
  output,
  rawOutput,
  toolName,
  hideSources,
}: {
  output?: string;
  rawOutput?: unknown;
  toolName?: string;
  hideSources?: boolean;
}) {
  const sourceValue = output ?? rawOutput ?? "";
  const visibleBlocks = useMemo(
    () =>
      detectContentBlocks(sourceValue, { toolName }).filter((block) =>
        !(hideSources && block.type === "sources"),
      ),
    [hideSources, sourceValue, toolName],
  );

  if (visibleBlocks.length === 0) {
    return null;
  }

  return (
    <RenderErrorBoundary rawOutput={sourceValue}>
      <div className="space-y-3">
        {visibleBlocks.map((block, index) => (
          <ContentBlockView
            key={`${block.type}-${index}`}
            block={block}
            hideSources={hideSources}
          />
        ))}
      </div>
    </RenderErrorBoundary>
  );
});
