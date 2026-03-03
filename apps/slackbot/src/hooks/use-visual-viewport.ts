"use client";

import { useEffect, useState } from "react";

export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    let frame = 0;
    let baselineHeight = vv.height + vv.offsetTop;

    const update = () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        const viewportHeight = vv.height + vv.offsetTop;
        if (viewportHeight > baselineHeight) {
          baselineHeight = viewportHeight;
        }
        const keyboard = Math.max(0, baselineHeight - viewportHeight);
        const nextHeight = keyboard > 100 ? keyboard : 0;
        if (nextHeight === 0) {
          baselineHeight = Math.max(baselineHeight, viewportHeight);
        }
        setKeyboardHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      });
    };

    const resetBaseline = () => {
      baselineHeight = vv.height + vv.offsetTop;
      update();
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("orientationchange", resetBaseline);
    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", resetBaseline);
    };
  }, []);

  return keyboardHeight;
}
