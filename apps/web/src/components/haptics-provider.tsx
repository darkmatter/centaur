"use client";

import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { useWebHaptics } from "web-haptics/react";

type HapticType =
  | "success"
  | "warning"
  | "error"
  | "light"
  | "medium"
  | "heavy"
  | "selection";

type HapticsContextValue = {
  trigger: (type?: HapticType) => void;
};

const HapticsContext = createContext<HapticsContextValue>({
  trigger: () => {},
});

export function HapticsProvider({ children }: { children: React.ReactNode }) {
  const haptic = useWebHaptics();
  const lastTriggerRef = useRef<{ type: HapticType | "medium"; at: number }>({
    type: "medium",
    at: 0,
  });

  const trigger = useCallback(
    (type?: HapticType) => {
      const resolvedType = type ?? "medium";
      const now = Date.now();
      const last = lastTriggerRef.current;
      // Prevent rapid duplicate pulses from bubbling click/selection handlers.
      if (last.type === resolvedType && now - last.at < 140) {
        return;
      }
      lastTriggerRef.current = { type: resolvedType, at: now };
      haptic.trigger(resolvedType);
    },
    [haptic],
  );

  const value = useMemo<HapticsContextValue>(
    () => ({ trigger }),
    [trigger],
  );
  return <HapticsContext.Provider value={value}>{children}</HapticsContext.Provider>;
}

export function useHaptics(): HapticsContextValue {
  return useContext(HapticsContext);
}
