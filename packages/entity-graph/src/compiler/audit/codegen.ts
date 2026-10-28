import { createHash } from 'node:crypto';

import {
  buildFqName,
  getCanonicalDialect,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { AuditActorType, AuditCategory, AuditPayload } from '@bobsled-inc/protocol';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlStatement } from '../identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../survivorship/types.js';
import { getOutputTableDef } from '../output-tables/index.js';
import {
  buildJsonObjectExpr,
  castToString,
  concatSql,
  jsonExtractString,
} from '../identity/sql.js';

export const ENTITY_GRAPH_SCHEMA = 'entity_graph';
export const AUDIT_LOG_TABLE = 'audit_log';

interface AuditInsertInput {
  name: string;
  dialect: SupportedDialect;
  contractSchema?: string;
  category: AuditCategory;
  subjectType: string;
  subjectId: string;
  payload: AuditPayload;
  reason?: string;
  actor?: string;
  actorType?: AuditActorType;
  clusterId?: string;
  edgeId?: string;
  /** Optional disambiguator appended to event_id so two events with the same kind+subject in the same timestamp tick do not collide. */
  eventIdDiscriminator?: string;
}

interface ReviewApplyAuditInput {
  entityName: string;
  targetSchema: string;
  dialect: SupportedDialect;
  contractSchema?: string;
  decisionBatchId: string;
  contentHash: string;
  decisionCount: number;
  mergeCount: number;
  notMatchCount: number;
  deferredCount: number;
  escalatedCount: number;
  decisionSource: string;
  // Decision-trace ("why") fields, persisted into the warehouse audit_log
  // payload (and `reason`). All optional — absent on legacy/CLI applies that
  // do not carry context-graph trace metadata.
  policyVersion?: string;
  configSnapshot?: Record<string, unknown>;
  langsmithTraceId?: string;
  precedentRefs?: string[];
  learningContext?: string;
}

interface SemanticTriageSkippedAuditInput {
  entityName: string;
  dialect: SupportedDialect;
  contractSchema?: string;
  estimatedEmbeddingCostUsd?: number;
  maxEmbeddingCostUsd?: number;
  candidateCount?: number;
  reason: string;
}

const AUDIT_STRING_TYPES: Record<string, string> = {
  redshift: 'VARCHAR(4096)',
  bigquery: 'STRING',
  databricks: 'STRING',
  mysql: 'VARCHAR(4096)',
  snowflake: 'VARCHAR',
  postgres: 'VARCHAR(4096)',
  clickhouse: 'String',
};

const AUDIT_JSON_TYPES: Record<string, string> = {
  redshift: 'SUPER',
  snowflake: 'VARIANT',
  postgres: 'JSONB',
  databricks: 'STRING',
  // ClickHouse keeps audit payloads as escaped JSON strings (see jsonValueExpr).
  clickhouse: 'String',
};

function mapAuditColumnType(type: string, dialect: SupportedDialect): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  switch (type) {
    case 'STRING':
      return (
        (dialect === 'redshift'
          ? AUDIT_STRING_TYPES.redshift
          : AUDIT_STRING_TYPES[canonicalDialect]) ?? 'VARCHAR'
      );
    case 'TIMESTAMP':
      return canonicalDialect === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
    case 'JSON':
      return (
        (dialect === 'redshift' ? AUDIT_JSON_TYPES.redshift : AUDIT_JSON_TYPES[canonicalDialect]) ??
        'JSON'
      );
    default:
      return type;
  }
}

function auditLogName(dialect: SupportedDialect, contractSchema = ENTITY_GRAPH_SCHEMA): string {
  return buildFqName(contractSchema, AUDIT_LOG_TABLE, dialect);
}

function createSchemaSql(schema: string, dialect: SupportedDialect): string {
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, dialect)}`;
}

function eventIdExpr(parts: string[], dialect: SupportedDialect): string {
  return concatSql(
    [
      quoteLiteral('eg-', dialect),
      castToString('CURRENT_TIMESTAMP', dialect),
      quoteLiteral('-', dialect),
      ...parts,
    ],
    dialect
  );
}

function singletonSelectFrom(dialect: SupportedDialect): string {
  const sourceAlias = quoteIdentifier('audit_source', dialect);
  if (dialect === 'databricks') {
    return `FROM VALUES (1) AS ${sourceAlias}(${quoteIdentifier('dummy', dialect)})`;
  }
  return `FROM (SELECT 1) AS ${sourceAlias}`;
}

// Emit a dialect-native JSON value from a host-serialized literal. This is the
// only sound way to embed a NESTED object/array (e.g. config_snapshot,
// precedent_refs) into a JSON payload across all dialects — `buildJsonObjectExpr`
// accepts scalar SQL expressions only. (Databricks has no native JSON type, so
// the value rides as an escaped JSON string — acceptable for an audit payload.)
function jsonValueExpr(value: unknown, dialect: SupportedDialect): string {
  const literal = quoteLiteral(JSON.stringify(value), dialect);
  switch (dialect) {
    case 'snowflake':
      return `PARSE_JSON(${literal})`;
    case 'postgres':
    case 'pgvector':
      return `${literal}::jsonb`;
    case 'redshift':
      return `json_parse(${literal})`;
    case 'duckdb':
      return `json(${literal})`;
    case 'mysql':
      return `CAST(${literal} AS JSON)`;
    case 'bigquery':
      return `JSON ${literal}`;
    case 'databricks':
    // Like Databricks: no native JSON type is in play, so the value rides as
    // an escaped JSON string.
    case 'clickhouse':
      return literal;
  }
}

function jsonLiteralExpr(payload: AuditPayload, dialect: SupportedDialect): string {
  return jsonValueExpr(payload, dialect);
}

function reviewApplyPayloadExpr(input: ReviewApplyAuditInput): string {
  const dialect = input.dialect;
  const decisionsTable = buildFqName(
    input.targetSchema,
    `${input.entityName}__review_decisions`,
    dialect
  );
  const decisionBatchId = quoteIdentifier('decision_batch_id', dialect);
  const contentHash = quoteIdentifier('content_hash', dialect);
  const skippedExpr = [
    `CASE WHEN EXISTS (`,
    `  SELECT 1`,
    `  FROM ${decisionsTable}`,
    `  WHERE ${decisionBatchId} = ${quoteLiteral(input.decisionBatchId, dialect)}`,
    `    AND ${contentHash} = ${quoteLiteral(input.contentHash, dialect)}`,
    `) THEN TRUE ELSE FALSE END`,
  ].join('\n');

  const entries: Array<readonly [string, string]> = [
    ['kind', quoteLiteral('review_apply', dialect)],
    ['decision_batch_id', quoteLiteral(input.decisionBatchId, dialect)],
    ['content_hash', quoteLiteral(input.contentHash, dialect)],
    ['skipped', skippedExpr],
    ['decision_count', String(input.decisionCount)],
    ['merge_count', String(input.mergeCount)],
    ['not_match_count', String(input.notMatchCount)],
    ['deferred_count', String(input.deferredCount)],
    ['escalated_count', String(input.escalatedCount)],
  ];

  // Decision-trace ("why") fields — appended only when supplied. Scalars ride
  // as quoted literals; the nested config_snapshot object and precedent_refs
  // array ride as dialect-native JSON values (see jsonValueExpr).
  if (input.policyVersion != null) {
    entries.push(['policy_version', quoteLiteral(input.policyVersion, dialect)]);
  }
  if (input.langsmithTraceId != null) {
    entries.push(['langsmith_trace_id', quoteLiteral(input.langsmithTraceId, dialect)]);
  }
  if (input.configSnapshot != null) {
    entries.push(['config_snapshot', jsonValueExpr(input.configSnapshot, dialect)]);
  }
  if (input.precedentRefs != null && input.precedentRefs.length > 0) {
    entries.push(['precedent_refs', jsonValueExpr(input.precedentRefs, dialect)]);
  }

  return buildJsonObjectExpr(entries, dialect);
}

export function generateAuditLogDdl(
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): SqlStatement[] {
  const tableDef = getOutputTableDef(AUDIT_LOG_TABLE);
  const tableName = auditLogName(dialect, contractSchema);
  const columns = tableDef.columns
    .map(
      (column) =>
        `  ${quoteIdentifier(column.name, dialect)} ${mapAuditColumnType(column.type, dialect)}`
    )
    .join(',\n');

  return [
    {
      name: 'ddl_entity_graph_schema',
      sql: createSchemaSql(contractSchema, dialect),
    },
    {
      name: 'ddl_audit_log',
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (\n${columns}\n)`,
      tableCreated: `${contractSchema}.${AUDIT_LOG_TABLE}`,
    },
  ];
}

function payloadFingerprint(payload: AuditPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export function generateAuditInsertSql(input: AuditInsertInput): SqlStatement {
  const dialect = input.dialect;
  const tableName = auditLogName(dialect, input.contractSchema);
  const payloadExpr = jsonLiteralExpr(input.payload, dialect);
  const discriminator = input.eventIdDiscriminator ?? payloadFingerprint(input.payload);
  const eventId = eventIdExpr(
    [
      quoteLiteral(input.payload.kind, dialect),
      quoteLiteral('-', dialect),
      quoteLiteral(input.subjectId, dialect),
      quoteLiteral('-', dialect),
      quoteLiteral(discriminator, dialect),
    ],
    dialect
  );

  return {
    name: input.name,
    sql: [
      `INSERT INTO ${tableName} (`,
      `  ${quoteIdentifier('event_id', dialect)}, ${quoteIdentifier('category', dialect)}, ${quoteIdentifier('subject_type', dialect)}, ${quoteIdentifier('subject_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)}, ${quoteIdentifier('edge_id', dialect)}, ${quoteIdentifier('payload', dialect)}, ${quoteIdentifier('reason', dialect)},`,
      `  ${quoteIdentifier('actor', dialect)}, ${quoteIdentifier('actor_type', dialect)}, ${quoteIdentifier('occurred_at', dialect)}`,
      `)`,
      `SELECT`,
      `  ${eventId},`,
      `  ${quoteLiteral(input.category, dialect)},`,
      `  ${quoteLiteral(input.subjectType, dialect)},`,
      `  ${quoteLiteral(input.subjectId, dialect)},`,
      `  ${input.clusterId ? quoteLiteral(input.clusterId, dialect) : 'NULL'},`,
      `  ${input.edgeId ? quoteLiteral(input.edgeId, dialect) : 'NULL'},`,
      `  ${payloadExpr},`,
      `  ${input.reason ? quoteLiteral(input.reason, dialect) : 'NULL'},`,
      `  ${quoteLiteral(input.actor ?? 'system', dialect)},`,
      `  ${quoteLiteral(input.actorType ?? 'system', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      singletonSelectFrom(dialect),
    ].join('\n'),
  };
}

export function generateReviewApplyAuditSql(input: ReviewApplyAuditInput): SqlStatement {
  const dialect = input.dialect;
  const tableName = auditLogName(dialect, input.contractSchema);
  const payloadExpr = reviewApplyPayloadExpr(input);
  const eventId = eventIdExpr(
    [
      quoteLiteral('review_apply-', dialect),
      quoteLiteral(input.decisionBatchId, dialect),
      quoteLiteral('-', dialect),
      quoteLiteral(input.contentHash, dialect),
    ],
    dialect
  );

  return {
    name: 'audit_review_apply',
    sql: [
      `INSERT INTO ${tableName} (`,
      `  ${quoteIdentifier('event_id', dialect)}, ${quoteIdentifier('category', dialect)}, ${quoteIdentifier('subject_type', dialect)}, ${quoteIdentifier('subject_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)}, ${quoteIdentifier('edge_id', dialect)}, ${quoteIdentifier('payload', dialect)}, ${quoteIdentifier('reason', dialect)},`,
      `  ${quoteIdentifier('actor', dialect)}, ${quoteIdentifier('actor_type', dialect)}, ${quoteIdentifier('occurred_at', dialect)}`,
      `)`,
      `SELECT`,
      `  ${eventId},`,
      `  ${quoteLiteral('decision', dialect)},`,
      `  ${quoteLiteral('review_batch', dialect)},`,
      `  ${quoteLiteral(input.decisionBatchId, dialect)},`,
      `  NULL,`,
      `  NULL,`,
      `  ${payloadExpr},`,
      `  ${input.learningContext != null ? quoteLiteral(input.learningContext, dialect) : 'NULL'},`,
      `  ${quoteLiteral(input.decisionSource, dialect)},`,
      `  ${quoteLiteral(input.decisionSource === 'human' ? 'human' : 'agent', dialect)},`,
      `  CURRENT_TIMESTAMP`,
      singletonSelectFrom(dialect),
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${tableName} existing`,
      `  WHERE existing.${quoteIdentifier('event_id', dialect)} = ${eventId}`,
      `)`,
    ].join('\n'),
  };
}

export function generateSemanticTriageSkippedAuditSql(
  input: SemanticTriageSkippedAuditInput
): SqlStatement {
  return generateAuditInsertSql({
    name: 'audit_semantic_triage_skipped',
    dialect: input.dialect,
    contractSchema: input.contractSchema,
    category: 'mutation',
    subjectType: 'semantic_triage',
    subjectId: input.entityName,
    payload: {
      kind: 'semantic_triage_skipped',
      ...(input.estimatedEmbeddingCostUsd !== undefined
        ? { estimated_embedding_cost_usd: input.estimatedEmbeddingCostUsd }
        : {}),
      ...(input.maxEmbeddingCostUsd !== undefined
        ? { max_embedding_cost_usd: input.maxEmbeddingCostUsd }
        : {}),
      ...(input.candidateCount !== undefined ? { candidate_count: input.candidateCount } : {}),
      reason: input.reason,
    },
    reason: input.reason,
    actor: 'system',
    actorType: 'system',
    eventIdDiscriminator: input.reason,
  });
}

export function generateSurvivorshipAuditSql(
  spec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): SqlStatement {
  const tableName = auditLogName(dialect, contractSchema);
  const sourceTable = buildFqName(
    spec.targetSchema,
    `${spec.resolutionEntity}__survivorship_audit`,
    dialect
  );
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const attributeName = quoteIdentifier('attribute_name', dialect);
  const chosenValue = quoteIdentifier('chosen_value', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const strategy = quoteIdentifier('strategy', dialect);
  const decidedAt = quoteIdentifier('decided_at', dialect);
  const computedEventId = quoteIdentifier('computed_event_id', dialect);
  const eventIdExprForRow = eventIdExpr(
    [
      quoteLiteral('survivorship_choose-', dialect),
      castToString(`src.${clusterId}`, dialect),
      quoteLiteral('-', dialect),
      castToString(`src.${attributeName}`, dialect),
      quoteLiteral('-', dialect),
      castToString(`src.${decidedAt}`, dialect),
    ],
    dialect
  );
  const payload = buildJsonObjectExpr(
    [
      ['kind', quoteLiteral('survivorship_choose', dialect)],
      ['attribute_name', `src.${attributeName}`],
      ['chosen_value', `src.${chosenValue}`],
      ['source_system', `src.${sourceSystem}`],
      ['strategy', `src.${strategy}`],
    ],
    dialect
  );

  return {
    name: 'audit_survivorship_choose',
    sql: [
      `WITH src_with_event AS (`,
      `  SELECT src.*, ${eventIdExprForRow} AS ${computedEventId}`,
      `  FROM ${sourceTable} src`,
      `)`,
      `INSERT INTO ${tableName} (`,
      `  ${quoteIdentifier('event_id', dialect)}, ${quoteIdentifier('category', dialect)}, ${quoteIdentifier('subject_type', dialect)}, ${quoteIdentifier('subject_id', dialect)},`,
      `  ${quoteIdentifier('cluster_id', dialect)}, ${quoteIdentifier('edge_id', dialect)}, ${quoteIdentifier('payload', dialect)}, ${quoteIdentifier('reason', dialect)},`,
      `  ${quoteIdentifier('actor', dialect)}, ${quoteIdentifier('actor_type', dialect)}, ${quoteIdentifier('occurred_at', dialect)}`,
      `)`,
      `SELECT`,
      `  src.${computedEventId},`,
      `  ${quoteLiteral('mutation', dialect)},`,
      `  ${quoteLiteral('cluster', dialect)},`,
      `  src.${clusterId},`,
      `  src.${clusterId},`,
      `  NULL,`,
      `  ${payload},`,
      `  NULL,`,
      `  ${quoteLiteral('system', dialect)},`,
      `  ${quoteLiteral('system', dialect)},`,
      `  src.${decidedAt}`,
      `FROM src_with_event src`,
      `WHERE NOT EXISTS (`,
      `  SELECT 1 FROM ${tableName} existing`,
      `  WHERE existing.${quoteIdentifier('event_id', dialect)} = src.${computedEventId}`,
      `)`,
    ].join('\n'),
  };
}

export function buildAuditListQuery(
  dialect: SupportedDialect,
  options: {
    contractSchema?: string;
    clusterId?: string;
    subjectId?: string;
    category?: AuditCategory;
    subjectType?: string;
    payloadKind?: string;
    limit?: number;
  } = {}
): string {
  const tableName = auditLogName(dialect, options.contractSchema);
  const predicates = [
    options.clusterId
      ? `${quoteIdentifier('cluster_id', dialect)} = ${quoteLiteral(options.clusterId, dialect)}`
      : undefined,
    options.subjectId
      ? `${quoteIdentifier('subject_id', dialect)} = ${quoteLiteral(options.subjectId, dialect)}`
      : undefined,
    options.category
      ? `${quoteIdentifier('category', dialect)} = ${quoteLiteral(options.category, dialect)}`
      : undefined,
    options.subjectType
      ? `${quoteIdentifier('subject_type', dialect)} = ${quoteLiteral(options.subjectType, dialect)}`
      : undefined,
    options.payloadKind
      ? `${jsonExtractString(quoteIdentifier('payload', dialect), 'kind', dialect)} = ${quoteLiteral(options.payloadKind, dialect)}`
      : undefined,
  ].filter((predicate): predicate is string => predicate !== undefined);

  return [
    `SELECT *`,
    `FROM ${tableName}`,
    ...(predicates.length > 0 ? [`WHERE ${predicates.join(' AND ')}`] : []),
    `ORDER BY ${quoteIdentifier('occurred_at', dialect)}, ${quoteIdentifier('event_id', dialect)}`,
    ...(options.limit != null ? [`LIMIT ${options.limit}`] : []),
  ].join('\n');
}

export function buildAuditVerifyQuery(
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): string {
  const tableName = auditLogName(dialect, contractSchema);
  const eventId = quoteIdentifier('event_id', dialect);
  const occurredAt = quoteIdentifier('occurred_at', dialect);
  const blankEventIdExpr = `${eventId} IS NULL OR TRIM(${castToString(eventId, dialect)}) = ${quoteLiteral('', dialect)}`;
  return [
    `SELECT`,
    `  COUNT(*) AS ${quoteIdentifier('total_events', dialect)},`,
    `  COUNT(DISTINCT ${eventId}) AS ${quoteIdentifier('distinct_events', dialect)},`,
    `  SUM(CASE WHEN ${blankEventIdExpr} THEN 1 ELSE 0 END) AS ${quoteIdentifier('missing_event_ids', dialect)},`,
    `  SUM(CASE WHEN ${occurredAt} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdentifier('missing_occurred_at', dialect)},`,
    `  CASE`,
    `    WHEN COUNT(*) = COUNT(DISTINCT ${eventId})`,
    `     AND SUM(CASE WHEN ${blankEventIdExpr} THEN 1 ELSE 0 END) = 0`,
    `     AND SUM(CASE WHEN ${occurredAt} IS NULL THEN 1 ELSE 0 END) = 0`,
    `    THEN ${quoteLiteral('ok', dialect)}`,
    `    ELSE ${quoteLiteral('failed', dialect)}`,
    `  END AS ${quoteIdentifier('status', dialect)}`,
    `FROM ${tableName}`,
  ].join('\n');
}
