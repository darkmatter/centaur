import type { Harness } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { harnessIconFor } from "@/components/icons/harness-icons";

interface HarnessBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  harness: Harness | string;
}

const HARNESS_STYLES: Record<string, string> = {
  amp: "bg-cyan-500/10 text-cyan-400",
  "claude-code": "bg-violet-500/10 text-violet-400",
  codex: "bg-emerald-500/10 text-emerald-400",
  "pi-mono": "bg-blue-500/10 text-blue-400",
  eng: "bg-primary/10 text-primary",
  engineer: "bg-primary/10 text-primary",
};

export function HarnessBadge({ harness, className, ...props }: HarnessBadgeProps) {
  const Icon = harnessIconFor(harness);
  return (
    <Badge
      className={cn(
        "rounded-sm text-[10px] font-semibold uppercase tracking-wider inline-flex items-center gap-1",
        HARNESS_STYLES[harness] ?? "bg-secondary text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Icon className="size-3 shrink-0" />
      {harness}
    </Badge>
  );
}
