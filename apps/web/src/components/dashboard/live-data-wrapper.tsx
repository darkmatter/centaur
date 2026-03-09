"use client";

import { memo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useDataSource } from "@/hooks/use-data-source";
import type { DataSource } from "./types";

type LiveDataWrapperProps = {
  dataSource: DataSource | undefined;
  initialData: readonly Record<string, unknown>[];
  children: (data: Record<string, unknown>[]) => ReactNode;
};

export const LiveDataWrapper = memo(function LiveDataWrapper({
  dataSource,
  initialData,
  children,
}: LiveDataWrapperProps) {
  const { data, isLoading, isRefreshing, error } = useDataSource(
    dataSource,
    initialData,
  );

  return (
    <div className="relative">
      {isRefreshing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-3xs text-muted-foreground backdrop-blur-sm">
          <RefreshCw className="size-3 animate-spin" />
          Refreshing
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <RefreshCw className="mr-2 size-4 animate-spin" />
          Loading data…
        </div>
      ) : (
        children(data)
      )}
      {error && (
        <div className="mt-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
});
