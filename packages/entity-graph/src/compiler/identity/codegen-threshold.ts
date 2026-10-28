/**
 * Threshold routing codegen — single-band review routing for entity resolution.
 *
 * Routes scored pairs into the review range between auto_merge and review.
 * Populates the __review_queue table for pairs needing review.
 */

import {
  quoteIdentifier,
  buildFqName,
  quoteLiteral,
  createOrReplaceTableAs,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { hasFlagForReviewRules } from './types.js';
import { typedNull } from './materializer.js';
import { outputTableName } from '../output-tables/index.js';

/**
 * Midpoint of the review band, used as the merge/not_match heuristic cutoff.
 * With `auto_merge: null` the band is unbounded above — fall back to the
 * midpoint of [review, 1].
 */
export function reviewBandMidpoint(t: { autoMerge: number | null; review: number }): number {
  return t.autoMerge === null ? (1 + t.review) / 2 : (t.autoMerge + t.review) / 2;
}

/**
 * threshold_band expression for __review_queue rows, shared by threshold
 * routing and the semantic-triage queue rebuild. With flag_for_review rules
 * present it distinguishes rule-flagged pairs from score-band pairs;
 * otherwise it stays the literal 'review' (byte-identical to the SQL emitted
 * before the action existed).
 */
export function buildFlagAwareBandExpr(
  dialect: SupportedDialect,
  flagRules: boolean,
  flaggedMatchExpr: string
): string {
  if (!flagRules) {
    return quoteLiteral('review', dialect);
  }
  return [
    `CASE`,
    `    WHEN ${flaggedMatchExpr} THEN ${quoteLiteral('deterministic_review', dialect)}`,
    `    ELSE ${quoteLiteral('review', dialect)}`,
    `  END`,
  ].join('\n');
}

/**
 * Generate SQL for the __review_queue table.
 *
 * Routes scored pairs into the review queue. auto_merge and auto_reject
 * remain outside the queue.
 */
export function generateThresholdSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const t = spec.thresholds;
  const scoresTable = buildFqName(targetSchema, outputTableName(entity, '__pair_scores'), dialect);
  const queueTable = buildFqName(targetSchema, outputTableName(entity, '__review_queue'), dialect);

  const compositeScore = quoteIdentifier('composite_score', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const sourceA = quoteIdentifier('source_a', dialect);
  const sourceB = quoteIdentifier('source_b', dialect);
  const blockingRules = quoteIdentifier('blocking_rules', dialect);
  const fieldScores = quoteIdentifier('field_scores', dialect);
  const thresholdBand = quoteIdentifier('threshold_band', dialect);
  const recommendedAction = quoteIdentifier('recommended_action', dialect);
  const fieldDiffs = quoteIdentifier('field_diffs', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const semanticDecision = quoteIdentifier('semantic_decision', dialect);

  const matchType = quoteIdentifier('match_type', dialect);
  const ruleName = quoteIdentifier('rule_name', dialect);
  const flagRules = hasFlagForReviewRules(spec);
  const flaggedMatch = `${matchType} = ${quoteLiteral('deterministic_review', dialect)}`;

  // flag_for_review pairs keep their own band so reviewers can tell a
  // rule-flagged pair from a score-band pair.
  const bandExpr = buildFlagAwareBandExpr(dialect, flagRules, flaggedMatch);

  // Recommended action heuristic: above midpoint of review range → merge, else
  // not_match. With auto_merge disabled the band is unbounded above, so fall
  // back to the midpoint of [review, 1].
  const midpoint = reviewBandMidpoint(t);
  const actionExpr = [
    `CASE`,
    `    WHEN ${compositeScore} >= ${midpoint} THEN ${quoteLiteral('merge', dialect)}`,
    `    ELSE ${quoteLiteral('not_match', dialect)}`,
    `  END`,
  ].join('\n');

  const sql = [
    createOrReplaceTableAs(queueTable, dialect),
    `SELECT`,
    `  ${pairId},`,
    `  ${recordAId},`,
    `  ${recordBId},`,
    `  ${sourceA},`,
    `  ${sourceB},`,
    `  ${compositeScore},`,
    `  ${bandExpr} AS ${thresholdBand},`,
    `  ${blockingRules},`,
    `  ${fieldScores} AS ${fieldDiffs},`,
    `  ${actionExpr} AS ${recommendedAction},`,
    `  ${typedNull('FLOAT', dialect)} AS ${semanticScore},`,
    `  ${typedNull('STRING', dialect)} AS ${semanticDecision},`,
    // rule_name is populated for deterministic-rule pairs (NULL for scored
    // pairs) so reviewers can see which rule flagged a pair.
    `  ${ruleName}`,
    `FROM ${scoresTable}`,
    ...(flagRules
      ? [
          // flag_for_review pairs enter the queue regardless of score band.
          `WHERE ((${compositeScore} >= ${t.review}`,
          t.autoMerge === null
            ? `  AND ${matchType} <> ${quoteLiteral('deterministic', dialect)})`
            : `  AND ${compositeScore} < ${t.autoMerge})`,
          `  OR ${flaggedMatch})`,
        ]
      : [
          `WHERE ${compositeScore} >= ${t.review}`,
          // auto_merge: null → unbounded review band, but deterministic-rule pairs
          // merge directly and must not also enter the queue.
          t.autoMerge === null
            ? `  AND ${matchType} <> ${quoteLiteral('deterministic', dialect)}`
            : `  AND ${compositeScore} < ${t.autoMerge}`,
        ]),
  ].join('\n');

  return {
    name: `threshold_routing`,
    sql,
    tableCreated: outputTableName(entity, '__review_queue'),
  };
}
