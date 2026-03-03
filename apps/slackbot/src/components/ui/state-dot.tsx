import { cn } from "@/lib/utils";
import { Circle, CircleStop, CircleX, LoaderCircle } from "lucide-react";

export function StateDot({ state, className }: { state: string; className?: string }) {
  if (state === "running" || state === "working") {
    return <LoaderCircle aria-hidden="true" className={cn("size-3 text-primary animate-spin", className)} />;
  }
  if (state === "stopping") {
    return <CircleStop aria-hidden="true" className={cn("size-3 text-amber-400 animate-pulse", className)} />;
  }
  if (state === "error") {
    return <CircleX aria-hidden="true" className={cn("size-3 text-destructive", className)} />;
  }
  if (state === "stopped") {
    return <CircleStop aria-hidden="true" className={cn("size-3 text-muted-foreground", className)} />;
  }
  return <Circle aria-hidden="true" className={cn("size-3 text-muted-foreground", className)} />;
}
