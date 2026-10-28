/**
 * Scoring codegen — L1 deterministic + L2 fuzzy scoring.
 *
 * Generates the __pair_scores table combining deterministic rule
 * matches and fuzzy similarity scoring.
 */

import {
  quoteIdentifier,
  buildFqName,
  createOrReplaceTableAs,
  getCanonicalDialect,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { FuzzyAlgorithm, ResolvedResolutionSpec, SqlStatement } from './types.js';
import { fuzzyScoreExpr } from '../core/dialect-similarity.js';
import { outputTableName } from '../output-tables/index.js';
import { producedStandardizedColumns } from './codegen-standardize.js';
import { pairIdExpr } from './sql.js';
import type { ResolutionIncrementalOptions } from './codegen-resolve-state.js';

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

/**
 * Generate SQL for the __pair_scores table.
 *
 * Combines L1 deterministic matches and L2 fuzzy scoring.
 */
export function generateScoringSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  options?: { incremental?: ResolutionIncrementalOptions }
): SqlStatement {
  const entity = spec.entity;
  const pairsTable = buildFqName(
    targetSchema,
    outputTableName(entity, options?.incremental ? '__candidate_pairs_delta' : '__candidate_pairs'),
    dialect
  );
  const stdTable = buildFqName(targetSchema, outputTableName(entity, '__standardized'), dialect);
  const scoresTable = buildFqName(targetSchema, outputTableName(entity, '__pair_scores'), dialect);

  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const sourceA = quoteIdentifier('source_a', dialect);
  const sourceB = quoteIdentifier('source_b', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const matchType = quoteIdentifier('match_type', dialect);
  const ruleName = quoteIdentifier('rule_name', dialect);
  const fieldScoresCol = quoteIdentifier('field_scores', dialect);
  const scoredAt = quoteIdentifier('scored_at', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const blockingRules = quoteIdentifier('blocking_rules', dialect);

  const selectParts: string[] = [];

  // A scoring field must reference a column the standardize stage produces (a
  // `standardized_<field>` or a passthrough source column). When every input
  // declares its source columns, catch a typo/nonexistent field here at compile
  // time with a clear message rather than as an opaque "column not found" deep
  // inside a warehouse run. Skipped under wildcard passthrough (unknown universe).
  const producedColumns = producedStandardizedColumns(spec);
  if (producedColumns) {
    const scoringFields =
      spec.scoring?.method === 'fellegi_sunter'
        ? spec.scoring.comparisons.map((c) => c.field)
        : spec.scoring?.method === 'weighted_features'
          ? spec.scoring.features.map((f) => f.field)
          : [];
    for (const field of scoringFields) {
      if (!producedColumns.has(field.toLowerCase())) {
        throw new Error(
          `Resolution scoring field "${field}" is not produced by the standardize stage or any input's source columns. ` +
            `Reference a standardized field (standardized_<field>) or a declared passthrough column.`
        );
      }
    }
  }

  // L1: Deterministic rules. auto_merge rules emit match_type 'deterministic'
  // (merge edges); flag_for_review rules emit 'deterministic_review' — the
  // pair routes to __review_queue regardless of score band and never becomes
  // a merge edge until a review decision applies. Either way the rule's row
  // IS the pair's score row (L2 excludes rule-matched pairs), so
  // composite_score = rule confidence.
  for (const rule of spec.deterministicRules) {
    const conditions = rule.conditions.map((c) => {
      const fieldA = `a.${quoteIdentifier(c.field, dialect)}`;
      const fieldB = `b.${quoteIdentifier(c.field, dialect)}`;
      const parts = [`${fieldA} = ${fieldB}`];
      if (c.bothNotNull) {
        parts.push(`${fieldA} IS NOT NULL`, `${fieldB} IS NOT NULL`);
      }
      return parts.join(' AND ');
    });

    selectParts.push(
      [
        `SELECT`,
        `  ${pairIdExpr(`cp.${recordAId}`, `cp.${recordBId}`, dialect)} AS ${pairId},`,
        `  cp.${recordAId},`,
        `  cp.${recordBId},`,
        `  cp.${sourceA},`,
        `  cp.${sourceB},`,
        `  ${rule.confidence} AS ${compositeScore},`,
        `  ${quoteLiteral(rule.action === 'flag_for_review' ? 'deterministic_review' : 'deterministic', dialect)} AS ${matchType},`,
        `  ${quoteLiteral(rule.name, dialect)} AS ${ruleName},`,
        `  cp.${blockingRules},`,
        `  ${quoteLiteral('{}', dialect)} AS ${fieldScoresCol},`,
        `  CURRENT_TIMESTAMP AS ${scoredAt}`,
        `FROM ${pairsTable} cp`,
        `JOIN ${stdTable} a ON cp.${recordAId} = a.${recordId}`,
        `JOIN ${stdTable} b ON cp.${recordBId} = b.${recordId}`,
        `WHERE ${conditions.join(' AND ')}`,
      ].join('\n')
    );
  }

  // L2a: Probabilistic scoring (Fellegi–Sunter) — a calibrated match
  // probability from per-comparison m/u match weights (supplied in the spec).
  if (spec.scoring?.method === 'fellegi_sunter') {
    const fs = spec.scoring;
    const deterministicExclusion =
      spec.deterministicRules.length > 0 ? buildDeterministicExclusion(spec, dialect) : '';

    // Prior weight in bits: log2(prior / (1 - prior)).
    const priorBits = fsBitWeight(fs.prior, 1 - fs.prior);

    // Each comparison contributes a CASE returning its matched level's match
    // weight in bits; a null on either side contributes no evidence (0 bits).
    const comparisonExprs = fs.comparisons.map((comparison) => {
      const fieldA = `a.${quoteIdentifier(comparison.field, dialect)}`;
      const fieldB = `b.${quoteIdentifier(comparison.field, dialect)}`;
      const whenClauses: string[] = [];
      let elseBits = 0;
      comparison.levels.forEach((level) => {
        if (level.op === 'else') {
          elseBits = fsBitWeight(level.m, level.u);
          return;
        }
        const condition = fsLevelCondition(level.op, level.gte, fieldA, fieldB, dialect);
        whenClauses.push(`WHEN ${condition} THEN ${fsFmt(fsBitWeight(level.m, level.u))}`);
      });
      const caseExpr = [
        'CASE',
        `WHEN ${fieldA} IS NULL OR ${fieldB} IS NULL THEN 0.0`,
        ...whenClauses,
        `ELSE ${fsFmt(elseBits)}`,
        'END',
      ].join(' ');
      // field_scores stores each comparison's match weight in bits (log-odds,
      // can be negative) — the meaningful per-field signal for Fellegi–Sunter
      // (vs. [0,1] similarities in the weighted_features path).
      return { field: comparison.field, nullSafe: caseExpr };
    });

    // total_bits = prior + Σ comparison weights; probability = 1/(1 + 2^-bits),
    // written with EXP (universal) since 2^x = exp(x · ln2).
    const totalBitsExpr = [fsFmt(priorBits), ...comparisonExprs.map((c) => `(${c.nullSafe})`)].join(
      ' + '
    );
    // Clamp into the open interval (0, 1). On IEEE-754 double engines (DuckDB,
    // Snowflake, BigQuery, Databricks, MySQL) a strongly agreeing pair — even a
    // realistic handful of exact-matching fields — sums to enough bits that EXP
    // under/overflows and the sigmoid saturates to exactly 1.0 or 0.0. That
    // breaks the strict-(0, 1) contract downstream stages assume and lets a
    // genuine score collide with the 1.0 "no confidence" sentinel. Postgres/
    // Redshift evaluate in arbitrary-precision numeric and stay in range, so the
    // clamp also normalizes behavior across dialects.
    const sigmoidExpr = `1.0 / (1.0 + EXP(-(${totalBitsExpr}) * 0.6931471805599453))`;
    const compositeScoreExpr = `LEAST(0.999999999, GREATEST(0.000000001, ${sigmoidExpr}))`;
    const fieldScoresJson = buildFieldScoresJson(comparisonExprs, dialect);

    selectParts.push(
      [
        `SELECT`,
        `  ${pairIdExpr(`cp.${recordAId}`, `cp.${recordBId}`, dialect)} AS ${pairId},`,
        `  cp.${recordAId},`,
        `  cp.${recordBId},`,
        `  cp.${sourceA},`,
        `  cp.${sourceB},`,
        `  ${compositeScoreExpr} AS ${compositeScore},`,
        `  ${quoteLiteral('fellegi_sunter', dialect)} AS ${matchType},`,
        `  NULL AS ${ruleName},`,
        `  cp.${blockingRules},`,
        `  ${fieldScoresJson} AS ${fieldScoresCol},`,
        `  CURRENT_TIMESTAMP AS ${scoredAt}`,
        `FROM ${pairsTable} cp`,
        `JOIN ${stdTable} a ON cp.${recordAId} = a.${recordId}`,
        `JOIN ${stdTable} b ON cp.${recordBId} = b.${recordId}`,
        deterministicExclusion ? `WHERE ${deterministicExclusion}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } else if (spec.scoring) {
    // L2b: Weighted-average fuzzy scoring (for pairs not matched by L1 rules).
    const features = spec.scoring.features;

    // Build per-feature score expressions with NULL handling
    const featureExprs = features.map((f) => {
      const fieldA = `a.${quoteIdentifier(f.field, dialect)}`;
      const fieldB = `b.${quoteIdentifier(f.field, dialect)}`;
      const scoreExpr = fuzzyScoreExpr(f.algorithm, fieldA, fieldB, dialect);
      return {
        field: f.field,
        algorithm: f.algorithm,
        weight: f.weight,
        scoreExpr,
        nullSafe: `CASE WHEN ${fieldA} IS NOT NULL AND ${fieldB} IS NOT NULL THEN ${scoreExpr} ELSE NULL END`,
      };
    });

    // Weighted average: SUM(score * weight) / SUM(weight) for non-NULL features
    const weightedSum = featureExprs
      .map((f) => `COALESCE(${f.nullSafe}, 0) * ${f.weight}`)
      .join(' + ');
    const weightSum = featureExprs
      .map((f) => `CASE WHEN ${f.nullSafe} IS NOT NULL THEN ${f.weight} ELSE 0 END`)
      .join(' + ');

    // Build field_scores JSON
    const fieldScoresJson = buildFieldScoresJson(featureExprs, dialect);

    // Exclude pairs already matched by deterministic rules
    const deterministicExclusion =
      spec.deterministicRules.length > 0 ? buildDeterministicExclusion(spec, dialect) : '';

    selectParts.push(
      [
        `SELECT`,
        `  ${pairIdExpr(`cp.${recordAId}`, `cp.${recordBId}`, dialect)} AS ${pairId},`,
        `  cp.${recordAId},`,
        `  cp.${recordBId},`,
        `  cp.${sourceA},`,
        `  cp.${sourceB},`,
        `  CASE WHEN (${weightSum}) > 0 THEN LEAST(1.0, GREATEST(0.0, (${weightedSum}) / (${weightSum}))) ELSE 0.0 END AS ${compositeScore},`,
        `  ${quoteLiteral('fuzzy', dialect)} AS ${matchType},`,
        `  NULL AS ${ruleName},`,
        `  cp.${blockingRules},`,
        `  ${fieldScoresJson} AS ${fieldScoresCol},`,
        `  CURRENT_TIMESTAMP AS ${scoredAt}`,
        `FROM ${pairsTable} cp`,
        `JOIN ${stdTable} a ON cp.${recordAId} = a.${recordId}`,
        `JOIN ${stdTable} b ON cp.${recordBId} = b.${recordId}`,
        deterministicExclusion ? `WHERE ${deterministicExclusion}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  const unionAll = selectParts.join('\nUNION ALL\n');
  const sql = options?.incremental
    ? [
        `INSERT INTO ${scoresTable}`,
        `SELECT scored.*`,
        `FROM (`,
        unionAll,
        `) scored`,
        `WHERE NOT EXISTS (`,
        `  SELECT 1 FROM (SELECT ${pairId} FROM ${scoresTable}) existing`,
        `  WHERE existing.${pairId} = scored.${pairId}`,
        `)`,
      ].join('\n')
    : `${createOrReplaceTableAs(scoresTable, dialect)}\n${unionAll}`;

  return {
    name: options?.incremental ? 'scoring_delta' : 'scoring',
    sql,
    tableCreated: outputTableName(entity, '__pair_scores'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build field_scores JSON expression per dialect. */
function buildFieldScoresJson(
  features: Array<{
    field: string;
    nullSafe: string;
  }>,
  dialect: SupportedDialect
): string {
  // Dialect-aware cast for JSON field score stringification
  const canonicalDialect = getCanonicalDialect(dialect);
  const castType =
    canonicalDialect === 'bigquery' || canonicalDialect === 'databricks'
      ? 'STRING'
      : canonicalDialect === 'mysql'
        ? 'CHAR'
        : 'VARCHAR';

  if (canonicalDialect === 'mysql' || canonicalDialect === 'databricks') {
    const fieldPairs = features.map(
      (f) =>
        `CONCAT(${quoteLiteral(`"${f.field}":`, dialect)}, CAST(COALESCE(${f.nullSafe}, 0) AS ${castType}))`
    );
    const pairArgs = fieldPairs.flatMap((pair, index) =>
      index === 0 ? [pair] : [quoteLiteral(',', dialect), pair]
    );
    return `CONCAT(${quoteLiteral('{', dialect)}, ${pairArgs.join(', ')}, ${quoteLiteral('}', dialect)})`;
  }

  const pairs = features
    .map(
      (f) =>
        `${quoteLiteral(`"${f.field}":`, dialect)} || CAST(COALESCE(${f.nullSafe}, 0) AS ${castType})`
    )
    .join(` || ${quoteLiteral(',', dialect)} || `);

  return `${quoteLiteral('{', dialect)} || ${pairs} || ${quoteLiteral('}', dialect)}`;
}

/** Build WHERE clause to exclude deterministic matches. */
function buildDeterministicExclusion(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect
): string {
  // Exclude pairs where ALL deterministic conditions match
  const exclusions = spec.deterministicRules.map((rule) => {
    const conditions = rule.conditions.map((c) => {
      const fieldA = `a.${quoteIdentifier(c.field, dialect)}`;
      const fieldB = `b.${quoteIdentifier(c.field, dialect)}`;
      return `(${fieldA} = ${fieldB}${c.bothNotNull ? ` AND ${fieldA} IS NOT NULL AND ${fieldB} IS NOT NULL` : ''})`;
    });
    return `(${conditions.join(' AND ')})`;
  });

  return `NOT (${exclusions.join(' OR ')})`;
}

// ---------------------------------------------------------------------------
// Fellegi–Sunter helpers
// ---------------------------------------------------------------------------

/**
 * Match weight in bits: `log2(m / u)`, with an epsilon floor on m and u so a
 * sparse level (m or u == 0) cannot produce ±Infinity / NaN.
 */
export function fsBitWeight(m: number, u: number): number {
  const EPS = 1e-9;
  return Math.log2(Math.max(m, EPS) / Math.max(u, EPS));
}

/** Format a number as a deterministic SQL numeric literal. */
export function fsFmt(value: number): string {
  return value.toFixed(6);
}

/** SQL boolean condition for a non-`else` Fellegi–Sunter comparison level. */
export function fsLevelCondition(
  op: FuzzyAlgorithm,
  gte: number | undefined,
  fieldA: string,
  fieldB: string,
  dialect: SupportedDialect
): string {
  if (op === 'exact') {
    // Relies on the standardize stage for case/whitespace/type consistency, the
    // same assumption as the blocking and deterministic-rule equality paths.
    return `${fieldA} = ${fieldB}`;
  }
  if (op === 'soundex') {
    // fuzzyScoreExpr returns 1.0 on a soundex match, 0.0 otherwise.
    return `${fuzzyScoreExpr('soundex', fieldA, fieldB, dialect)} >= 0.5`;
  }
  // Threshold ops: jaro_winkler / edit_distance / numeric_distance / date_proximity.
  return `${fuzzyScoreExpr(op, fieldA, fieldB, dialect)} >= ${fsFmt(gte ?? 0)}`;
}
