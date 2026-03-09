"use client";

import { Button } from "@/components/ui/button";

export default function ThreadsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-4">
      <div className="text-center" role="alert" aria-live="assertive">
        <p className="mb-3 text-sm text-destructive">Something went wrong</p>
        <p className="mb-4 max-w-sm text-xs text-muted-foreground">{error.message}</p>
        <Button
          onClick={reset}
          variant="outline"
          size="xs"
          className="border-border text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
