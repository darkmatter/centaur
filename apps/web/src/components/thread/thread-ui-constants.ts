import type { ThreadStatusFilter } from "@/lib/viewer/thread-selectors";

export type VisibleThreadStatusFilter = Extract<ThreadStatusFilter, "all" | "active" | "error">;

export const THREAD_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  id: VisibleThreadStatusFilter;
  label: string;
  shortLabel: string;
}> = [
  { id: "all", label: "All", shortLabel: "All" },
  { id: "active", label: "Active", shortLabel: "Run" },
  { id: "error", label: "Error", shortLabel: "Err" },
] as const;

export const THREAD_SHORTCUTS_LABEL = "Shortcuts: Cmd/Ctrl+K, Alt+R, Alt+S, Esc, Cmd+., Shift+?";
