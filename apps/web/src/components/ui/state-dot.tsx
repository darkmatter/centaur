import { cn } from "@/lib/utils";
import { threadStateIcon, threadStateIconClassName } from "@/lib/status-semantics";

export function StateDot({ state, className }: { state: string; className?: string }) {
  const Icon = threadStateIcon(state);
  return <Icon aria-hidden="true" className={cn("size-3", threadStateIconClassName(state), className)} />;
}
