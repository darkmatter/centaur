"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type ConnectivityState = "connected" | "reconnecting" | "offline";

export function ConnectivityBanner({
  isReconnecting,
  threadState,
}: {
  isReconnecting: boolean;
  threadState: string | undefined;
}) {
  const [isOnline, setIsOnline] = useState(true);
  const [renderedState, setRenderedState] = useState<ConnectivityState | null>(null);
  const [visibility, setVisibility] = useState<"open" | "closed">("closed");

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    setIsOnline(navigator.onLine);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const state: ConnectivityState = !isOnline
    ? "offline"
    : isReconnecting && threadState !== "error"
      ? "reconnecting"
      : "connected";

  useEffect(() => {
    if (state === "connected") {
      if (!renderedState) return;
      setVisibility("closed");
      const timer = window.setTimeout(() => setRenderedState(null), 220);
      return () => window.clearTimeout(timer);
    }
    if (renderedState) {
      setRenderedState(state);
      setVisibility("open");
      return;
    }
    const timer = window.setTimeout(() => {
      setRenderedState(state);
      setVisibility("open");
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [renderedState, state]);

  if (!renderedState) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-state={visibility}
      className={cn(
        "flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium",
        "data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1 data-[state=open]:fade-in data-[state=open]:duration-200",
        "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-1 data-[state=closed]:fade-out data-[state=closed]:duration-150",
        renderedState === "offline" && "bg-destructive/10 text-destructive",
        renderedState === "reconnecting" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {renderedState === "offline" ? (
        <>
          <WifiOff className="size-3.5" />
          Offline — updates paused
        </>
      ) : (
        <>
          <RefreshCw className="size-3.5 animate-spin" />
          Reconnecting…
        </>
      )}
    </div>
  );
}
