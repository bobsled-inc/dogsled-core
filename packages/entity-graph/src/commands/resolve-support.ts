import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SqlQueryRow,
  type SqlQueryRunner,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { out } from '@bobsled-inc/model-spec/shared';
import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';
import { hasFlagForReviewRules } from '../compiler/identity/types.js';
import { outputTableName } from '../compiler/output-tables/index.js';
import { buildSemanticEmbeddingEstimateQuery } from '../compiler/identity/codegen-semantic-triage.js';
import { normalizeQueryRow, toNullableNumber, toNullableString } from './resolve-query-utils.js';
import {
  resolveStateSourceDefinitions,
  type ResolveStateSourceDefinition,
} from '../compiler/identity/codegen-resolve-state.js';
import { buildRecordIdExpr, buildSourcePkJsonExpr, nullOfType } from '../compiler/identity/sql.js';

// ---------------------------------------------------------------------------
// Inspect result types
// ---------------------------------------------------------------------------

export interface InspectPairResult {
  found: true;
  pair_id: string | null;
  record_a_id: string | null;
  record_b_id: string | null;
  source_a: string | null;
  source_b: string | null;
  composite_score: number | null;
  match_type: string | null;
  rule_name: string | null;
  blocking_rules: string[];
  field_scores: Record<string, number>;
  threshold_band: string | null;
  recommended_action: string | null;
  semantic_score: number | null;
  semantic_decision: string | null;
  decision: string | null;
  confidence: number | null;
  reviewer: string | null;
  reason: string | null;
  proposed_decision: string | null;
  proposed_confidence: number | null;
  decision_batch_id: string | null;
  decision_source: string | null;
  decided_at: string | null;
  applied_at: string | null;
}

const RESOLVE_STATUS_STAGES = [
  { stage: 'standardized', table: '__standardized' },
  { stage: 'match_inbox', table: '__match_inbox' },
  { stage: 'candidate_pairs', table: '__candidate_pairs' },
  { stage: 'pair_scores', table: '__pair_scores' },
  { stage: 'review_queue', table: '__review_queue' },
  { stage: 'review_decisions', table: '__review_decisions' },
  { stage: 'components', table: '__components' },
  { stage: 'entity_id_events', table: '__entity_id_events' },
  { stage: 'entity_id_record_map', table: '__entity_id_record_map' },
  { stage: 'entity_id_current', table: '__entity_id_current' },
  { stage: 'entity_id_aliases', table: '__entity_id_aliases' },
  { stage: 'clusters', table: '__clusters' },
  { stage: 'crosswalks', table: '__crosswalks' },
  { stage: 'entity_profile', table: '__entity_profile' },
  { stage: 'entity_quality', table: '__entity_quality' },
  { stage: 'golden_record', table: '__golden_record' },
  { stage: 'golden', table: '__golden' },
  { stage: 'golden_masked', table: '__golden_masked' },
] as const;

function buildStageCountQuery(
  entity: string,
  targetSchema: string,
  tableSuffix: (typeof RESOLVE_STATUS_STAGES)[number]['table'],
  dialect: SupportedDialect
): string {
  return [
    `SELECT`,
    `  COUNT(*) AS ${quoteIdentifier('row_count', dialect)}`,
    `FROM ${buildFqName(targetSchema, outputTableName(entity, tableSuffix), dialect)}`,
  ].join('\n');
}

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|not found|unknown table|no such table|object .* does not exist|table or view .* not found|relation .* does not exist|SQLSTATE.*42P01/i.test(
    message
  );
}

function readRowCount(rows: SqlQueryRow[]): number {
  const firstRow = rows[0];
  if (!firstRow) {
    return 0;
  }

  const lowerCaseEntries = new Map(
    Object.entries(firstRow).map(([key, value]) => [key.toLowerCase(), value])
  );
  const rawCount = lowerCaseEntries.get('row_count');
  const rowCount = Number(rawCount);
  return Number.isFinite(rowCount) ? rowCount : 0;
}

function normalizeStatusRows(
  rows: SqlQueryRow[]
): Array<{ stage: string; row_count: number }> | null {
  const normalized = rows
    .map((row) => {
      const lowerCaseEntries = new Map(
        Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
      );
      const stage = lowerCaseEntries.get('stage');
      const rawCount = lowerCaseEntries.get('row_count');
      const rowCount = Number(rawCount);
      if (typeof stage !== 'string' || !Number.isFinite(rowCount)) {
        return null;
      }
      return { stage, row_count: rowCount };
    })
    .filter((row): row is { stage: string; row_count: number } => row !== null);

  return normalized.length > 0 ? normalized : null;
}

function parseJsonObject(value: unknown): Record<string, number> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, raw]) => {
        const parsedNumber = Number(raw);
        return Number.isFinite(parsedNumber) ? [[key, parsedNumber]] : [];
      })
    );
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export function transformInspectPairResult(rows: SqlQueryRow[]): InspectPairResult | null {
  const row = rows[0];
  if (!row) {
    return null;
  }

  const normalized = normalizeQueryRow(row);
  return {
    found: true,
    pair_id: toNullableString(normalized.pair_id),
    record_a_id: toNullableString(normalized.record_a_id),
    record_b_id: toNullableString(normalized.record_b_id),
    source_a: toNullableString(normalized.source_a),
    source_b: toNullableString(normalized.source_b),
    composite_score: toNullableNumber(normalized.composite_score),
    match_type: toNullableString(normalized.match_type),
    rule_name: toNullableString(normalized.rule_name),
    blocking_rules: parseJsonArray(normalized.blocking_rules),
    field_scores: parseJsonObject(normalized.field_scores),
    threshold_band: toNullableString(normalized.threshold_band),
    recommended_action: toNullableString(normalized.recommended_action),
    semantic_score: toNullableNumber(normalized.semantic_score),
    semantic_decision: toNullableString(normalized.semantic_decision),
    decision: toNullableString(normalized.decision),
    confidence: toNullableNumber(normalized.confidence),
    reviewer: toNullableString(normalized.reviewer),
    reason: toNullableString(normalized.reason),
    proposed_decision: toNullableString(normalized.proposed_decision),
    proposed_confidence: toNullableNumber(normalized.proposed_confidence),
    decision_batch_id: toNullableString(normalized.decision_batch_id),
    decision_source: toNullableString(normalized.decision_source),
    decided_at: toNullableString(normalized.decided_at),
    applied_at: toNullableString(normalized.applied_at),
  };
}

export async function runResolveStatusQuery(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect,
  query: SqlQueryRunner
): Promise<Array<{ stage: string; row_count: number }>> {
  try {
    const unionRows = await query(buildResolveStatusQuery(entity, targetSchema, dialect));
    const normalizedUnionRows = normalizeStatusRows(unionRows);
    if (normalizedUnionRows != null) {
      return normalizedUnionRows;
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }

  const rows: Array<{ stage: string; row_count: number }> = [];

  for (const { stage, table } of RESOLVE_STATUS_STAGES) {
    try {
      const rawRows = await query(buildStageCountQuery(entity, targetSchema, table, dialect));
      rows.push({ stage, row_count: readRowCount(rawRows) });
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
      rows.push({ stage, row_count: 0 });
    }
  }

  return rows;
}

export function buildResolveStatusQuery(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect
): string {
  return RESOLVE_STATUS_STAGES.map(
    ({ stage, table }) =>
      `SELECT ${quoteLiteral(stage, dialect)} AS ${quoteIdentifier('stage', dialect)}, COUNT(*) AS ${quoteIdentifier('row_count', dialect)} FROM ${buildFqName(targetSchema, outputTableName(entity, table), dialect)}`
  ).join('\nUNION ALL\n');
}

export function buildResolveEstimateQuery(
  spec: ResolvedResolutionSpec,
  targetSchema: string,
  dialect: SupportedDialect,
  options: { includeSemanticTriage?: boolean; useSemanticCache?: boolean } = {}
): string {
  const scoresTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__pair_scores'),
    dialect
  );
  const score = quoteIdentifier('composite_score', dialect);
  const matchType = quoteIdentifier('match_type', dialect);
  // flag_for_review pairs count as review regardless of score band — they
  // never auto-merge and never auto-reject.
  const flaggedMatch = `${matchType} = ${quoteLiteral('deterministic_review', dialect)}`;
  const flagRules = hasFlagForReviewRules(spec);
  // auto_merge: null → merges come only from deterministic-rule pairs; the
  // review band is unbounded above for everything else.
  const autoMergeBand =
    spec.thresholds.autoMerge === null
      ? `${matchType} = ${quoteLiteral('deterministic', dialect)}`
      : `${score} >= ${spec.thresholds.autoMerge}`;
  const autoMergePredicate =
    flagRules && spec.thresholds.autoMerge !== null
      ? `${autoMergeBand} AND ${matchType} <> ${quoteLiteral('deterministic_review', dialect)}`
      : autoMergeBand;
  const reviewBand =
    spec.thresholds.autoMerge === null
      ? `${score} >= ${spec.thresholds.review} AND ${matchType} <> ${quoteLiteral('deterministic', dialect)}`
      : `${score} >= ${spec.thresholds.review} AND ${score} < ${spec.thresholds.autoMerge}`;
  const reviewPredicate = flagRules ? `(${reviewBand}) OR ${flaggedMatch}` : reviewBand;
  // auto_merge: null → deterministic pairs merge regardless of confidence, so
  // a low-confidence one must not also count as an auto-reject. Under numeric
  // thresholds a below-review deterministic pair genuinely is rejected.
  const autoRejectBand =
    spec.thresholds.autoMerge === null
      ? `${score} < ${spec.thresholds.review} AND ${matchType} <> ${quoteLiteral('deterministic', dialect)}`
      : `${score} < ${spec.thresholds.review}`;
  const autoRejectPredicate = flagRules
    ? `${autoRejectBand} AND ${matchType} <> ${quoteLiteral('deterministic_review', dialect)}`
    : autoRejectBand;
  const baseQuery = [
    `SELECT`,
    `  COUNT(*) AS ${quoteIdentifier('total_pairs', dialect)},`,
    `  SUM(CASE WHEN ${autoMergePredicate} THEN 1 ELSE 0 END) AS ${quoteIdentifier('auto_merge_count', dialect)},`,
    `  SUM(CASE WHEN ${reviewPredicate} THEN 1 ELSE 0 END) AS ${quoteIdentifier('review_count', dialect)},`,
    `  SUM(CASE WHEN ${autoRejectPredicate} THEN 1 ELSE 0 END) AS ${quoteIdentifier('auto_reject_count', dialect)}`,
    `FROM ${scoresTable}`,
  ].join('\n');

  if (!options.includeSemanticTriage || !spec.semanticTriage) {
    return baseQuery;
  }

  const semanticQuery = buildSemanticEmbeddingEstimateQuery(
    spec,
    dialect,
    targetSchema,
    options.useSemanticCache ?? true
  );
  return [
    `WITH base_estimate AS (`,
    baseQuery,
    `), semantic_estimate AS (`,
    semanticQuery,
    `)`,
    `SELECT base_estimate.*, semantic_estimate.*`,
    `FROM base_estimate CROSS JOIN semantic_estimate`,
  ].join('\n');
}

function stateWatermarkExpr(
  entity: string,
  targetSchema: string,
  source: ResolveStateSourceDefinition,
  dialect: SupportedDialect
): string {
  const stateTable = buildFqName(targetSchema, outputTableName(entity, '__resolve_state'), dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  return [
    `(SELECT ${quoteIdentifier('watermark_value', dialect)}`,
    ` FROM ${stateTable}`,
    ` WHERE ${sourceRef} = ${quoteLiteral(source.sourceRef, dialect)})`,
  ].join('');
}

function watermarkCastExpr(valueExpr: string, dialect: SupportedDialect): string {
  const canonical = dialect === 'pgvector' || dialect === 'redshift' ? 'postgres' : dialect;
  if (canonical === 'mysql') return `CAST(${valueExpr} AS DATETIME)`;
  if (canonical === 'bigquery') return `TIMESTAMP(${valueExpr})`;
  return `CAST(${valueExpr} AS TIMESTAMP)`;
}

function stringCastType(dialect: SupportedDialect): string {
  const canonical = dialect === 'pgvector' || dialect === 'redshift' ? 'postgres' : dialect;
  if (canonical === 'bigquery' || canonical === 'databricks') return 'STRING';
  if (canonical === 'mysql') return 'CHAR';
  return 'VARCHAR';
}

function buildDeltaSelect(
  spec: ResolvedResolutionSpec,
  source: ResolveStateSourceDefinition,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const input = spec.inputs.find((candidate) => candidate.ref === source.sourceRef);
  if (!input || source.watermarkKind !== 'loaded_at' || !source.watermarkColumn) {
    return [
      `SELECT`,
      `  ${quoteLiteral(source.sourceRef, dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
      `  ${nullOfType(stringCastType(dialect), dialect)} AS ${quoteIdentifier('record_id', dialect)}`,
      `WHERE 1 = 0`,
    ].join('\n');
  }

  const sourceAlias = quoteIdentifier('src', dialect);
  const idFields = input.idFields ?? [];
  const sourcePkJson = buildSourcePkJsonExpr(idFields, dialect, sourceAlias);
  const recordId = buildRecordIdExpr(input.ref, sourcePkJson, dialect);
  const previous = watermarkCastExpr(
    stateWatermarkExpr(spec.entity, targetSchema, source, dialect),
    dialect
  );
  return [
    `SELECT`,
    `  ${quoteLiteral(source.sourceRef, dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
    `  ${recordId} AS ${quoteIdentifier('record_id', dialect)}`,
    `FROM ${input.fqTableName} AS ${sourceAlias}`,
    `WHERE ${sourceAlias}.${quoteIdentifier(source.watermarkColumn, dialect)} > ${previous}`,
  ].join('\n');
}

export function buildResolveIncrementalEstimateQuery(
  spec: ResolvedResolutionSpec,
  targetSchema: string,
  dialect: SupportedDialect
): string {
  const sources = resolveStateSourceDefinitions(spec);
  const standardized = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__standardized'),
    dialect
  );
  const deltaSelects = sources.map((source) =>
    buildDeltaSelect(spec, source, dialect, targetSchema)
  );
  return [
    `WITH delta_records AS (`,
    deltaSelects.join('\nUNION ALL\n'),
    `), accumulated AS (`,
    `  SELECT COUNT(*) AS ${quoteIdentifier('total_records', dialect)}`,
    `  FROM ${standardized}`,
    `)`,
    `SELECT`,
    `  COUNT(*) AS ${quoteIdentifier('delta_rows', dialect)},`,
    `  COUNT(*) * MAX(accumulated.${quoteIdentifier('total_records', dialect)}) AS ${quoteIdentifier('estimated_candidate_pairs', dialect)}`,
    `FROM delta_records`,
    `CROSS JOIN accumulated`,
  ].join('\n');
}

export function buildResolveInspectPairQuery(
  entity: string,
  targetSchema: string,
  pairId: string,
  dialect: SupportedDialect
): string {
  const scoresTable = buildFqName(targetSchema, outputTableName(entity, '__pair_scores'), dialect);
  const queueTable = buildFqName(targetSchema, outputTableName(entity, '__review_queue'), dialect);
  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__review_decisions'),
    dialect
  );
  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const decidedAtCol = quoteIdentifier('decided_at', dialect);
  const appliedAtCol = quoteIdentifier('applied_at', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const proposedDecisionCol = quoteIdentifier('proposed_decision', dialect);
  const proposedConfidenceCol = quoteIdentifier('proposed_confidence', dialect);

  return [
    `WITH latest_decisions AS (`,
    `  SELECT *`,
    `  FROM (`,
    `    SELECT`,
    `      ${pairIdCol},`,
    `      ${decisionCol},`,
    `      ${confidenceCol},`,
    `      ${quoteIdentifier('reviewer', dialect)},`,
    `      ${quoteIdentifier('reason', dialect)},`,
    `      ${proposedDecisionCol},`,
    `      ${proposedConfidenceCol},`,
    `      ${quoteIdentifier('decision_batch_id', dialect)},`,
    `      ${quoteIdentifier('decision_source', dialect)},`,
    `      ${decidedAtCol},`,
    `      ${appliedAtCol},`,
    `      ROW_NUMBER() OVER (PARTITION BY ${pairIdCol} ORDER BY ${decidedAtCol} DESC, ${appliedAtCol} DESC) AS rn`,
    `    FROM ${decisionsTable}`,
    `  ) ranked`,
    `  WHERE ranked.rn = 1`,
    `)`,
    `SELECT`,
    `  ps.*,`,
    `  rq.${quoteIdentifier('threshold_band', dialect)},`,
    `  rq.${quoteIdentifier('recommended_action', dialect)},`,
    `  rq.${quoteIdentifier('semantic_score', dialect)},`,
    `  rq.${quoteIdentifier('semantic_decision', dialect)},`,
    `  ld.${decisionCol},`,
    `  ld.${confidenceCol},`,
    `  ld.${quoteIdentifier('reviewer', dialect)},`,
    `  ld.${quoteIdentifier('reason', dialect)},`,
    `  ld.${proposedDecisionCol},`,
    `  ld.${proposedConfidenceCol},`,
    `  ld.${quoteIdentifier('decision_batch_id', dialect)},`,
    `  ld.${quoteIdentifier('decision_source', dialect)},`,
    `  ld.${decidedAtCol},`,
    `  ld.${appliedAtCol}`,
    `FROM ${scoresTable} ps`,
    `LEFT JOIN ${queueTable} rq ON ps.${pairIdCol} = rq.${pairIdCol}`,
    `LEFT JOIN latest_decisions ld ON ps.${pairIdCol} = ld.${pairIdCol}`,
    `WHERE ps.${pairIdCol} = ${quoteLiteral(pairId, dialect)}`,
  ].join('\n');
}

export function emitResolutionSql(
  result: { preamble?: string; statements: Array<{ name: string; sql: string }> },
  includeComments: boolean
): void {
  if (result.preamble) {
    const prefix = includeComments ? '-- Preamble (UDFs / extensions)\n' : '';
    out.text(`${prefix}${result.preamble}\n\n`);
  }

  for (const statement of result.statements) {
    const prefix = includeComments ? `-- ${statement.name}\n` : '';
    out.text(`${prefix}${statement.sql};\n\n`);
  }
}
