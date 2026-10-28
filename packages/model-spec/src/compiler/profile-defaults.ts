export const DEFAULT_FRESHNESS_WINDOWS = Object.freeze([
  Object.freeze({ days: 1, score: 1.0 }),
  Object.freeze({ days: 7, score: 0.8 }),
  Object.freeze({ days: 30, score: 0.5 }),
] as const);

export const DEFAULT_TRUST_WEIGHTS = Object.freeze({
  identity: 0.4,
  freshness: 0.25,
  diversity: 0.2,
  coverage: 0.15,
} as const);

export const DEFAULT_TRUST_TIER_THRESHOLDS = Object.freeze({
  trusted: 0.85,
  monitor: 0.65,
  review: 0.4,
} as const);
