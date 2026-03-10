"use client";

import type { CSSProperties, ReactNode, Ref, TouchEventHandler } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useThreadMotion } from "./provider";
import {
  chipTrayPreset,
  drawerPreset,
  fadePreset,
  bottomSheetPreset,
  overlayBackdropPreset,
  sidePanelPreset,
  slideFadePreset,
} from "./thread-presets";

export function Presence({
  present,
  children,
}: {
  present: boolean;
  children: ReactNode;
}) {
  return <AnimatePresence initial={false}>{present ? children : null}</AnimatePresence>;
}

export function Fade({
  present = true,
  className,
  children,
  onClick,
}: {
  present?: boolean;
  className?: string;
  children?: ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const { reducedMotion } = useThreadMotion();
  const preset = fadePreset(reducedMotion);
  return (
    <Presence present={present}>
      <motion.div
        className={className}
        initial={preset.initial}
        animate={preset.animate}
        exit={preset.exit}
        transition={preset.transition}
        onClick={onClick}
      >
        {children}
      </motion.div>
    </Presence>
  );
}

export function SlideFade({
  present = true,
  className,
  axis = "y",
  distance,
  children,
}: {
  present?: boolean;
  axis?: "x" | "y";
  distance?: number;
  className?: string;
  children?: ReactNode;
}) {
  const { reducedMotion } = useThreadMotion();
  const preset = slideFadePreset(reducedMotion, axis, distance);
  return (
    <Presence present={present}>
      <motion.div
        className={className}
        initial={preset.initial}
        animate={preset.animate}
        exit={preset.exit}
        transition={preset.transition}
      >
        {children}
      </motion.div>
    </Presence>
  );
}

export function ChipTrayPresence({
  present = true,
  className,
  children,
}: {
  present?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { reducedMotion } = useThreadMotion();
  const preset = chipTrayPreset(reducedMotion);
  return (
    <Presence present={present}>
      <motion.div
        className={className}
        initial={preset.initial}
        animate={preset.animate}
        exit={preset.exit}
        transition={preset.transition}
      >
        {children}
      </motion.div>
    </Presence>
  );
}

export function OverlayBackdrop({
  present = true,
  className,
  children,
  onClick,
}: {
  present?: boolean;
  className?: string;
  children?: ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const { reducedMotion } = useThreadMotion();
  const preset = overlayBackdropPreset(reducedMotion);
  return (
    <Presence present={present}>
      <motion.div
        className={className}
        initial={preset.initial}
        animate={preset.animate}
        exit={preset.exit}
        transition={preset.transition}
        onClick={onClick}
      >
        {children}
      </motion.div>
    </Presence>
  );
}

type PanelPreset = "drawer" | "bottomSheet" | "sidePanel";

export function OverlayPanel({
  preset,
  present = true,
  className,
  children,
  panelRef,
  role,
  labelledBy,
  describedBy,
  tabIndex,
  style,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  preset: PanelPreset;
  present?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  className?: string;
  children?: ReactNode;
  role?: string;
  labelledBy?: string;
  describedBy?: string;
  tabIndex?: number;
  style?: CSSProperties;
  onTouchStart?: TouchEventHandler<HTMLDivElement>;
  onTouchMove?: TouchEventHandler<HTMLDivElement>;
  onTouchEnd?: TouchEventHandler<HTMLDivElement>;
}) {
  const { reducedMotion } = useThreadMotion();
  const resolved =
    preset === "drawer"
      ? drawerPreset(reducedMotion)
      : preset === "bottomSheet"
        ? bottomSheetPreset(reducedMotion)
        : sidePanelPreset(reducedMotion);

  return (
    <Presence present={present}>
      <motion.div
        ref={panelRef as never}
        className={className}
        initial={resolved.initial}
        animate={resolved.animate}
        exit={resolved.exit}
        transition={resolved.transition}
        role={role}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-modal={role === "dialog" ? true : undefined}
        tabIndex={tabIndex}
        style={style}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {children}
      </motion.div>
    </Presence>
  );
}

export function MeasureReveal({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { reducedMotion } = useThreadMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">(open ? "auto" : 0);

  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const nextHeight = bodyRef.current.getBoundingClientRect().height;
    if (!open) {
      setHeight(nextHeight);
      requestAnimationFrame(() => setHeight(0));
      return;
    }
    setHeight(nextHeight);
    const timer = window.setTimeout(() => setHeight("auto"), reducedMotion ? 70 : 260);
    return () => window.clearTimeout(timer);
  }, [children, open, reducedMotion]);

  return (
    <motion.div
      className={cn("overflow-hidden", className)}
      animate={{
        height: open ? height : 0,
        opacity: open ? 1 : 0,
      }}
      initial={false}
      transition={reducedMotion ? { duration: 0.08 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div ref={bodyRef}>{children}</div>
    </motion.div>
  );
}
