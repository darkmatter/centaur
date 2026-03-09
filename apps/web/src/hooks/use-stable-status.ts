import { useEffect, useRef, useState } from "react";

/**
 * Debounces a status string so each value is displayed for at least `minMs`.
 * Prevents flickering when the agent cycles through tools rapidly.
 */
export function useStableStatus(raw: string | null, minMs = 400): string | null {
  const [displayed, setDisplayed] = useState(raw);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSetRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastSetRef.current;

    if (elapsed >= minMs) {
      setDisplayed(raw);
      lastSetRef.current = now;
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDisplayed(raw);
      lastSetRef.current = Date.now();
    }, minMs - elapsed);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [raw, minMs]);

  return displayed;
}
