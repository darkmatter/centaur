export const motionDurations = {
  micro: 0.12,
  fast: 0.14,
  base: 0.18,
  slow: 0.26,
  overlay: 0.32,
  liveSettle: 0.42,
} as const;

export const motionEasings = {
  standard: [0.16, 1, 0.3, 1],
  snappy: [0.2, 0, 0, 1],
  emphasized: [0.22, 1, 0.36, 1],
} as const;

export const motionDistances = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
} as const;

export const motionSprings = {
  gentle: {
    type: "spring" as const,
    stiffness: 320,
    damping: 32,
    mass: 0.9,
  },
  settle: {
    type: "spring" as const,
    stiffness: 420,
    damping: 38,
    mass: 0.82,
  },
  snappy: {
    type: "spring" as const,
    stiffness: 520,
    damping: 40,
    mass: 0.72,
  },
} as const;

export const motionOpacity = {
  subtle: 0.72,
  muted: 0.84,
} as const;
