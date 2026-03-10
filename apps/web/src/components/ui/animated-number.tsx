"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useReducedMotionPreference } from "@/motion/use-reduced-motion";

function clampInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function AnimatedNumber({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const reducedMotion = useReducedMotionPreference();
  const target = useMemo(() => clampInteger(value), [value]);
  const [display, setDisplay] = useState(target);
  const previousTargetRef = useRef(target);

  useEffect(() => {
    if (reducedMotion) {
      setDisplay(target);
      previousTargetRef.current = target;
      return;
    }

    const start = previousTargetRef.current;
    const delta = target - start;
    if (delta === 0) return;

    const duration = 260;
    const startedAt = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(start + Math.round(delta * eased));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };

    frame = requestAnimationFrame(tick);
    previousTargetRef.current = target;
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion, target]);

  return (
    <motion.span
      className={className}
      aria-label={String(target)}
      initial={false}
      animate={reducedMotion ? undefined : { opacity: [0.84, 1], y: [-2, 0] }}
      transition={{ duration: 0.18 }}
    >
      {display.toLocaleString()}
    </motion.span>
  );
}
