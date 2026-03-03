"use client";

import { useMemo, useState } from "react";
import { diffLines } from "diff";
import { Badge } from "@/components/ui/badge";
import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

const LANGUAGE_CLASSES: Record<string, string> = {
  ts: "bg-blue-500/10 text-blue-400",
  tsx: "bg-blue-500/10 text-blue-400",
  js: "bg-yellow-500/10 text-yellow-400",
  jsx: "bg-yellow-500/10 text-yellow-400",
  py: "bg-green-500/10 text-green-400",
  css: "bg-purple-500/10 text-purple-400",
  json: "bg-amber-500/10 text-amber-400",
  md: "bg-secondary text-muted-foreground",
  sh: "bg-green-500/10 text-green-400",
};

export function DiffCard({
  file,
  lang,
  oldStr,
  newStr,
  result,
}: {
  file: string;
  lang: string;
  oldStr: string;
  newStr: string;
  result?: string;
}) {
  const didFail = result != null && result.toLowerCase().includes("error");
  const [expanded, setExpanded] = useState(false);
  const chunks = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr]);
  const rows = useMemo(() => {
    const collected: Array<{
      kind: "add" | "remove" | "context";
      text: string;
      oldLine: number | null;
      newLine: number | null;
    }> = [];
    let oldLine = 1;
    let newLine = 1;
    for (const chunk of chunks) {
      const kind = chunk.added ? "add" : chunk.removed ? "remove" : "context";
      const lines = chunk.value
        .split("\n")
        .filter((line, index, arr) => index < arr.length - 1 || line.length > 0);
      for (const line of lines) {
        if (kind === "add") {
          collected.push({ kind, text: line, oldLine: null, newLine });
          newLine += 1;
        } else if (kind === "remove") {
          collected.push({ kind, text: line, oldLine, newLine: null });
          oldLine += 1;
        } else {
          collected.push({ kind, text: line, oldLine, newLine });
          oldLine += 1;
          newLine += 1;
        }
      }
    }
    return collected;
  }, [chunks]);
  const canToggle = rows.length > 80;
  const visibleRows = expanded ? rows : rows.slice(0, 80);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);

  return (
    <div className={`overflow-hidden rounded-md border ${didFail ? "border-destructive/30" : ""}`}>
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge className={LANGUAGE_CLASSES[lang] ?? "bg-secondary text-muted-foreground"}>{lang}</Badge>
          <span className="font-mono text-xs text-foreground truncate">{file}</span>
          {didFail && <Badge variant="destructive" className="text-[10px]">failed</Badge>}
        </div>
        <MessageActions>
          <MessageAction
            tooltip="Copy diff"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`--- old\n${oldStr}\n+++ new\n${newStr}`)
                .then(() => toast("Diff copied"))
                .catch(() => {});
            }}
          >
            <CopyIcon className="size-3.5" />
          </MessageAction>
        </MessageActions>
      </div>
      <pre className="p-3 text-[11px] font-mono overflow-auto overscroll-contain max-h-[360px]">
        {visibleRows.map((row, i) => (
          <span
            key={`${i}-${row.oldLine ?? "x"}-${row.newLine ?? "x"}`}
            className={
              row.kind === "add"
                ? "grid grid-cols-[52px_1fr] bg-green-500/10 text-green-300"
                : row.kind === "remove"
                  ? "grid grid-cols-[52px_1fr] bg-red-500/10 text-red-300"
                  : "grid grid-cols-[52px_1fr] text-muted-foreground"
            }
          >
            <span className="select-none pr-2 text-right text-[10px] text-muted-foreground">
              {row.newLine ?? row.oldLine ?? ""}
            </span>
            <span>{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "} {row.text}</span>
          </span>
        ))}
      </pre>
      {canToggle && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {expanded ? "Show less context" : `Show ${hiddenCount} more lines`}
        </button>
      )}
    </div>
  );
}
