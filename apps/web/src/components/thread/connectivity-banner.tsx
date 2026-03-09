"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHaptics } from "@/components/haptics-provider";
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
  const { trigger } = useHaptics();
  const prevStateRef = useRef<ConnectivityState>("connected");

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
    if (state !== prevStateRef.current) {
      prevStateRef.current = state;
    }
    if (state === "connected") {
      if (!renderedState) return;
      if (renderedState === "offline") {
        window.requestAnimationFrame(() => trigger("success"));
      }
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
      if (state === "offline") {
        window.requestAnimationFrame(() => trigger("warning"));
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [renderedState, state, trigger]);

  if (!renderedState) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-state={visibility}
      className={cn(
        "mx-auto my-1 flex w-full max-w-content-max items-center justify-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium md:px-3",
        "data-[state=open]:animate-in data-[state=open]:slide-in-from-top-1 data-[state=open]:fade-in data-[state=open]:duration-base",
        "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-1 data-[state=closed]:fade-out data-[state=closed]:duration-fast",
        renderedState === "offline" && "border-destructive/30 bg-destructive/10 text-destructive",
        renderedState === "reconnecting" && "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      {renderedState === "offline" ? (
        <>
          <WifiOff className="size-3.5" />
          Offline — updates paused
        </>
      ) : (
        <>
          <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" />
          Reconnecting…
        </>
      )}
    </div>
  );
}
