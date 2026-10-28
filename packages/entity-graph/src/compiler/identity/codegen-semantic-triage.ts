import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { semanticSimilarityExpr } from '../core/dialect-semantic.js';
import { buildFlagAwareBandExpr, reviewBandMidpoint } from './codegen-threshold.js';
import { outputTableName } from '../output-tables/index.js';
import { ENTITY_GRAPH_SCHEMA } from '../audit/codegen.js';
import { buildJsonObjectExpr, castToString, concatSql, md5Expr, unionDistinct } from './sql.js';
import type { ResolvedResolutionSpec, SemanticTriageConfig, SqlStatement } from './types.js';
import { hasFlagForReviewRules } from './types.js';
import { resolveSemanticEmbeddingProviderConfig } from './embeddings/provider.js';

export interface SemanticTriageCodegenResult {
  statements: SqlStatement[];
  warnings: string[];
}

export const SEMANTIC_TRIAGE_START_STATEMENT = 'semantic_pair_scores';

export function semanticContentHashExpr(
  valueExpr: string,
  config: SemanticTriageConfig,
  dialect: SupportedDialect
): string {
  const provider = resolveSemanticEmbeddingProviderConfig(config);
  return md5Expr(
    concatSql(
      [
        quoteLiteral(provider.id, dialect),
        quoteLiteral('\u001f', dialect),
        quoteLiteral(provider.model, dialect),
        quoteLiteral('\u001f', dialect),
        quoteLiteral(String(provider.dimensions), dialect),
        quoteLiteral('\u001f', dialect),
        castToString(valueExpr, dialect),
      ],
      dialect
    ),
    dialect
  );
}

function reviewBandPredicate(spec: ResolvedResolutionSpec, dialect: SupportedDialect): string {
  const compositeScore = quoteIdentifier('composite_score', dialect);
  // flag_for_review pairs are queued by rule, not by score — semantic triage
  // must neither promote them to merge/reject nor spend embedding budget on
  // them, so they sit outside the triage-eligible band.
  const flaggedExclusion = hasFlagForReviewRules(spec)
    ? ` AND ${quoteIdentifier('match_type', dialect)} <> ${quoteLiteral('deterministic_review', dialect)}`
    : '';
  if (spec.thresholds.autoMerge === null) {
    // Unbounded review band; deterministic-rule pairs merge directly and are
    // excluded from triage.
    return `${compositeScore} >= ${spec.thresholds.review} AND ${quoteIdentifier('match_type', dialect)} <> ${quoteLiteral('deterministic', dialect)}${flaggedExclusion}`;
  }
  return `${compositeScore} >= ${spec.thresholds.review} AND ${compositeScore} < ${spec.thresholds.autoMerge}${flaggedExclusion}`;
}

function semanticFieldPairSelects(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): string[] {
  const triage = spec.semanticTriage;
  if (!triage) {
    return [];
  }

  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_scores'),
    dialect
  );
  const stdTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const recordAId = quoteIdentifier('record_a_id', dialect);
  const recordBId = quoteIdentifier('record_b_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);

  return triage.fields.map((field) => {
    const quotedField = quoteIdentifier(field, dialect);
    const leftValue = `a.${quotedField}`;
    const rightValue = `b.${quotedField}`;
    return [
      `SELECT`,
      `  ps.${pairId} AS ${pairId},`,
      `  ${quoteLiteral(field, dialect)} AS ${quoteIdentifier('field', dialect)},`,
      `  ${castToString(leftValue, dialect)} AS ${quoteIdentifier('left_text', dialect)},`,
      `  ${castToString(rightValue, dialect)} AS ${quoteIdentifier('right_text', dialect)},`,
      `  ${semanticContentHashExpr(leftValue, triage, dialect)} AS ${quoteIdentifier('left_hash', dialect)},`,
      `  ${semanticContentHashExpr(rightValue, triage, dialect)} AS ${quoteIdentifier('right_hash', dialect)}`,
      `FROM ${scoresTable} ps`,
      `JOIN ${stdTable} a ON ps.${recordAId} = a.${recordId}`,
      `JOIN ${stdTable} b ON ps.${recordBId} = b.${recordId}`,
      `WHERE ${reviewBandPredicate(spec, dialect)}`,
      `  AND ${leftValue} IS NOT NULL`,
      `  AND ${rightValue} IS NOT NULL`,
    ].join('\n');
  });
}

function semanticFieldPairsCte(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const selects = semanticFieldPairSelects(spec, dialect, targetSchema);
  return selects.join('\nUNION ALL\n');
}

export function buildSemanticEmbeddingInputQuery(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const cacheTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__embedding_cache'),
    dialect
  );
  const provider = quoteIdentifier('provider', dialect);
  const contentHash = quoteIdentifier('content_hash', dialect);
  const inputText = quoteIdentifier('input_text', dialect);
  const fieldPairs = semanticFieldPairsCte(spec, dialect, targetSchema);

  return [
    `WITH field_pairs AS (`,
    fieldPairs,
    `), embedding_inputs AS (`,
    `  SELECT DISTINCT ${quoteIdentifier('left_hash', dialect)} AS ${contentHash}, ${quoteIdentifier('left_text', dialect)} AS ${inputText}`,
    `  FROM field_pairs`,
    `  ${unionDistinct(dialect)}`,
    `  SELECT DISTINCT ${quoteIdentifier('right_hash', dialect)} AS ${contentHash}, ${quoteIdentifier('right_text', dialect)} AS ${inputText}`,
    `  FROM field_pairs`,
    `)`,
    `SELECT inputs.${contentHash}, inputs.${inputText}`,
    `FROM embedding_inputs inputs`,
    `LEFT JOIN ${cacheTable} cache`,
    `  ON cache.${contentHash} = inputs.${contentHash}`,
    ` AND cache.${provider} = ${quoteLiteral(triage.provider, dialect)}`,
    `WHERE cache.${contentHash} IS NULL`,
    `  AND TRIM(inputs.${inputText}) <> ${quoteLiteral('', dialect)}`,
    `ORDER BY inputs.${contentHash}`,
  ].join('\n');
}

export function buildSemanticEmbeddingEstimateQuery(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  useCache: boolean
): string {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const provider = resolveSemanticEmbeddingProviderConfig(triage);
  const cacheTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__embedding_cache'),
    dialect
  );
  const fieldPairs = semanticFieldPairsCte(spec, dialect, targetSchema);
  const contentHash = quoteIdentifier('content_hash', dialect);
  const inputText = quoteIdentifier('input_text', dialect);
  const providerCol = quoteIdentifier('provider', dialect);
  const tokenExpr = `CEIL(LENGTH(${inputText}) / 4.0)`;
  const missingSource = useCache
    ? [
        `SELECT inputs.*`,
        `FROM embedding_inputs inputs`,
        `LEFT JOIN ${cacheTable} cache`,
        `  ON cache.${contentHash} = inputs.${contentHash}`,
        ` AND cache.${providerCol} = ${quoteLiteral(triage.provider, dialect)}`,
        `WHERE cache.${contentHash} IS NULL`,
        `  AND TRIM(inputs.${inputText}) <> ${quoteLiteral('', dialect)}`,
      ].join('\n')
    : [
        `SELECT *`,
        `FROM embedding_inputs`,
        `WHERE TRIM(${inputText}) <> ${quoteLiteral('', dialect)}`,
      ].join('\n');

  return [
    `WITH field_pairs AS (`,
    fieldPairs,
    `), embedding_inputs AS (`,
    `  SELECT DISTINCT ${quoteIdentifier('left_hash', dialect)} AS ${contentHash}, ${quoteIdentifier('left_text', dialect)} AS ${inputText}`,
    `  FROM field_pairs`,
    `  ${unionDistinct(dialect)}`,
    `  SELECT DISTINCT ${quoteIdentifier('right_hash', dialect)} AS ${contentHash}, ${quoteIdentifier('right_text', dialect)} AS ${inputText}`,
    `  FROM field_pairs`,
    `), missing_inputs AS (`,
    missingSource,
    `)`,
    `SELECT`,
    `  COUNT(DISTINCT ${quoteIdentifier('pair_id', dialect)}) AS ${quoteIdentifier('semantic_candidate_count', dialect)},`,
    `  ${triage.fields.length} AS ${quoteIdentifier('semantic_field_count', dialect)},`,
    `  (SELECT COUNT(*) FROM missing_inputs) AS ${quoteIdentifier('estimated_embedding_input_count', dialect)},`,
    `  (SELECT COALESCE(SUM(${tokenExpr}), 0) FROM missing_inputs) AS ${quoteIdentifier('estimated_embedding_tokens', dialect)},`,
    `  ((SELECT COALESCE(SUM(${tokenExpr}), 0) FROM missing_inputs) / 1000000.0) * ${provider.pricePerMillionTokensUsd} AS ${quoteIdentifier('estimated_embedding_cost_usd', dialect)}`,
    `FROM field_pairs`,
  ].join('\n');
}

function generatePairSemanticScoresSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const outputTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_semantic_scores'),
    dialect
  );
  const cacheTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__embedding_cache'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const field = quoteIdentifier('field', dialect);
  const provider = quoteIdentifier('provider', dialect);
  const contentHash = quoteIdentifier('content_hash', dialect);
  const embedding = quoteIdentifier('embedding', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const fieldPairs = semanticFieldPairsCte(spec, dialect, targetSchema);

  const sql = [
    createOrReplaceTableAs(outputTable, dialect),
    `WITH field_pairs AS (`,
    fieldPairs,
    `)`,
    `SELECT`,
    `  fp.${pairId},`,
    `  fp.${field},`,
    `  ${semanticSimilarityExpr({ leftVector: `left_cache.${embedding}`, rightVector: `right_cache.${embedding}`, dialect })} AS ${semanticScore},`,
    `  CURRENT_TIMESTAMP AS ${quoteIdentifier('evaluated_at', dialect)}`,
    `FROM field_pairs fp`,
    `JOIN ${cacheTable} left_cache`,
    `  ON left_cache.${contentHash} = fp.${quoteIdentifier('left_hash', dialect)}`,
    ` AND left_cache.${provider} = ${quoteLiteral(triage.provider, dialect)}`,
    `JOIN ${cacheTable} right_cache`,
    `  ON right_cache.${contentHash} = fp.${quoteIdentifier('right_hash', dialect)}`,
    ` AND right_cache.${provider} = ${quoteLiteral(triage.provider, dialect)}`,
  ].join('\n');

  return {
    name: SEMANTIC_TRIAGE_START_STATEMENT,
    sql,
    tableCreated: outputTableName(spec.entity, '__pair_semantic_scores'),
  };
}

function semanticAggregateCte(dialect: SupportedDialect, sourceTable: string): string {
  const pairId = quoteIdentifier('pair_id', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  return [
    `semantic_pairs AS (`,
    `  SELECT ${pairId}, AVG(${semanticScore}) AS ${semanticScore}`,
    `  FROM ${sourceTable}`,
    `  GROUP BY ${pairId}`,
    `)`,
  ].join('\n');
}

function generateSemanticReviewQueueSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_scores'),
    dialect
  );
  const pairSemanticTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_semantic_scores'),
    dialect
  );
  const queueTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__review_queue'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const semanticDecision = quoteIdentifier('semantic_decision', dialect);
  const midpoint = reviewBandMidpoint(spec.thresholds);
  const flagRules = hasFlagForReviewRules(spec);
  const flaggedMatch = `ps.${quoteIdentifier('match_type', dialect)} = ${quoteLiteral('deterministic_review', dialect)}`;

  // flag_for_review pairs sit outside the triage band (no semantic score,
  // no promotion) but must survive the queue rebuild with their own band.
  const bandExpr = buildFlagAwareBandExpr(dialect, flagRules, flaggedMatch);
  const semanticDecisionExpr = flagRules
    ? [
        `CASE`,
        `    WHEN ${flaggedMatch} THEN NULL`,
        `    ELSE ${quoteLiteral('kept_for_review', dialect)}`,
        `  END`,
      ].join('\n')
    : quoteLiteral('kept_for_review', dialect);

  const aggregate = semanticAggregateCte(dialect, pairSemanticTable);

  const sql = [
    createOrReplaceTableAs(queueTable, dialect),
    `WITH ${aggregate}`,
    `SELECT`,
    `  ps.${pairId},`,
    `  ps.${quoteIdentifier('record_a_id', dialect)},`,
    `  ps.${quoteIdentifier('record_b_id', dialect)},`,
    `  ps.${quoteIdentifier('source_a', dialect)},`,
    `  ps.${quoteIdentifier('source_b', dialect)},`,
    `  ps.${compositeScore},`,
    `  ${bandExpr} AS ${quoteIdentifier('threshold_band', dialect)},`,
    `  ps.${quoteIdentifier('blocking_rules', dialect)},`,
    `  ps.${quoteIdentifier('field_scores', dialect)} AS ${quoteIdentifier('field_diffs', dialect)},`,
    `  CASE`,
    `    WHEN ps.${compositeScore} >= ${midpoint} THEN ${quoteLiteral('merge', dialect)}`,
    `    ELSE ${quoteLiteral('not_match', dialect)}`,
    `  END AS ${quoteIdentifier('recommended_action', dialect)},`,
    `  sp.${semanticScore},`,
    `  ${semanticDecisionExpr} AS ${semanticDecision},`,
    `  ps.${quoteIdentifier('rule_name', dialect)}`,
    `FROM ${scoresTable} ps`,
    `LEFT JOIN semantic_pairs sp ON ps.${pairId} = sp.${pairId}`,
    ...(flagRules
      ? [
          `WHERE ((${reviewBandPredicate(spec, dialect)})`,
          `  AND (`,
          `    sp.${semanticScore} IS NULL`,
          `    OR (sp.${semanticScore} < ${triage.promoteToMergeThreshold} AND sp.${semanticScore} > ${triage.promoteToRejectThreshold})`,
          `  ))`,
          `  OR ${flaggedMatch}`,
        ]
      : [
          `WHERE ${reviewBandPredicate(spec, dialect)}`,
          `  AND (`,
          `    sp.${semanticScore} IS NULL`,
          `    OR (sp.${semanticScore} < ${triage.promoteToMergeThreshold} AND sp.${semanticScore} > ${triage.promoteToRejectThreshold})`,
          `  )`,
        ]),
  ].join('\n');

  return {
    name: 'semantic_review_queue',
    sql,
    tableCreated: outputTableName(spec.entity, '__review_queue'),
  };
}

function generateSemanticNotMatchEdgesSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_scores'),
    dialect
  );
  const pairSemanticTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_semantic_scores'),
    dialect
  );
  const notMatchTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__not_match_edges'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const aggregate = semanticAggregateCte(dialect, pairSemanticTable);

  return {
    name: 'semantic_not_match_edges',
    sql: [
      `WITH ${aggregate}`,
      `INSERT INTO ${notMatchTable} (`,
      `  ${pairId}, ${quoteIdentifier('record_a_id', dialect)}, ${quoteIdentifier('record_b_id', dialect)}, ${quoteIdentifier('reviewer', dialect)},`,
      `  ${quoteIdentifier('reason', dialect)}, ${quoteIdentifier('decision_batch_id', dialect)}, ${quoteIdentifier('decision_source', dialect)},`,
      `  ${quoteIdentifier('decided_at', dialect)}, ${quoteIdentifier('applied_at', dialect)}, ${quoteIdentifier('confidence', dialect)}`,
      `)`,
      `SELECT`,
      `  ps.${pairId},`,
      `  ps.${quoteIdentifier('record_a_id', dialect)},`,
      `  ps.${quoteIdentifier('record_b_id', dialect)},`,
      `  ${quoteLiteral('semantic_triage', dialect)},`,
      `  ${quoteLiteral('Semantic triage promoted pair to not_match.', dialect)},`,
      `  ${quoteLiteral('semantic_triage', dialect)},`,
      `  ${quoteLiteral('semantic_triage', dialect)},`,
      `  CURRENT_TIMESTAMP,`,
      `  CURRENT_TIMESTAMP,`,
      `  sp.${semanticScore}`,
      `FROM ${scoresTable} ps`,
      `JOIN semantic_pairs sp ON ps.${pairId} = sp.${pairId}`,
      `WHERE ${reviewBandPredicate(spec, dialect)}`,
      `  AND sp.${semanticScore} <= ${triage.promoteToRejectThreshold}`,
      `  AND NOT EXISTS (`,
      `    SELECT 1 FROM ${notMatchTable} existing`,
      `    WHERE existing.${pairId} = ps.${pairId}`,
      `      AND existing.${quoteIdentifier('decision_source', dialect)} = ${quoteLiteral('semantic_triage', dialect)}`,
      `  )`,
    ].join('\n'),
  };
}

function generateSemanticPromotionAuditSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const triage = spec.semanticTriage;
  if (!triage) {
    throw new Error(`Resolution spec ${spec.name} does not enable semantic triage.`);
  }

  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_scores'),
    dialect
  );
  const pairSemanticTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_semantic_scores'),
    dialect
  );
  const auditTable = buildFqName(ENTITY_GRAPH_SCHEMA, 'audit_log', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const kind = quoteIdentifier('kind', dialect);
  const threshold = quoteIdentifier('threshold', dialect);
  const aggregate = semanticAggregateCte(dialect, pairSemanticTable);

  const payload = buildJsonObjectExpr(
    [
      ['kind', `promotions.${kind}`],
      ['semantic_score', `promotions.${semanticScore}`],
      ['threshold', `promotions.${threshold}`],
      ['provider', quoteLiteral(triage.provider, dialect)],
    ],
    dialect
  );
  const eventId = concatSql(
    [
      quoteLiteral('eg-', dialect),
      `promotions.${kind}`,
      quoteLiteral('-', dialect),
      `promotions.${pairId}`,
      quoteLiteral('-', dialect),
      quoteLiteral(triage.provider, dialect),
    ],
    dialect
  );

  return {
    name: 'audit_semantic_promotions',
    sql: [
      `WITH ${aggregate}, promotions AS (`,
      `  SELECT`,
      `    ps.${pairId},`,
      `    sp.${semanticScore},`,
      `    CASE`,
      `      WHEN sp.${semanticScore} >= ${triage.promoteToMergeThreshold} THEN ${quoteLiteral('semantic_promote_merge', dialect)}`,
      `      ELSE ${quoteLiteral('semantic_promote_reject', dialect)}`,
      `    END AS ${kind},`,
      `    CASE`,
      `      WHEN sp.${semanticScore} >= ${triage.promoteToMergeThreshold} THEN ${triage.promoteToMergeThreshold}`,
      `      ELSE ${triage.promoteToRejectThreshold}`,
      `    END AS ${threshold}`,
      `  FROM ${scoresTable} ps`,
      `  JOIN semantic_pairs sp ON ps.${pairId} = sp.${pairId}`,
      `  WHERE ${reviewBandPredicate(spec, dialect)}`,
      `    AND (sp.${semanticScore} >= ${triage.promoteToMergeThreshold} OR sp.${semanticScore} <= ${triage.promoteToRejectThreshold})`,
      `)`,
      `INSERT INTO ${auditTable} (`,
      `  ${quoteIdentifier('event_id', dialect)}, ${quoteIdentifier('category', dialect)}, ${quoteIdentifier('subject_type', dialect)}, ${quoteIdentifier('subject_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)}, ${quoteIdentifier('edge_id', dialect)}, ${quoteIdentifier('payload', dialect)}, ${quoteIdentifier('reason', dialect)},`,
      `  ${quoteIdentifier('actor', dialect)}, ${quoteIdentifier('actor_type', dialect)}, ${quoteIdentifier('occurred_at', dialect)}`,
      `)`,
      `SELECT`,
      `  ${eventId},`,
      `  ${quoteLiteral('mutation', dialect)},`,
      `  ${quoteLiteral('edge', dialect)},`,
      `  promotions.${pairId},`,
      `  NULL,`,
      `  NULL,`,
      `  ${payload},`,
      `  ${quoteLiteral('Semantic triage promotion.', dialect)},`,
      `  ${quoteLiteral('system', dialect)},`,
      `  ${quoteLiteral('system', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      `FROM promotions`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${auditTable} existing`,
      `  WHERE existing.${quoteIdentifier('event_id', dialect)} = ${eventId}`,
      `)`,
    ].join('\n'),
  };
}

export function generateSemanticTriageSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SemanticTriageCodegenResult {
  if (!spec.semanticTriage) {
    return { statements: [], warnings: [] };
  }

  return {
    statements: [
      generatePairSemanticScoresSql(spec, dialect, targetSchema),
      generateSemanticReviewQueueSql(spec, dialect, targetSchema),
      generateSemanticNotMatchEdgesSql(spec, dialect, targetSchema),
      generateSemanticPromotionAuditSql(spec, dialect, targetSchema),
    ],
    warnings: [],
  };
}
