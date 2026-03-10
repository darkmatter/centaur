"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useReducedMotionPreference } from "@/motion/use-reduced-motion";

export function TextReveal({
  text,
  className,
  duration = 0.32,
}: {
  text: string;
  className?: string;
  duration?: number;
}) {
  const reducedMotion = useReducedMotionPreference();
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const currentRef = useRef<HTMLSpanElement>(null);
  const previousRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (text === current) return;
    setPrevious(current);
    setCurrent(text);
  }, [current, text]);

  useLayoutEffect(() => {
    const currentWidth = currentRef.current?.getBoundingClientRect().width ?? 0;
    const previousWidth = previousRef.current?.getBoundingClientRect().width ?? 0;
    const nextWidth = Math.max(currentWidth, previousWidth);
    if (nextWidth > 0) setWidth(nextWidth);
  }, [current, previous]);

  const wrapperStyle = useMemo(
    () => ({
      width: width ? `${width}px` : undefined,
      transition: reducedMotion ? undefined : `width ${duration}s cubic-bezier(0.22, 1, 0.36, 1)`,
    }),
    [duration, reducedMotion, width],
  );

  return (
    <span className={cn("relative inline-grid min-w-0", className)} style={wrapperStyle}>
      <AnimatePresence initial={false} mode="popLayout" onExitComplete={() => setPrevious(null)}>
        {previous ? (
          <motion.span
            key={`prev:${previous}`}
            ref={previousRef}
            aria-hidden="true"
            className="col-start-1 row-start-1 whitespace-nowrap"
            initial={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            animate={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.08 : duration * 0.75 }}
          >
            {previous}
          </motion.span>
        ) : null}
      </AnimatePresence>
      <motion.span
        key={`cur:${current}`}
        ref={currentRef}
        className="col-start-1 row-start-1 whitespace-nowrap"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: reducedMotion ? 0.08 : duration }}
      >
        {current}
      </motion.span>
    </span>
  );
}
