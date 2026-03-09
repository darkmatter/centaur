"use client";

import { memo, useMemo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageAction, MessageActions } from "@/components/ai-elements/message";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  css: "css",
  json: "json",
  md: "markdown",
  sh: "bash",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  html: "html",
  sql: "sql",
  sol: "solidity",
};

const LANGUAGE_CLASSES: Record<string, string> = {
  ts: "bg-primary/10 text-primary",
  tsx: "bg-primary/10 text-primary",
  js: "bg-primary/10 text-primary",
  jsx: "bg-primary/10 text-primary",
  py: "bg-primary/10 text-primary",
  css: "bg-primary/10 text-primary",
  json: "bg-primary/10 text-primary",
  md: "bg-secondary text-muted-foreground",
  sh: "bg-primary/10 text-primary",
};

export const DiffCard = memo(function DiffCard({
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
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");

  const oldFile = useMemo<FileContents>(
    () => ({
      name: file,
      contents: oldStr,
      lang: (EXT_TO_LANG[lang] ?? lang ?? "text") as FileContents["lang"],
    }),
    [file, oldStr, lang],
  );

  const newFile = useMemo<FileContents>(
    () => ({
      name: file,
      contents: newStr,
      lang: (EXT_TO_LANG[lang] ?? lang ?? "text") as FileContents["lang"],
    }),
    [file, newStr, lang],
  );

  return (
    <div
      className={`overflow-hidden rounded-md border border-border/80 bg-card/55 shadow-ring-subtle ${didFail ? "border-destructive/30" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-border/80 bg-background/60 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge className={LANGUAGE_CLASSES[lang] ?? "bg-secondary text-muted-foreground"}>
            {lang}
          </Badge>
          <span className="font-mono text-xs text-foreground truncate">{file}</span>
          {didFail && (
            <Badge variant="destructive" className="text-xs">
              failed
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setDiffStyle(diffStyle === "unified" ? "split" : "unified")}
            className="text-3xs font-medium"
          >
            {diffStyle === "unified" ? "Split" : "Unified"}
          </Button>
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
      </div>
      <div className="max-h-diff-max overflow-auto overscroll-contain [&_*]:text-xs">
        <MultiFileDiff
          oldFile={oldFile}
          newFile={newFile}
          options={{
            theme: "pierre-dark",
            diffStyle,
            diffIndicators: "bars",
            lineDiffType: "word-alt",
            overflow: "scroll",
            disableFileHeader: true,
          }}
        />
      </div>
    </div>
  );
});
