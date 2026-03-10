"use client";

import type { CSSProperties, ElementType } from "react";

import { cn } from "@/lib/utils";
import { memo, useMemo } from "react";
import { useReducedMotionPreference } from "@/motion/use-reduced-motion";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  active?: boolean;
}

const ShimmerComponent = ({
  children,
  as: Component = "span",
  className,
  duration = 2,
  spread = 2,
  active = true,
}: TextShimmerProps) => {
  const reducedMotion = useReducedMotionPreference();
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );
  const shimmerEnabled = active && !reducedMotion;

  return (
    <Component
      className={cn(
        shimmerEnabled
          ? "ai-shimmer relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent"
          : "relative inline-block text-current",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-duration": `${duration}s`,
          backgroundImage:
            shimmerEnabled
              ? "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))"
              : undefined,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
Shimmer.displayName = "Shimmer";
