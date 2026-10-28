import {
  buildFqName,
  getCanonicalDialect,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import { outputTableName } from '../output-tables/index.js';
import { fsLevelCondition } from './codegen-scoring.js';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { FellegiSunterComparison, ResolvedResolutionSpec } from './types.js';

function randomFunction(dialect: SupportedDialect): string {
  const canonical = getCanonicalDialect(dialect);
  if (canonical === 'bigquery' || canonical === 'mysql' || canonical === 'databricks') {
    return 'RAND()';
  }
  return 'RANDOM()';
}

function valuesList(values: string[], dialect: SupportedDialect): string {
  return values.map((value) => quoteLiteral(value, dialect)).join(', ');
}

function recordSampleLimitForPairSample(pairLimit: number): number {
  return Math.max(2, Math.ceil((1 + Math.sqrt(1 + 8 * pairLimit)) / 2));
}

function comparisonLevelCase(
  comparison: FellegiSunterComparison,
  comparisonIndex: number,
  dialect: SupportedDialect
): string {
  const fieldA = `a.${quoteIdentifier(comparison.field, dialect)}`;
  const fieldB = `b.${quoteIdentifier(comparison.field, dialect)}`;
  const levelAlias = quoteIdentifier(`level_${comparisonIndex}`, dialect);
  const whenClauses: string[] = [];
  let elseIndex = -1;

  comparison.levels.forEach((level, levelIndex) => {
    if (level.op === 'else') {
      elseIndex = levelIndex;
      return;
    }
    whenClauses.push(
      `WHEN ${fsLevelCondition(level.op, level.gte, fieldA, fieldB, dialect)} THEN ${levelIndex}`
    );
  });

  const fallbackIndex = elseIndex >= 0 ? elseIndex : -1;
  return [
    'CASE',
    `WHEN ${fieldA} IS NULL OR ${fieldB} IS NULL THEN -1`,
    ...whenClauses,
    `ELSE ${fallbackIndex}`,
    `END AS ${levelAlias}`,
  ].join(' ');
}

function levelSelectList(
  comparisons: FellegiSunterComparison[],
  dialect: SupportedDialect
): string[] {
  return comparisons.map((comparison, index) => comparisonLevelCase(comparison, index, dialect));
}

function standardizedTable(
  spec: Pick<ResolvedResolutionSpec, 'entity'>,
  schema: string,
  dialect: SupportedDialect
): string {
  return buildFqName(schema, outputTableName(spec.entity, '__standardized'), dialect);
}

function pairScoresTable(
  spec: Pick<ResolvedResolutionSpec, 'entity'>,
  schema: string,
  dialect: SupportedDialect
): string {
  return buildFqName(schema, outputTableName(spec.entity, '__pair_scores'), dialect);
}

export function buildLabeledLevelOutcomeQuery(
  spec: ResolvedResolutionSpec,
  pairIds: string[],
  schema: string,
  dialect: SupportedDialect
): string {
  if (spec.scoring?.method !== 'fellegi_sunter') {
    throw new Error('truthset train requires a fellegi_sunter scoring block.');
  }
  const scoresTable = pairScoresTable(spec, schema, dialect);
  const stdTable = standardizedTable(spec, schema, dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const selectLevels = levelSelectList(spec.scoring.comparisons, dialect);
  if (pairIds.length === 0) {
    throw new Error('buildLabeledLevelOutcomeQuery requires at least one pair id.');
  }
  return [
    `SELECT ps.${pairId} AS ${pairId},`,
    selectLevels.map((expr) => `  ${expr}`).join(',\n'),
    `FROM ${scoresTable} ps`,
    `JOIN ${stdTable} a ON ps.${recordAId} = a.${recordId}`,
    `JOIN ${stdTable} b ON ps.${recordBId} = b.${recordId}`,
    `WHERE ps.${pairId} IN (${valuesList(pairIds, dialect)})`,
  ].join('\n');
}

export function buildRandomPairLevelOutcomeQuery(
  spec: ResolvedResolutionSpec,
  samplePairs: number,
  schema: string,
  dialect: SupportedDialect
): string {
  if (spec.scoring?.method !== 'fellegi_sunter') {
    throw new Error('truthset train requires a fellegi_sunter scoring block.');
  }
  const limit = Math.max(1, Math.trunc(samplePairs));
  const stdTable = standardizedTable(spec, schema, dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const selectLevels = levelSelectList(spec.scoring.comparisons, dialect);
  const recordLimit = recordSampleLimitForPairSample(limit);
  return [
    'WITH sampled_records AS (',
    `  SELECT ${recordId}`,
    `  FROM ${stdTable}`,
    `  ORDER BY ${randomFunction(dialect)}`,
    `  LIMIT ${recordLimit}`,
    '), sampled_pairs AS (',
    `  SELECT a.${recordId} AS ${recordAId}, b.${recordId} AS ${recordBId}`,
    `  FROM sampled_records a`,
    `  JOIN sampled_records b ON a.${recordId} < b.${recordId}`,
    `  ORDER BY ${randomFunction(dialect)}`,
    `  LIMIT ${limit}`,
    ')',
    `SELECT`,
    selectLevels.map((expr) => `  ${expr}`).join(',\n'),
    `FROM sampled_pairs sp`,
    `JOIN ${stdTable} a ON sp.${recordAId} = a.${recordId}`,
    `JOIN ${stdTable} b ON sp.${recordBId} = b.${recordId}`,
  ].join('\n');
}

export function buildDeterministicPriorAnchorQuery(
  spec: ResolvedResolutionSpec,
  schema: string,
  dialect: SupportedDialect
): string {
  const priorAnchorRecordLimit = 2500;
  const stdTable = standardizedTable(spec, schema, dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const autoMergeRules = spec.deterministicRules.filter((rule) => rule.action === 'auto_merge');
  const rulePredicates = autoMergeRules.map((rule) => {
    const conditions = rule.conditions.map((condition) => {
      const fieldA = `a.${quoteIdentifier(condition.field, dialect)}`;
      const fieldB = `b.${quoteIdentifier(condition.field, dialect)}`;
      return `(${fieldA} = ${fieldB}${
        condition.bothNotNull ? ` AND ${fieldA} IS NOT NULL AND ${fieldB} IS NOT NULL` : ''
      })`;
    });
    return `(${conditions.join(' AND ')})`;
  });
  const anchorPredicate = rulePredicates.length === 0 ? 'FALSE' : rulePredicates.join(' OR ');

  return [
    'WITH sampled_records AS (',
    `  SELECT ${recordId}`,
    `  FROM ${stdTable}`,
    `  ORDER BY ${randomFunction(dialect)}`,
    `  LIMIT ${priorAnchorRecordLimit}`,
    '), stats AS (',
    `  SELECT COUNT(*) AS record_count FROM sampled_records`,
    '), anchors AS (',
    `  SELECT COUNT(*) AS deterministic_matches`,
    `  FROM sampled_records a`,
    `  JOIN sampled_records b ON a.${recordId} < b.${recordId}`,
    `  WHERE ${anchorPredicate}`,
    ')',
    'SELECT',
    '  anchors.deterministic_matches AS deterministic_matches,',
    '  (stats.record_count * (stats.record_count - 1) / 2) AS total_pairs',
    'FROM stats CROSS JOIN anchors',
  ].join('\n');
}

export function buildAutoMergeBandLevelOutcomeQuery(
  spec: ResolvedResolutionSpec,
  autoMergeThreshold: number,
  limit: number,
  schema: string,
  dialect: SupportedDialect
): string {
  if (spec.scoring?.method !== 'fellegi_sunter') {
    throw new Error('truthset train requires a fellegi_sunter scoring block.');
  }
  const scoresTable = pairScoresTable(spec, schema, dialect);
  const stdTable = standardizedTable(spec, schema, dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const selectLevels = levelSelectList(spec.scoring.comparisons, dialect);
  return [
    'WITH auto_merge_band AS (',
    `  SELECT ${recordAId}, ${recordBId}`,
    `  FROM ${scoresTable}`,
    `  WHERE ${compositeScore} >= ${autoMergeThreshold}`,
    `  ORDER BY ${compositeScore} DESC`,
    `  LIMIT ${Math.max(1, Math.trunc(limit))}`,
    ')',
    'SELECT',
    selectLevels.map((expr) => `  ${expr}`).join(',\n'),
    'FROM auto_merge_band ps',
    `JOIN ${stdTable} a ON ps.${recordAId} = a.${recordId}`,
    `JOIN ${stdTable} b ON ps.${recordBId} = b.${recordId}`,
  ].join('\n');
}
