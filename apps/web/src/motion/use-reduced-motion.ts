"use client";

import { useMediaQuery } from "@/hooks/use-media-query";

export function useReducedMotionPreference(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
