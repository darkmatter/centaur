export type MotionSurface = "chrome" | "live" | "overlay";

export function scrollBehaviorForMotion(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export function shouldAnimateShimmer(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

export function shouldAnimateRollingPreview(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

export function shouldAnimateMeasureReveal(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

export function shouldAnimateSurface(
  reducedMotion: boolean,
  surface: MotionSurface,
): boolean {
  if (!reducedMotion) return true;
  return surface === "chrome";
}
