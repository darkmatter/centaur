"use client";

import { createContext, useContext, useMemo } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { useReducedMotionPreference } from "./use-reduced-motion";

type ThreadMotionContextValue = {
  reducedMotion: boolean;
  motionMode: "full" | "reduced";
};

const ThreadMotionContext = createContext<ThreadMotionContextValue>({
  reducedMotion: false,
  motionMode: "full",
});

export function ThreadMotionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const reducedMotion = useReducedMotionPreference();
  const value = useMemo<ThreadMotionContextValue>(
    () => ({
      reducedMotion,
      motionMode: reducedMotion ? "reduced" : "full",
    }),
    [reducedMotion],
  );

  return (
    <ThreadMotionContext.Provider value={value}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </LazyMotion>
    </ThreadMotionContext.Provider>
  );
}

export function useThreadMotion(): ThreadMotionContextValue {
  return useContext(ThreadMotionContext);
}
