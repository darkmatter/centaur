"use client";

import { animate } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { TextReveal } from "@/components/ai-elements/text-reveal";
import { useReducedMotionPreference } from "@/motion/use-reduced-motion";

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

export function StatusTitle({
  active,
  activeText,
  doneText,
  className,
}: {
  active: boolean;
  activeText: string;
  doneText: string;
  className?: string;
}) {
  const prefix = commonPrefix(activeText, doneText);
  const activeSuffix = activeText.slice(prefix.length);
  const doneSuffix = doneText.slice(prefix.length);
  const hasUsefulPrefix = prefix.trim().length >= 2 && activeSuffix && doneSuffix;
  const activeMeasureRef = useRef<HTMLSpanElement>(null);
  const doneMeasureRef = useRef<HTMLSpanElement>(null);
  const suffixRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotionPreference();

  useLayoutEffect(() => {
    if (!hasUsefulPrefix) return;
    const target = active ? activeMeasureRef.current : doneMeasureRef.current;
    const suffix = suffixRef.current;
    if (!target || !suffix) return;
    const nextWidth = Math.ceil(target.getBoundingClientRect().width);
    if (nextWidth <= 0) return;
    const previousWidth = Math.ceil(suffix.getBoundingClientRect().width);
    if (!previousWidth) {
      suffix.style.width = `${nextWidth}px`;
      return;
    }
    if (reducedMotion) {
      suffix.style.width = `${nextWidth}px`;
      return;
    }
    if (Math.abs(nextWidth - previousWidth) < 1) {
      suffix.style.width = `${nextWidth}px`;
      return;
    }
    const controls = animate(
      suffix,
      { width: `${nextWidth}px` },
      { type: "spring", stiffness: 420, damping: 38, mass: 0.82 },
    );
    return () => controls.stop();
  }, [active, activeSuffix, doneSuffix, hasUsefulPrefix, reducedMotion]);

  if (!hasUsefulPrefix) {
    return <TextReveal className={className} text={active ? activeText : doneText} />;
  }

  return (
    <span className={className} aria-label={active ? activeText : doneText}>
      <span>{prefix}</span>
      <span ref={suffixRef} className="relative inline-flex overflow-hidden align-baseline">
        <span ref={activeMeasureRef} className="pointer-events-none absolute opacity-0">
          {activeSuffix}
        </span>
        <span ref={doneMeasureRef} className="pointer-events-none absolute opacity-0">
          {doneSuffix}
        </span>
        <TextReveal text={active ? activeSuffix : doneSuffix} />
      </span>
    </span>
  );
}
