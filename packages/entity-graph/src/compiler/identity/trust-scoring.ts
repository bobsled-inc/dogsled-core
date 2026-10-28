/**
 * Shared trust-scoring expression builders.
 *
 * The weighted trust score + band semantics are spec-driven
 * (`profile.quality.trust_weights` / `trust_tier_thresholds`) and are emitted by
 * two consumers that must stay in lock-step:
 *   - `codegen-trust.ts` → `<entity>__entity_quality` (profile phase), and
 *   - `codegen-golden.ts` → `<entity>__golden` (cluster phase).
 * Centralizing the scalar expressions here keeps the score formula and the
 * trusted/monitor/review/blocked band thresholds single-sourced.
 */

import { quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedQualityTrustTierThresholds, ResolvedQualityTrustWeights } from './types.js';

/**
 * CASE expression mapping a freshness observation timestamp to a 0..1 score via
 * the configured freshness windows (closest window wins; anything older than the
 * widest window scores 0.2).
 */
export function buildFreshnessScoreExpr(
  observedAtExpr: string,
  windows: Array<{ days: number; score: number }>,
  dialect: SupportedDialect,
  timestampMinusDays: (days: number, dialect: SupportedDialect) => string
): string {
  const sorted = [...windows].sort((left, right) => left.days - right.days);
  return [
    `CASE`,
    ...sorted.map(
      (window) =>
        `    WHEN ${observedAtExpr} >= ${timestampMinusDays(window.days, dialect)} THEN ${window.score}`
    ),
    `    ELSE 0.2`,
    `  END`,
  ].join('\n');
}

/** Weighted sum of the four trust signals; refs are the SQL column expressions. */
export function buildTrustScoreExpr(
  weights: ResolvedQualityTrustWeights,
  refs: {
    identity: string;
    freshness: string;
    diversity: string;
    coverage: string;
  }
): string {
  return [
    `${weights.identity} * ${refs.identity}`,
    `${weights.freshness} * ${refs.freshness}`,
    `${weights.diversity} * ${refs.diversity}`,
    `${weights.coverage} * ${refs.coverage}`,
  ].join('\n    + ');
}

/**
 * Band CASE over a trust-score expression. Bands and thresholds are spec-driven;
 * scores below `review` fall into `blocked`.
 */
export function buildTrustBandExpr(
  thresholds: ResolvedQualityTrustTierThresholds,
  scoreExpr: string,
  dialect: SupportedDialect
): string {
  return [
    `CASE`,
    `    WHEN ${scoreExpr} >= ${thresholds.trusted} THEN ${quoteLiteral('trusted', dialect)}`,
    `    WHEN ${scoreExpr} >= ${thresholds.monitor} THEN ${quoteLiteral('monitor', dialect)}`,
    `    WHEN ${scoreExpr} >= ${thresholds.review} THEN ${quoteLiteral('review', dialect)}`,
    `    ELSE ${quoteLiteral('blocked', dialect)}`,
    `  END`,
  ].join('\n');
}
