import type { ReactNode } from "react";
import type { Harness } from "@/lib/types";

function Svg({
  className,
  children,
  viewBox = "0 0 24 24",
}: {
  className?: string;
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg viewBox={viewBox} aria-hidden className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

export function AmpIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 3L3.5 21h3.8l1.8-4h5.8l1.8 4h3.8L12 3Zm-1.4 10.7L12 10l1.4 3.7h-2.8Z" fill="currentColor" />
    </Svg>
  );
}

export function ClaudeIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 3a9 9 0 1 0 0 18h5v-3h-5a6 6 0 1 1 0-12h5V3h-5Z" fill="currentColor" />
      <path d="M16 9h4v6h-4z" fill="currentColor" />
    </Svg>
  );
}

export function OpenAIIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path
        d="M11.9 2.8a4.1 4.1 0 0 1 4.1 2.3l2 .1a4.1 4.1 0 0 1 3.6 6.2l1 1.7a4.1 4.1 0 0 1-2 5.6 4.1 4.1 0 0 1-4.7-.7l-1.7 1a4.1 4.1 0 0 1-6.1-3.6l-1.8-1a4.1 4.1 0 0 1-.7-7.2l1-1.7a4.1 4.1 0 0 1 5.3-2Zm.1 3a1.2 1.2 0 0 0-1.1.7l-.4.9-1 .2a1.2 1.2 0 0 0-.3 2.2l.8.5-.1 1a1.2 1.2 0 0 0 1.8 1.1l.8-.5.9.5a1.2 1.2 0 0 0 1.8-1.1l-.1-1 .8-.5a1.2 1.2 0 0 0-.3-2.2l-1-.2-.4-.9a1.2 1.2 0 0 0-1.1-.7Z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function PiMonoIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M5 8V5h14v3h-4v11h-3V8H9v11H6V8H5Z" fill="currentColor" />
    </Svg>
  );
}

export function ParadigmIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 3 3.5 19h17L12 3Zm0 5.3 3.5 6.2h-7L12 8.3Z" fill="currentColor" />
    </Svg>
  );
}

export function harnessIconFor(harness: Harness | string): React.ComponentType<{ className?: string }> {
  if (harness === "amp") return AmpIcon;
  if (harness === "claude-code") return ClaudeIcon;
  if (harness === "codex") return OpenAIIcon;
  if (harness === "pi-mono") return PiMonoIcon;
  if (harness === "eng" || harness === "engineer") return ParadigmIcon;
  if (harness === "legal") return ParadigmIcon;
  return PiMonoIcon;
}
