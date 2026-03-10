"use client";

import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { streamdownPlugins } from "@/lib/streamdown-plugins";

export type StreamdownRendererProps = ComponentProps<typeof Streamdown>;

export function StreamdownRenderer(props: StreamdownRendererProps) {
  return <Streamdown plugins={streamdownPlugins} {...props} />;
}

export function ReasoningRenderer({ children }: { children: string }) {
  return <StreamdownRenderer>{children}</StreamdownRenderer>;
}
