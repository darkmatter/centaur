import { motionDistances, motionDurations, motionEasings, motionSprings } from "./tokens";

type VariantState = Record<string, string | number>;

export type SurfacePreset = {
  initial: VariantState;
  animate: VariantState;
  exit: VariantState;
  transition: Record<string, unknown>;
};

export function fadePreset(reducedMotion: boolean): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.fast },
      }
    : {
        initial: { opacity: 0, y: motionDistances.xs },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: motionDistances.xs * -1 },
        transition: { duration: motionDurations.base, ease: motionEasings.standard },
      };
}

export function slideFadePreset(
  reducedMotion: boolean,
  axis: "x" | "y" = "y",
  distance: number = motionDistances.sm,
): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.fast },
      }
    : {
        initial: { opacity: 0, [axis]: distance },
        animate: { opacity: 1, [axis]: 0 },
        exit: { opacity: 0, [axis]: distance * -0.5 },
        transition: { duration: motionDurations.base, ease: motionEasings.standard },
      };
}

export function chipTrayPreset(reducedMotion: boolean): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.fast },
      }
    : {
        initial: { opacity: 0, y: motionDistances.sm },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: motionDistances.sm },
        transition: { duration: motionDurations.base, ease: motionEasings.emphasized },
      };
}

export function overlayBackdropPreset(reducedMotion: boolean): SurfacePreset {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reducedMotion ? motionDurations.fast : motionDurations.base },
  };
}

export function drawerPreset(reducedMotion: boolean): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.base },
      }
    : {
        initial: { opacity: 0, x: -motionDistances.lg },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: -motionDistances.md },
        transition: { duration: motionDurations.overlay, ease: motionEasings.snappy },
      };
}

export function bottomSheetPreset(reducedMotion: boolean): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.base },
      }
    : {
        initial: { opacity: 0, y: motionDistances.lg },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: motionDistances.md },
        transition: { duration: motionDurations.overlay, ease: motionEasings.emphasized },
      };
}

export function sidePanelPreset(reducedMotion: boolean): SurfacePreset {
  return reducedMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: motionDurations.base },
      }
    : {
        initial: { opacity: 0, x: motionDistances.lg },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: motionDistances.md },
        transition: { duration: motionDurations.overlay, ease: motionEasings.emphasized },
      };
}

export function measureRevealSpring(reducedMotion: boolean) {
  if (reducedMotion) {
    return { duration: motionDurations.fast };
  }
  return motionSprings.gentle;
}
