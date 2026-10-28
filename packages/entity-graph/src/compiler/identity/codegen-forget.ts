import { createHash } from 'node:crypto';

import {
  buildFqName,
  emitSha256Expr,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { AuditPayload } from '@bobsled-inc/protocol';
import type { ResolvedInput, ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { generateAuditInsertSql } from '../audit/codegen.js';
import { castToString, concatSql, md5Expr, pairIdExpr, unionDistinct } from './sql.js';
import { semanticContentHashExpr } from './codegen-semantic-triage.js';

const MISSING_FORGET_SURFACE_ERROR_PATTERNS = [
  'does not exist',
  'not found',
  'unknown table',
  'no such table',
  'table or view',
] as const;

const PURGED_SURFACES = [
  '__standardized',
  '__candidate_pairs',
  '__pair_scores',
  '__pair_semantic_scores',
  '__crosswalks',
  '__review_queue',
  '__review_decisions',
  '__document_mentions',
  '__embedding_cache',
  '__match_inbox',
  '__survivorship_audit',
  'audit_log',
] as const;

/** Primary-key field values must be scalars — an object/array would stringify
 * to an unstable identifier (e.g. `[object Object]`) in the tombstone key. */
export type ForgetPrimaryKeyValue = string | number | boolean | null;

export interface ForgetRecordInput {
  sourceRef: string;
  pk: Record<string, ForgetPrimaryKeyValue>;
}

export interface ForgetRecordRequest {
  sourceRef: string;
  sourcePkJson: string;
  tombstoneId: string;
  contentHash: string;
}

export interface GenerateForgetSqlOptions {
  spec: ResolvedResolutionSpec;
  dialect: SupportedDialect;
  targetSchema: string;
  requests: ForgetRecordRequest[];
  reason?: string;
  replay?: boolean;
  actor?: string;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (value != null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashHex(algorithm: 'md5' | 'sha256', value: string): string {
  return createHash(algorithm).update(value).digest('hex');
}

function canonicalSourcePkJson(input: ResolvedInput, pk: Record<string, unknown>): string {
  const idFields = input.idFields ?? [];
  if (idFields.length === 0) {
    throw new Error(`Resolution input ${input.ref} must define at least one id_field.`);
  }
  const entries = idFields.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(pk, field)) {
      throw new Error(`Forget request for ${input.ref} is missing primary-key field "${field}".`);
    }
    const raw = pk[field];
    if (raw !== null && typeof raw === 'object') {
      throw new Error(
        `Forget request for ${input.ref} has a non-scalar primary-key field "${field}"; primary keys must be a string, number, boolean, or null.`
      );
    }
    const value = raw === null ? 'null' : JSON.stringify(String(raw));
    return `${JSON.stringify(field)}:${value}`;
  });
  return `{${entries.join(',')}}`;
}

export function buildForgetRecordRequest(
  spec: ResolvedResolutionSpec,
  input: ForgetRecordInput,
  reason?: string
): ForgetRecordRequest {
  const specInput = spec.inputs.find((candidate) => candidate.ref === input.sourceRef);
  if (!specInput) {
    const refs = spec.inputs.map((candidate) => candidate.ref).join(', ');
    throw new Error(
      `Unknown source_ref "${input.sourceRef}" for ${spec.name}. Expected one of: ${refs}`
    );
  }
  const sourcePkJson = canonicalSourcePkJson(specInput, input.pk);
  const tombstoneId = hashHex('md5', `${input.sourceRef}|${sourcePkJson}`);
  const contentHash = hashHex(
    'sha256',
    stableStringify({
      entity: spec.entity,
      source_ref: input.sourceRef,
      source_pk_json: sourcePkJson,
      reason: reason ?? null,
    })
  );
  return {
    sourceRef: input.sourceRef,
    sourcePkJson,
    tombstoneId,
    contentHash,
  };
}

function tableName(
  entity: string,
  suffix: string,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  return buildFqName(targetSchema, outputTableName(entity, suffix), dialect);
}

function auditLogName(dialect: SupportedDialect): string {
  return buildFqName('entity_graph', 'audit_log', dialect);
}

function incomingRequestsCte(requests: ForgetRecordRequest[], dialect: SupportedDialect): string {
  const columns = ['tombstone_id', 'source_ref', 'source_pk_json', 'content_hash'] as const;
  const selects = requests.map((request) =>
    [
      `SELECT`,
      `  ${quoteLiteral(request.tombstoneId, dialect)} AS ${quoteIdentifier('tombstone_id', dialect)},`,
      `  ${quoteLiteral(request.sourceRef, dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
      `  ${quoteLiteral(request.sourcePkJson, dialect)} AS ${quoteIdentifier('source_pk_json', dialect)},`,
      `  ${quoteLiteral(request.contentHash, dialect)} AS ${quoteIdentifier('content_hash', dialect)}`,
    ].join('\n')
  );
  if (selects.length === 0) {
    const nulls = columns.map((column) => `NULL AS ${quoteIdentifier(column, dialect)}`).join(', ');
    return `incoming_requests AS (SELECT ${nulls} WHERE 1 = 0)`;
  }
  return [`incoming_requests AS (`, selects.join('\nUNION ALL\n'), `)`].join('\n');
}

function tombstonePredicate(
  requests: ForgetRecordRequest[],
  replay: boolean | undefined,
  dialect: SupportedDialect,
  alias = 'forgotten'
): string[] {
  if (replay || requests.length === 0) return [];
  const quotedAlias = quoteIdentifier(alias, dialect);
  const tombstoneId = quoteIdentifier('tombstone_id', dialect);
  const ids = requests.map((request) => quoteLiteral(request.tombstoneId, dialect)).join(', ');
  return [`WHERE ${quotedAlias}.${tombstoneId} IN (${ids})`];
}

function targetRecordsCte(options: GenerateForgetSqlOptions): string {
  const { spec, dialect, targetSchema, requests, replay } = options;
  const forgottenTable = tableName(spec.entity, '__forgotten_records', dialect, targetSchema);
  const forgotten = quoteIdentifier('forgotten', dialect);
  return [
    `target_records AS (`,
    `  SELECT`,
    `    ${forgotten}.${quoteIdentifier('tombstone_id', dialect)} AS ${quoteIdentifier('tombstone_id', dialect)},`,
    `    ${forgotten}.${quoteIdentifier('source_ref', dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
    `    ${forgotten}.${quoteIdentifier('source_pk_json', dialect)} AS ${quoteIdentifier('source_pk_json', dialect)},`,
    `    ${forgotten}.${quoteIdentifier('content_hash', dialect)} AS ${quoteIdentifier('content_hash', dialect)},`,
    `    ${forgotten}.${quoteIdentifier('tombstone_id', dialect)} AS ${quoteIdentifier('record_id', dialect)}`,
    `  FROM ${forgottenTable} AS ${forgotten}`,
    ...tombstonePredicate(requests, replay, dialect),
    `)`,
  ].join('\n');
}

function affectedPairsCte(entity: string, dialect: SupportedDialect, targetSchema: string): string {
  const pairScores = tableName(entity, '__pair_scores', dialect, targetSchema);
  const candidatePairs = tableName(entity, '__candidate_pairs', dialect, targetSchema);
  const reviewQueue = tableName(entity, '__review_queue', dialect, targetSchema);
  const pairId = quoteIdentifier('pair_id', dialect);
  const recordA = quoteIdentifier('record_a_id', dialect);
  const recordB = quoteIdentifier('record_b_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  // IN-subquery semi-joins, not `JOIN ... ON a = tr.x OR b = tr.x` — an OR across
  // two equalities is not an equi-join and degenerates to a nested-loop scan of
  // the pair tables (the largest surfaces in the system) on every dialect.
  const targetIds = `SELECT ${recordId} FROM target_records`;
  const union = `  ${unionDistinct(dialect)}`;
  return [
    `affected_pairs AS (`,
    `  SELECT ps.${pairId} AS ${pairId}`,
    `  FROM ${pairScores} ps`,
    `  WHERE ps.${recordA} IN (${targetIds}) OR ps.${recordB} IN (${targetIds})`,
    union,
    `  SELECT ${pairIdExpr(`cp.${recordA}`, `cp.${recordB}`, dialect)} AS ${pairId}`,
    `  FROM ${candidatePairs} cp`,
    `  WHERE cp.${recordA} IN (${targetIds}) OR cp.${recordB} IN (${targetIds})`,
    union,
    `  SELECT rq.${pairId} AS ${pairId}`,
    `  FROM ${reviewQueue} rq`,
    `  WHERE rq.${recordA} IN (${targetIds}) OR rq.${recordB} IN (${targetIds})`,
    `)`,
  ].join('\n');
}

function affectedCrosswalksCte(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const crosswalks = tableName(entity, '__crosswalks', dialect, targetSchema);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  return [
    `affected_crosswalks AS (`,
    `  SELECT cw.*`,
    `  FROM ${crosswalks} cw`,
    `  JOIN target_records tr`,
    `    ON cw.${sourceRef} = tr.${sourceRef}`,
    `   AND cw.${sourcePkJson} = tr.${sourcePkJson}`,
    `)`,
  ].join('\n');
}

/**
 * Plain (non-CTE) subquery yielding the tombstone ids targeted by this forget
 * run. Tombstone ids equal pipeline record ids (both are md5(source_ref|pk_json)).
 *
 * DML statements must never lead with a WITH clause — BigQuery and Snowflake
 * reject `WITH ... DELETE/UPDATE`; the CTE chain has to live inside the query
 * expression (see the same constraint documented in review-apply.ts).
 */
function forgottenRecordIdSubquery(options: GenerateForgetSqlOptions): string {
  const { spec, dialect, targetSchema, requests, replay } = options;
  const forgottenTable = tableName(spec.entity, '__forgotten_records', dialect, targetSchema);
  const forgotten = quoteIdentifier('forgotten', dialect);
  return [
    `SELECT ${forgotten}.${quoteIdentifier('tombstone_id', dialect)}`,
    `  FROM ${forgottenTable} AS ${forgotten}`,
    ...tombstonePredicate(requests, replay, dialect).map((clause) => `  ${clause}`),
  ].join('\n');
}

function deleteByRecordIdSql(
  options: GenerateForgetSqlOptions,
  suffix: string,
  columns: readonly string[]
): SqlStatement {
  const { spec, dialect, targetSchema } = options;
  const target = tableName(spec.entity, suffix, dialect, targetSchema);
  const targetIds = forgottenRecordIdSubquery(options);
  const predicates = columns
    .map((column) => `${quoteIdentifier(column, dialect)} IN (\n${targetIds}\n)`)
    .join(' OR ');
  return {
    name: `forget_purge_${suffix.replace(/^__/, '')}`,
    sql: [`DELETE FROM ${target}`, `WHERE ${predicates}`].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function deleteBySourceSql(options: GenerateForgetSqlOptions, suffix: string): SqlStatement {
  const { spec, dialect, targetSchema, requests, replay } = options;
  const target = tableName(spec.entity, suffix, dialect, targetSchema);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const forgottenTable = tableName(spec.entity, '__forgotten_records', dialect, targetSchema);
  const forgotten = quoteIdentifier('forgotten', dialect);
  // Composite source key matched via a single concatenated expression: row-value
  // `(a, b) IN (SELECT ...)` is not supported on BigQuery, and DML must not lead
  // with a WITH clause (BigQuery/Snowflake reject it).
  const compositeKey = (refExpr: string, pkExpr: string) =>
    concatSql([refExpr, quoteLiteral('|', dialect), pkExpr], dialect);
  return {
    name: `forget_purge_${suffix.replace(/^__/, '')}`,
    sql: [
      `DELETE FROM ${target}`,
      `WHERE ${compositeKey(sourceRef, sourcePkJson)} IN (`,
      `SELECT ${compositeKey(`${forgotten}.${sourceRef}`, `${forgotten}.${sourcePkJson}`)}`,
      `  FROM ${forgottenTable} AS ${forgotten}`,
      ...tombstonePredicate(requests, replay, dialect).map((clause) => `  ${clause}`),
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function sha256Expr(value: string, dialect: SupportedDialect): string {
  if (dialect === 'redshift') {
    return emitSha256Expr(value, dialect);
  }
  const stringValue = castToString(value, dialect);
  switch (dialect) {
    case 'bigquery':
      return `TO_HEX(SHA256(${stringValue}))`;
    case 'postgres':
    case 'pgvector':
      return `ENCODE(DIGEST(${stringValue}, 'sha256'), 'hex')`;
    case 'duckdb':
      return `sha256(${stringValue})`;
    case 'snowflake':
    case 'databricks':
    case 'mysql':
      return `SHA2(${stringValue}, 256)`;
    // ClickHouse SHA256() returns raw FixedString(32) bytes, so hex-encode it
    // to match the lowercase hex digest every other branch produces.
    case 'clickhouse':
      return `lower(hex(SHA256(${stringValue})))`;
  }
}

function redactedColumn(column: string, dialect: SupportedDialect): string {
  const quoted = quoteIdentifier(column, dialect);
  return `CASE WHEN ${quoted} IS NULL THEN NULL ELSE ${sha256Expr(quoted, dialect)} END`;
}

function jsonTextToNative(expr: string, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'snowflake':
      return `PARSE_JSON(${expr})`;
    case 'postgres':
    case 'pgvector':
      return `${expr}::jsonb`;
    case 'redshift':
      return `json_parse(${expr})`;
    case 'duckdb':
      return `json(${expr})`;
    case 'mysql':
      return `CAST(${expr} AS JSON)`;
    case 'bigquery':
      return `PARSE_JSON(${expr})`;
    case 'databricks':
    // Like Databricks: the payload stays a JSON string rather than a native
    // JSON value.
    case 'clickhouse':
      return expr;
  }
}

function staticJsonPayloadExpr(payload: AuditPayload, dialect: SupportedDialect): string {
  return jsonTextToNative(quoteLiteral(JSON.stringify(payload), dialect), dialect);
}

function replayPayloadExpr(dialect: SupportedDialect): string {
  const tablesJson = JSON.stringify(PURGED_SURFACES);
  const prefix = quoteLiteral(`{"kind":"erasure","tombstone_id":"`, dialect);
  const middle = quoteLiteral(`","tables":${tablesJson},"row_counts":{"replayed":1}}`, dialect);
  return jsonTextToNative(
    concatSql([prefix, `f.${quoteIdentifier('tombstone_id', dialect)}`, middle], dialect),
    dialect
  );
}

function generateTombstoneUpsertSql(options: GenerateForgetSqlOptions): SqlStatement | null {
  const { spec, dialect, targetSchema, requests, reason } = options;
  if (requests.length === 0) return null;
  const forgottenTable = tableName(spec.entity, '__forgotten_records', dialect, targetSchema);
  const tombstoneId = quoteIdentifier('tombstone_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const requestedAt = quoteIdentifier('requested_at', dialect);
  const reasonColumn = quoteIdentifier('reason', dialect);
  const contentHash = quoteIdentifier('content_hash', dialect);
  return {
    name: 'forget_tombstone_upsert',
    sql: [
      `INSERT INTO ${forgottenTable} (${tombstoneId}, ${sourceRef}, ${sourcePkJson}, ${requestedAt}, ${reasonColumn}, ${contentHash})`,
      `WITH`,
      incomingRequestsCte(requests, dialect),
      `SELECT`,
      `  incoming.${tombstoneId},`,
      `  incoming.${sourceRef},`,
      `  incoming.${sourcePkJson},`,
      `  CURRENT_TIMESTAMP,`,
      `  ${reason != null ? quoteLiteral(reason, dialect) : 'NULL'},`,
      `  incoming.${contentHash}`,
      `FROM incoming_requests incoming`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1`,
      `  FROM ${forgottenTable} existing`,
      `  WHERE existing.${tombstoneId} = incoming.${tombstoneId}`,
      `)`,
    ].join('\n'),
  };
}

function generateEntityIdEventSql(
  options: GenerateForgetSqlOptions,
  eventType: 'retire' | 'split'
): SqlStatement {
  const { spec, dialect, targetSchema } = options;
  const eventsTable = tableName(spec.entity, '__entity_id_events', dialect, targetSchema);
  const columns = [
    'event_id',
    'event_type',
    'entity_id',
    'previous_entity_id',
    'record_id',
    'component_id',
    'source_ref',
    'source_pk_json',
    'source_system',
    'source_entity_id',
    'reason',
    'created_at',
  ].map((column) => quoteIdentifier(column, dialect));
  const rawEventId = md5Expr(
    concatSql(
      [
        quoteLiteral(eventType, dialect),
        quoteLiteral('|', dialect),
        `cw.${quoteIdentifier('entity_id', dialect)}`,
        quoteLiteral('|', dialect),
        `COALESCE(cw.${quoteIdentifier('record_id', dialect)}, ${quoteLiteral('', dialect)})`,
        quoteLiteral('|', dialect),
        `tr.${quoteIdentifier('content_hash', dialect)}`,
      ],
      dialect
    ),
    dialect
  );
  return {
    name: `forget_entity_id_${eventType}_events`,
    sql: [
      `INSERT INTO ${eventsTable} (`,
      columns.map((column) => `  ${column}`).join(',\n'),
      `)`,
      `WITH`,
      targetRecordsCte(options),
      `,`,
      affectedCrosswalksCte(spec.entity, dialect, targetSchema),
      `, event_candidates AS (`,
      `  SELECT`,
      `    ${rawEventId} AS ${quoteIdentifier('event_id', dialect)},`,
      `    ${quoteLiteral(eventType, dialect)} AS ${quoteIdentifier('event_type', dialect)},`,
      `    cw.${quoteIdentifier('entity_id', dialect)} AS ${quoteIdentifier('entity_id', dialect)},`,
      `    ${eventType === 'split' ? `cw.${quoteIdentifier('entity_id', dialect)}` : 'NULL'} AS ${quoteIdentifier('previous_entity_id', dialect)},`,
      `    cw.${quoteIdentifier('record_id', dialect)} AS ${quoteIdentifier('record_id', dialect)},`,
      `    cw.${quoteIdentifier('component_id', dialect)} AS ${quoteIdentifier('component_id', dialect)},`,
      `    cw.${quoteIdentifier('source_ref', dialect)} AS ${quoteIdentifier('source_ref', dialect)},`,
      `    cw.${quoteIdentifier('source_pk_json', dialect)} AS ${quoteIdentifier('source_pk_json', dialect)},`,
      `    cw.${quoteIdentifier('source_system', dialect)} AS ${quoteIdentifier('source_system', dialect)},`,
      `    cw.${quoteIdentifier('source_entity_id', dialect)} AS ${quoteIdentifier('source_entity_id', dialect)},`,
      `    ${quoteLiteral('erasure', dialect)} AS ${quoteIdentifier('reason', dialect)}`,
      `  FROM affected_crosswalks cw`,
      `  JOIN target_records tr`,
      `    ON cw.${quoteIdentifier('source_ref', dialect)} = tr.${quoteIdentifier('source_ref', dialect)}`,
      `   AND cw.${quoteIdentifier('source_pk_json', dialect)} = tr.${quoteIdentifier('source_pk_json', dialect)}`,
      `)`,
      `SELECT`,
      `  candidate.${quoteIdentifier('event_id', dialect)},`,
      `  candidate.${quoteIdentifier('event_type', dialect)},`,
      `  candidate.${quoteIdentifier('entity_id', dialect)},`,
      `  candidate.${quoteIdentifier('previous_entity_id', dialect)},`,
      `  candidate.${quoteIdentifier('record_id', dialect)},`,
      `  candidate.${quoteIdentifier('component_id', dialect)},`,
      `  candidate.${quoteIdentifier('source_ref', dialect)},`,
      `  candidate.${quoteIdentifier('source_pk_json', dialect)},`,
      `  candidate.${quoteIdentifier('source_system', dialect)},`,
      `  candidate.${quoteIdentifier('source_entity_id', dialect)},`,
      `  candidate.${quoteIdentifier('reason', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      `FROM event_candidates candidate`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${eventsTable} existing`,
      `  WHERE existing.${quoteIdentifier('event_id', dialect)} = candidate.${quoteIdentifier('event_id', dialect)}`,
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function generateReviewDecisionRedactionSql(options: GenerateForgetSqlOptions): SqlStatement {
  const { spec, dialect, targetSchema } = options;
  const decisions = tableName(spec.entity, '__review_decisions', dialect, targetSchema);
  const pairId = quoteIdentifier('pair_id', dialect);
  return {
    name: 'forget_redact_review_decisions',
    sql: [
      `UPDATE ${decisions}`,
      `SET`,
      `  ${quoteIdentifier('reason', dialect)} = ${redactedColumn('reason', dialect)},`,
      `  ${quoteIdentifier('human_feedback_reason', dialect)} = ${redactedColumn('human_feedback_reason', dialect)}`,
      `WHERE ${pairId} IN (`,
      `WITH`,
      targetRecordsCte(options),
      `,`,
      affectedPairsCte(spec.entity, dialect, targetSchema),
      `SELECT ${pairId} FROM affected_pairs`,
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function generatePairSemanticPurgeSql(options: GenerateForgetSqlOptions): SqlStatement {
  const { spec, dialect, targetSchema } = options;
  const semanticScores = tableName(spec.entity, '__pair_semantic_scores', dialect, targetSchema);
  const pairId = quoteIdentifier('pair_id', dialect);
  return {
    name: 'forget_purge_pair_semantic_scores',
    sql: [
      `DELETE FROM ${semanticScores}`,
      `WHERE ${pairId} IN (`,
      `WITH`,
      targetRecordsCte(options),
      `,`,
      affectedPairsCte(spec.entity, dialect, targetSchema),
      `SELECT ${pairId} FROM affected_pairs`,
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function deleteByAffectedEntityIdSql(
  options: GenerateForgetSqlOptions,
  suffix: string,
  column: string
): SqlStatement {
  const { spec, dialect, targetSchema } = options;
  const target = tableName(spec.entity, suffix, dialect, targetSchema);
  const targetColumn = quoteIdentifier(column, dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  return {
    name: `forget_purge_${suffix.replace(/^__/, '')}`,
    sql: [
      `DELETE FROM ${target}`,
      `WHERE ${targetColumn} IN (`,
      `WITH`,
      targetRecordsCte(options),
      `,`,
      affectedCrosswalksCte(spec.entity, dialect, targetSchema),
      `SELECT ${entityId} FROM affected_crosswalks`,
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function generateEmbeddingCachePurgeSql(options: GenerateForgetSqlOptions): SqlStatement[] {
  const { spec, dialect, targetSchema } = options;
  const triage = spec.semanticTriage;
  if (!triage) return [];
  const cache = tableName(spec.entity, '__embedding_cache', dialect, targetSchema);
  const standardized = tableName(spec.entity, '__standardized', dialect, targetSchema);
  const contentHash = quoteIdentifier('content_hash', dialect);
  const selects = triage.fields.map((field) => {
    const value = `std.${quoteIdentifier(`standardized_${field}`, dialect)}`;
    return [
      `  SELECT ${semanticContentHashExpr(value, triage, dialect)} AS ${contentHash}`,
      `  FROM ${standardized} std`,
      `  JOIN target_records tr ON std.${quoteIdentifier('record_id', dialect)} = tr.${quoteIdentifier('record_id', dialect)}`,
      `  WHERE ${value} IS NOT NULL`,
    ].join('\n');
  });
  return [
    {
      name: 'forget_purge_embedding_cache',
      sql: [
        `DELETE FROM ${cache}`,
        `WHERE ${contentHash} IN (`,
        `WITH`,
        targetRecordsCte(options),
        `, affected_embeddings AS (`,
        selects.join(`\n${unionDistinct(dialect)}\n`),
        `)`,
        `SELECT ${contentHash} FROM affected_embeddings`,
        `)`,
      ].join('\n'),
      ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
    },
  ];
}

function generateAuditPayloadRedactionSql(options: GenerateForgetSqlOptions): SqlStatement {
  const { spec, dialect, requests } = options;
  const auditLog = auditLogName(dialect);
  const batchId =
    requests.length === 1
      ? requests[0]!.tombstoneId
      : `batch_${hashHex('sha256', stableStringify(requests)).slice(0, 24)}`;
  const payload = staticJsonPayloadExpr(
    {
      kind: 'erasure',
      tombstone_id: batchId,
      tables: ['audit_log'],
      row_counts: { redacted: 1 },
    },
    dialect
  );
  const subjectId = quoteIdentifier('subject_id', dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  return {
    name: 'forget_redact_audit_payloads',
    sql: [
      `UPDATE ${auditLog}`,
      `SET`,
      `  ${quoteIdentifier('payload', dialect)} = ${payload},`,
      `  ${quoteIdentifier('reason', dialect)} = ${quoteLiteral('erasure_redacted', dialect)}`,
      `WHERE ${subjectId} IN (`,
      `WITH`,
      targetRecordsCte(options),
      `,`,
      affectedCrosswalksCte(spec.entity, dialect, options.targetSchema),
      `,`,
      affectedPairsCte(spec.entity, dialect, options.targetSchema),
      `, affected_subjects AS (`,
      `  SELECT ${quoteIdentifier('record_id', dialect)} AS ${subjectId} FROM target_records`,
      `  ${unionDistinct(dialect)} SELECT ${entityId} AS ${subjectId} FROM affected_crosswalks`,
      `  ${unionDistinct(dialect)} SELECT ${pairId} AS ${subjectId} FROM affected_pairs`,
      `)`,
      `SELECT ${subjectId} FROM affected_subjects`,
      `)`,
    ].join('\n'),
    ignoreErrorPatterns: [...MISSING_FORGET_SURFACE_ERROR_PATTERNS],
  };
}

function generateReplayAuditSql(options: GenerateForgetSqlOptions): SqlStatement | null {
  const { dialect, replay } = options;
  if (!replay) return null;
  const auditLog = auditLogName(dialect);
  const forgotten = tableName(
    options.spec.entity,
    '__forgotten_records',
    dialect,
    options.targetSchema
  );
  const eventId = concatSql(
    [
      quoteLiteral('eg-', dialect),
      castToString('CURRENT_TIMESTAMP', dialect),
      quoteLiteral('-erasure-', dialect),
      `f.${quoteIdentifier('tombstone_id', dialect)}`,
      quoteLiteral('-', dialect),
      `f.${quoteIdentifier('content_hash', dialect)}`,
    ],
    dialect
  );
  return {
    name: 'audit_erasure_replay',
    sql: [
      `INSERT INTO ${auditLog} (`,
      `  ${quoteIdentifier('event_id', dialect)}, ${quoteIdentifier('category', dialect)}, ${quoteIdentifier('subject_type', dialect)}, ${quoteIdentifier('subject_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)}, ${quoteIdentifier('edge_id', dialect)}, ${quoteIdentifier('payload', dialect)}, ${quoteIdentifier('reason', dialect)},`,
      `  ${quoteIdentifier('actor', dialect)}, ${quoteIdentifier('actor_type', dialect)}, ${quoteIdentifier('occurred_at', dialect)}`,
      `)`,
      `SELECT`,
      `  ${eventId},`,
      `  ${quoteLiteral('mutation', dialect)},`,
      `  ${quoteLiteral('forgotten_record', dialect)},`,
      `  f.${quoteIdentifier('tombstone_id', dialect)},`,
      `  NULL,`,
      `  NULL,`,
      `  ${replayPayloadExpr(dialect)},`,
      `  ${quoteLiteral(options.reason ?? 'erasure replay', dialect)},`,
      `  ${quoteLiteral(options.actor ?? 'system', dialect)},`,
      `  ${quoteLiteral('system', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      `FROM ${forgotten} f`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${auditLog} existing`,
      `  WHERE existing.${quoteIdentifier('event_id', dialect)} = ${eventId}`,
      `)`,
    ].join('\n'),
  };
}

function erasureAuditPayload(request: ForgetRecordRequest): AuditPayload {
  return {
    kind: 'erasure',
    tombstone_id: request.tombstoneId,
    tables: [...PURGED_SURFACES],
    row_counts: { requested_records: 1 },
  };
}

export function generateForgetSql(options: GenerateForgetSqlOptions): SqlStatement[] {
  if (!options.replay && options.requests.length === 0) {
    throw new Error('At least one forget request is required unless replay is enabled.');
  }

  const statements: SqlStatement[] = [];
  const tombstoneUpsert = generateTombstoneUpsertSql(options);
  if (tombstoneUpsert) statements.push(tombstoneUpsert);

  statements.push(
    generateEntityIdEventSql(options, 'retire'),
    generateEntityIdEventSql(options, 'split'),
    // Redactions must run BEFORE the purges: both derive their affected-pair /
    // affected-entity sets from __pair_scores/__candidate_pairs/__review_queue/
    // __crosswalks, which the purge statements empty. Running them afterwards
    // silently redacts nothing for pair- and entity-scoped subjects.
    generateReviewDecisionRedactionSql(options),
    generateAuditPayloadRedactionSql(options),
    generatePairSemanticPurgeSql(options),
    deleteByAffectedEntityIdSql(options, '__document_mentions', 'resolved_entity_id'),
    deleteByAffectedEntityIdSql(options, '__survivorship_audit', 'entity_id'),
    ...generateEmbeddingCachePurgeSql(options),
    deleteByRecordIdSql(options, '__review_queue', ['record_a_id', 'record_b_id']),
    deleteByRecordIdSql(options, '__pair_scores', ['record_a_id', 'record_b_id']),
    deleteByRecordIdSql(options, '__candidate_pairs', ['record_a_id', 'record_b_id']),
    deleteByRecordIdSql(options, '__match_inbox', ['record_id']),
    deleteBySourceSql(options, '__crosswalks'),
    deleteByRecordIdSql(options, '__standardized', ['record_id'])
  );

  for (const request of options.requests) {
    statements.push(
      generateAuditInsertSql({
        name: `audit_erasure_${request.tombstoneId.slice(0, 12)}`,
        dialect: options.dialect,
        category: 'mutation',
        subjectType: 'forgotten_record',
        subjectId: request.tombstoneId,
        payload: erasureAuditPayload(request),
        reason: options.reason,
        actor: options.actor ?? 'system',
        actorType: 'system',
        eventIdDiscriminator: request.contentHash,
      })
    );
  }
  const replayAudit = generateReplayAuditSql(options);
  if (replayAudit) statements.push(replayAudit);
  return statements;
}
