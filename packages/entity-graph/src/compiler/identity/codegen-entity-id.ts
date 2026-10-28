import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, SqlStatement } from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { castToString, concatSql, md5Expr, nullString, nullTimestamp } from './sql.js';

const MISSING_PRE_STABLE_CLUSTERS_ERROR_PATTERNS = [
  'does not exist',
  'not found',
  'unknown table',
  'no such table',
] as const;

function eventIdExpr(candidateAlias: string, dialect: SupportedDialect): string {
  return md5Expr(
    concatSql(
      [
        `${candidateAlias}.event_type`,
        quoteLiteral('|', dialect),
        `${candidateAlias}.entity_id`,
        quoteLiteral('|', dialect),
        `COALESCE(${candidateAlias}.previous_entity_id, ${quoteLiteral('', dialect)})`,
        quoteLiteral('|', dialect),
        `COALESCE(${candidateAlias}.record_id, ${quoteLiteral('', dialect)})`,
        quoteLiteral('|', dialect),
        `COALESCE(${candidateAlias}.component_id, ${quoteLiteral('', dialect)})`,
        quoteLiteral('|', dialect),
        `${candidateAlias}.reason`,
        quoteLiteral('|', dialect),
        `COALESCE(${castToString(`${candidateAlias}.prior_assigned_at`, dialect)}, ${quoteLiteral('', dialect)})`,
      ],
      dialect
    ),
    dialect
  );
}

function eventInsertColumns(dialect: SupportedDialect): string[] {
  return [
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
}

function eventCandidateSelect(dialect: SupportedDialect): string[] {
  return [
    `  candidate.${quoteIdentifier('event_id', dialect)},`,
    `  candidate.event_type AS ${quoteIdentifier('event_type', dialect)},`,
    `  candidate.entity_id AS ${quoteIdentifier('entity_id', dialect)},`,
    `  candidate.previous_entity_id AS ${quoteIdentifier('previous_entity_id', dialect)},`,
    `  candidate.record_id AS ${quoteIdentifier('record_id', dialect)},`,
    `  candidate.component_id AS ${quoteIdentifier('component_id', dialect)},`,
    `  candidate.source_ref AS ${quoteIdentifier('source_ref', dialect)},`,
    `  candidate.source_pk_json AS ${quoteIdentifier('source_pk_json', dialect)},`,
    `  candidate.source_system AS ${quoteIdentifier('source_system', dialect)},`,
    `  candidate.source_entity_id AS ${quoteIdentifier('source_entity_id', dialect)},`,
    `  candidate.reason AS ${quoteIdentifier('reason', dialect)},`,
    `  CURRENT_TIMESTAMP AS ${quoteIdentifier('created_at', dialect)}`,
  ];
}

export function generateEntityIdBackfillSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const eventsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_events'),
    dialect
  );
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);

  // The CTE clause must come after INSERT INTO — BigQuery rejects a
  // leading WITH on INSERT statements.
  const sql = [
    `INSERT INTO ${eventsTable} (`,
    eventInsertColumns(dialect)
      .map((column) => `  ${column}`)
      .join(',\n'),
    `)`,
    `WITH raw_candidates AS (`,
    `  SELECT`,
    `    ${quoteLiteral('backfill', dialect)} AS event_type,`,
    `    ${clusterId} AS entity_id,`,
    `    ${nullString(dialect)} AS previous_entity_id,`,
    `    ${recordId} AS record_id,`,
    `    ${clusterId} AS component_id,`,
    `    ${sourceRef} AS source_ref,`,
    `    ${nullString(dialect)} AS source_pk_json,`,
    `    ${sourceSystem} AS source_system,`,
    `    ${sourceEntityId} AS source_entity_id,`,
    `    ${quoteLiteral('existing_cluster_backfill', dialect)} AS reason,`,
    `    ${nullTimestamp(dialect)} AS prior_assigned_at`,
    `  FROM ${clustersTable}`,
    `  WHERE NOT EXISTS (SELECT 1 FROM ${eventsTable})`,
    `),`,
    `event_candidates AS (`,
    `  SELECT r.*, ${eventIdExpr('r', dialect)} AS ${quoteIdentifier('event_id', dialect)}`,
    `  FROM raw_candidates r`,
    `)`,
    `SELECT`,
    eventCandidateSelect(dialect).join('\n'),
    `FROM event_candidates candidate`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM ${eventsTable} existing`,
    `  WHERE existing.${quoteIdentifier('event_id', dialect)} = candidate.${quoteIdentifier('event_id', dialect)}`,
    `)`,
  ].join('\n');

  return {
    name: 'backfill_entity_id_events',
    sql,
    ignoreErrorPatterns: [...MISSING_PRE_STABLE_CLUSTERS_ERROR_PATTERNS],
  };
}

export function generateEntityIdAssignmentEventsSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const componentsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__components'),
    dialect
  );
  const eventsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_events'),
    dialect
  );
  const recordMapTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_record_map'),
    dialect
  );
  const aliasesTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_aliases'),
    dialect
  );

  const eventId = quoteIdentifier('event_id', dialect);
  const eventType = quoteIdentifier('event_type', dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const previousEntityId = quoteIdentifier('previous_entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const componentId = quoteIdentifier('component_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const clusteredAt = quoteIdentifier('clustered_at', dialect);
  const createdAt = quoteIdentifier('created_at', dialect);
  const assignedAt = quoteIdentifier('assigned_at', dialect);
  const aliasEntityId = quoteIdentifier('alias_entity_id', dialect);
  const supersededAt = quoteIdentifier('superseded_at', dialect);

  // The CTE clause must come after INSERT INTO — BigQuery rejects a
  // leading WITH on INSERT statements.
  const sql = [
    `INSERT INTO ${eventsTable} (`,
    eventInsertColumns(dialect)
      .map((column) => `  ${column}`)
      .join(',\n'),
    `)`,
    `WITH current_records AS (`,
    `  SELECT`,
    `    c.${componentId} AS component_id,`,
    `    c.${recordId} AS record_id,`,
    `    c.${sourceRef} AS source_ref,`,
    `    c.${sourcePkJson} AS source_pk_json,`,
    `    c.${sourceSystem} AS source_system,`,
    `    c.${sourceEntityId} AS source_entity_id,`,
    `    c.${confidenceScore} AS confidence_score,`,
    `    c.${clusteredAt} AS clustered_at,`,
    `    rm.${entityId} AS prior_entity_id,`,
    `    rm.${assignedAt} AS prior_assigned_at`,
    `  FROM ${componentsTable} c`,
    `  LEFT JOIN ${recordMapTable} rm`,
    `    ON c.${recordId} = rm.${recordId}`,
    `),`,
    `entity_births AS (`,
    `  SELECT`,
    `    ${entityId} AS entity_id,`,
    `    MIN(${createdAt}) AS first_assigned_at`,
    `  FROM ${eventsTable}`,
    `  WHERE ${eventType} <> ${quoteLiteral('alias', dialect)}`,
    `  GROUP BY ${entityId}`,
    `),`,
    `component_prior AS (`,
    `  SELECT`,
    `    cr.component_id,`,
    `    cr.prior_entity_id,`,
    `    COUNT(*) AS prior_record_count,`,
    `    MIN(COALESCE(eb.first_assigned_at, cr.prior_assigned_at)) AS first_assigned_at,`,
    `    MAX(cr.prior_assigned_at) AS prior_assigned_at,`,
    `    MAX(CASE WHEN cr.record_id = cr.prior_entity_id THEN 1 ELSE 0 END) AS has_anchor`,
    `  FROM current_records cr`,
    `  LEFT JOIN entity_births eb ON cr.prior_entity_id = eb.entity_id`,
    `  WHERE cr.prior_entity_id IS NOT NULL`,
    `  GROUP BY cr.component_id, cr.prior_entity_id`,
    `),`,
    `entity_component_ranked AS (`,
    `  SELECT`,
    `    cp.*,`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY cp.prior_entity_id`,
    `      ORDER BY cp.has_anchor DESC, cp.prior_record_count DESC, cp.component_id ASC`,
    `    ) AS entity_component_rank`,
    `  FROM component_prior cp`,
    `),`,
    `eligible_prior AS (`,
    `  SELECT * FROM entity_component_ranked WHERE entity_component_rank = 1`,
    `),`,
    `stable_choice_ranked AS (`,
    `  SELECT`,
    `    ep.*,`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY ep.component_id`,
    `      ORDER BY ep.first_assigned_at ASC, ep.prior_entity_id ASC`,
    `    ) AS component_rank`,
    `  FROM eligible_prior ep`,
    `),`,
    `stable_choice AS (`,
    `  SELECT`,
    `    component_id,`,
    `    prior_entity_id AS entity_id`,
    `  FROM stable_choice_ranked`,
    `  WHERE component_rank = 1`,
    `),`,
    `alias_component_candidates AS (`,
    `  SELECT`,
    `    cr.component_id,`,
    `    aliases.${aliasEntityId} AS alias_entity_id,`,
    `    aliases.${entityId} AS active_entity_id,`,
    `    COUNT(DISTINCT cr.record_id) AS represented_record_count,`,
    `    MAX(cr.prior_assigned_at) AS prior_assigned_at`,
    `  FROM current_records cr`,
    `  JOIN ${aliasesTable} aliases`,
    `    ON cr.prior_entity_id = aliases.${entityId}`,
    `   AND aliases.${supersededAt} IS NULL`,
    `  JOIN ${eventsTable} history`,
    `    ON history.${recordId} = cr.record_id`,
    `   AND (history.${entityId} = aliases.${aliasEntityId} OR history.${previousEntityId} = aliases.${aliasEntityId})`,
    `  WHERE cr.prior_entity_id IS NOT NULL`,
    `  GROUP BY cr.component_id, aliases.${aliasEntityId}, aliases.${entityId}`,
    `),`,
    `alias_component_ranked AS (`,
    `  SELECT`,
    `    acc.*,`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY acc.alias_entity_id`,
    `      ORDER BY acc.represented_record_count DESC, acc.component_id ASC`,
    `    ) AS alias_component_rank`,
    `  FROM alias_component_candidates acc`,
    `),`,
    `reactivated_alias_ranked AS (`,
    `  SELECT`,
    `    acr.*,`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY acr.component_id`,
    `      ORDER BY acr.represented_record_count DESC, acr.alias_entity_id ASC`,
    `    ) AS reactivated_rank`,
    `  FROM alias_component_ranked acr`,
    `  LEFT JOIN current_records active_anchor`,
    `    ON acr.component_id = active_anchor.component_id`,
    `   AND active_anchor.record_id = acr.active_entity_id`,
    `  WHERE acr.alias_component_rank = 1`,
    `    AND active_anchor.record_id IS NULL`,
    `),`,
    `reactivated_alias AS (`,
    `  SELECT`,
    `    component_id,`,
    `    alias_entity_id,`,
    `    prior_assigned_at`,
    `  FROM reactivated_alias_ranked`,
    `  WHERE reactivated_rank = 1`,
    `),`,
    `component_summary AS (`,
    `  SELECT`,
    `    component_id,`,
    `    COUNT(*) AS record_count,`,
    `    COUNT(DISTINCT prior_entity_id) AS prior_entity_count`,
    `  FROM current_records`,
    `  GROUP BY component_id`,
    `),`,
    `component_assignment AS (`,
    `  SELECT`,
    `    cs.component_id,`,
    `    COALESCE(ra.alias_entity_id, sc.entity_id, cs.component_id) AS entity_id,`,
    `    CASE`,
    `      WHEN ra.alias_entity_id IS NOT NULL THEN ${quoteLiteral('reactivated', dialect)}`,
    `      WHEN sc.entity_id IS NOT NULL AND cs.prior_entity_count > 1 THEN ${quoteLiteral('merged', dialect)}`,
    `      WHEN sc.entity_id IS NOT NULL THEN ${quoteLiteral('reused', dialect)}`,
    `      WHEN cs.prior_entity_count > 0 THEN ${quoteLiteral('split', dialect)}`,
    `      ELSE ${quoteLiteral('new', dialect)}`,
    `    END AS assignment_reason`,
    `  FROM component_summary cs`,
    `  LEFT JOIN stable_choice sc ON cs.component_id = sc.component_id`,
    `  LEFT JOIN reactivated_alias ra ON cs.component_id = ra.component_id`,
    `),`,
    `record_event_candidates AS (`,
    `  SELECT`,
    `    CASE`,
    `      WHEN cr.prior_entity_id IS NULL THEN ${quoteLiteral('assign', dialect)}`,
    `      WHEN ca.assignment_reason = ${quoteLiteral('reactivated', dialect)} THEN ${quoteLiteral('reactivate', dialect)}`,
    `      WHEN ca.assignment_reason = ${quoteLiteral('split', dialect)} THEN ${quoteLiteral('split', dialect)}`,
    `      ELSE ${quoteLiteral('move', dialect)}`,
    `    END AS event_type,`,
    `    ca.entity_id,`,
    `    cr.prior_entity_id AS previous_entity_id,`,
    `    cr.record_id,`,
    `    ca.component_id,`,
    `    cr.source_ref,`,
    `    cr.source_pk_json,`,
    `    cr.source_system,`,
    `    cr.source_entity_id,`,
    `    CASE`,
    `      WHEN cr.prior_entity_id IS NULL AND ca.assignment_reason = ${quoteLiteral('new', dialect)} THEN ${quoteLiteral('new', dialect)}`,
    `      WHEN cr.prior_entity_id IS NULL THEN ${quoteLiteral('new_record_existing_entity', dialect)}`,
    `      ELSE ca.assignment_reason`,
    `    END AS reason,`,
    `    cr.prior_assigned_at`,
    `  FROM current_records cr`,
    `  JOIN component_assignment ca ON cr.component_id = ca.component_id`,
    `  WHERE cr.prior_entity_id IS NULL`,
    `     OR cr.prior_entity_id <> ca.entity_id`,
    `),`,
    `alias_event_candidates AS (`,
    `  SELECT`,
    `    ${quoteLiteral('alias', dialect)} AS event_type,`,
    `    ca.entity_id,`,
    `    cp.prior_entity_id AS previous_entity_id,`,
    `    ${nullString(dialect)} AS record_id,`,
    `    ca.component_id,`,
    `    ${nullString(dialect)} AS source_ref,`,
    `    ${nullString(dialect)} AS source_pk_json,`,
    `    ${nullString(dialect)} AS source_system,`,
    `    ${nullString(dialect)} AS source_entity_id,`,
    `    ${quoteLiteral('merge', dialect)} AS reason,`,
    `    cp.prior_assigned_at`,
    `  FROM component_prior cp`,
    `  JOIN component_assignment ca ON cp.component_id = ca.component_id`,
    `  WHERE ca.assignment_reason = ${quoteLiteral('merged', dialect)}`,
    `    AND cp.prior_entity_id <> ca.entity_id`,
    `),`,
    `event_candidates_raw AS (`,
    `  SELECT * FROM record_event_candidates`,
    `  UNION ALL`,
    `  SELECT * FROM alias_event_candidates`,
    `),`,
    `event_candidates AS (`,
    `  SELECT r.*, ${eventIdExpr('r', dialect)} AS ${quoteIdentifier('event_id', dialect)}`,
    `  FROM event_candidates_raw r`,
    `)`,
    `SELECT`,
    eventCandidateSelect(dialect).join('\n'),
    `FROM event_candidates candidate`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1 FROM ${eventsTable} existing`,
    `  WHERE existing.${eventId} = candidate.${quoteIdentifier('event_id', dialect)}`,
    `)`,
  ].join('\n');

  return {
    name: 'assign_entity_ids',
    sql,
  };
}

export function generateEntityIdRecordMapSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  name = 'refresh_entity_id_record_map'
): SqlStatement {
  const entity = spec.entity;
  const eventsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_events'),
    dialect
  );
  const recordMapTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_record_map'),
    dialect
  );
  const eventId = quoteIdentifier('event_id', dialect);
  const eventType = quoteIdentifier('event_type', dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const previousEntityId = quoteIdentifier('previous_entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const componentId = quoteIdentifier('component_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const reason = quoteIdentifier('reason', dialect);
  const createdAt = quoteIdentifier('created_at', dialect);

  const sql = [
    createOrReplaceTableAs(recordMapTable, dialect),
    `WITH ranked_events AS (`,
    `  SELECT`,
    `    ${recordId},`,
    `    ${entityId},`,
    `    ${previousEntityId},`,
    `    ${componentId},`,
    `    ${sourceRef},`,
    `    ${sourcePkJson},`,
    `    ${sourceSystem},`,
    `    ${sourceEntityId},`,
    `    ${createdAt},`,
    `    ${reason},`,
    `    ROW_NUMBER() OVER (`,
    `      PARTITION BY ${recordId}`,
    `      ORDER BY ${createdAt} DESC, ${eventId} DESC`,
    `    ) AS rn`,
    `  FROM ${eventsTable}`,
    `  WHERE ${recordId} IS NOT NULL`,
    `    AND ${eventType} <> ${quoteLiteral('alias', dialect)}`,
    `)`,
    `SELECT`,
    `  ${recordId},`,
    `  ${entityId},`,
    `  ${previousEntityId},`,
    `  ${componentId},`,
    `  ${sourceRef},`,
    `  ${sourcePkJson},`,
    `  ${sourceSystem},`,
    `  ${sourceEntityId},`,
    `  ${createdAt} AS ${quoteIdentifier('assigned_at', dialect)},`,
    `  ${reason} AS ${quoteIdentifier('assignment_reason', dialect)}`,
    `FROM ranked_events`,
    `WHERE rn = 1`,
  ].join('\n');

  return {
    name,
    sql,
    tableCreated: outputTableName(entity, '__entity_id_record_map'),
  };
}

export function generateEntityIdAliasesSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  name = 'refresh_entity_id_aliases'
): SqlStatement {
  const entity = spec.entity;
  const eventsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_events'),
    dialect
  );
  const aliasesTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_aliases'),
    dialect
  );
  const eventId = quoteIdentifier('event_id', dialect);
  const eventType = quoteIdentifier('event_type', dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const previousEntityId = quoteIdentifier('previous_entity_id', dialect);
  const reason = quoteIdentifier('reason', dialect);
  const createdAt = quoteIdentifier('created_at', dialect);
  const aliasEntityId = quoteIdentifier('alias_entity_id', dialect);

  const sql = [
    createOrReplaceTableAs(aliasesTable, dialect),
    `WITH alias_events AS (`,
    `  SELECT`,
    `    ${eventId},`,
    `    ${entityId},`,
    `    ${previousEntityId} AS ${aliasEntityId},`,
    `    ${reason} AS ${quoteIdentifier('alias_reason', dialect)},`,
    `    ${createdAt}`,
    `  FROM ${eventsTable}`,
    `  WHERE ${eventType} = ${quoteLiteral('alias', dialect)}`,
    `    AND ${previousEntityId} IS NOT NULL`,
    `),`,
    `alias_supersession AS (`,
    `  SELECT`,
    `    alias.${eventId},`,
    `    MIN(reactivation.${createdAt}) AS ${quoteIdentifier('superseded_at', dialect)}`,
    `  FROM alias_events alias`,
    `  JOIN ${eventsTable} reactivation`,
    `    ON reactivation.${eventType} = ${quoteLiteral('reactivate', dialect)}`,
    `   AND reactivation.${entityId} = alias.${aliasEntityId}`,
    `   AND reactivation.${createdAt} > alias.${createdAt}`,
    `  GROUP BY alias.${eventId}`,
    `)`,
    `SELECT`,
    `  alias.${entityId},`,
    `  alias.${aliasEntityId},`,
    `  alias.${quoteIdentifier('alias_reason', dialect)},`,
    `  alias.${createdAt},`,
    `  superseded.${quoteIdentifier('superseded_at', dialect)}`,
    `FROM alias_events alias`,
    `LEFT JOIN alias_supersession superseded`,
    `  ON alias.${eventId} = superseded.${eventId}`,
  ].join('\n');

  return {
    name,
    sql,
    tableCreated: outputTableName(entity, '__entity_id_aliases'),
  };
}

export function generateEntityIdCurrentSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const componentsTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__components'),
    dialect
  );
  const recordMapTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_record_map'),
    dialect
  );
  const currentTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_current'),
    dialect
  );
  const entityId = quoteIdentifier('entity_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const componentId = quoteIdentifier('component_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const clusteredAt = quoteIdentifier('clustered_at', dialect);
  const assignedAt = quoteIdentifier('assigned_at', dialect);
  const assignmentReason = quoteIdentifier('assignment_reason', dialect);

  const sql = [
    createOrReplaceTableAs(currentTable, dialect),
    `SELECT`,
    `  rm.${entityId},`,
    `  c.${recordId},`,
    `  c.${componentId},`,
    `  c.${sourceRef},`,
    `  c.${sourcePkJson},`,
    `  c.${sourceSystem},`,
    `  c.${sourceEntityId},`,
    `  c.${confidenceScore},`,
    `  c.${clusteredAt},`,
    `  rm.${assignedAt},`,
    `  rm.${assignmentReason}`,
    `FROM ${componentsTable} c`,
    `JOIN ${recordMapTable} rm`,
    `  ON c.${recordId} = rm.${recordId}`,
  ].join('\n');

  return {
    name: 'refresh_entity_id_current',
    sql,
    tableCreated: outputTableName(entity, '__entity_id_current'),
  };
}

export function generateStableClustersSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement {
  const entity = spec.entity;
  const currentTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_current'),
    dialect
  );
  const clustersTable = buildFqName(targetSchema, outputTableName(entity, '__clusters'), dialect);
  const entityId = quoteIdentifier('entity_id', dialect);
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const componentId = quoteIdentifier('component_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const sourceRef = quoteIdentifier('source_ref', dialect);
  const sourcePkJson = quoteIdentifier('source_pk_json', dialect);
  const sourceEntityId = quoteIdentifier('source_entity_id', dialect);
  const sourceSystem = quoteIdentifier('source_system', dialect);
  const confidenceScore = quoteIdentifier('confidence_score', dialect);
  const clusteredAt = quoteIdentifier('clustered_at', dialect);

  const sql = [
    createOrReplaceTableAs(clustersTable, dialect),
    `SELECT`,
    `  ${entityId},`,
    `  ${entityId} AS ${clusterId},`,
    `  ${componentId},`,
    `  ${recordId},`,
    `  ${sourceRef},`,
    `  ${sourcePkJson},`,
    `  ${sourceEntityId},`,
    `  ${sourceSystem},`,
    `  ${confidenceScore},`,
    `  ${clusteredAt}`,
    `FROM ${currentTable}`,
  ].join('\n');

  return {
    name: 'stable_clusters',
    sql,
    tableCreated: outputTableName(entity, '__clusters'),
  };
}

export function generateEntityIdSummaryQuery(
  entity: string,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  const currentTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_current'),
    dialect
  );
  const aliasesTable = buildFqName(
    targetSchema,
    outputTableName(entity, '__entity_id_aliases'),
    dialect
  );
  const entityId = quoteIdentifier('entity_id', dialect);
  const assignmentReason = quoteIdentifier('assignment_reason', dialect);
  const assignedAt = quoteIdentifier('assigned_at', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const rn = quoteIdentifier('rn', dialect);
  const supersededAt = quoteIdentifier('superseded_at', dialect);

  return [
    `WITH latest_entity_reason AS (`,
    `  SELECT`,
    `    ${entityId},`,
    `    ${assignmentReason}`,
    `  FROM (`,
    `    SELECT`,
    `      ${entityId},`,
    `      ${assignmentReason},`,
    `      ROW_NUMBER() OVER (`,
    `        PARTITION BY ${entityId}`,
    `        ORDER BY ${assignedAt} DESC, ${assignmentReason} DESC, ${recordId} DESC`,
    `      ) AS ${rn}`,
    `    FROM ${currentTable}`,
    `  ) ranked`,
    `  WHERE ranked.${rn} = 1`,
    `)`,
    `SELECT`,
    `  COALESCE(SUM(CASE WHEN ${assignmentReason} = ${quoteLiteral('new', dialect)} THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier('new_ids', dialect)},`,
    `  COALESCE(SUM(CASE WHEN ${assignmentReason} IN (${quoteLiteral('reused', dialect)}, ${quoteLiteral('new_record_existing_entity', dialect)}) THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier('reused_ids', dialect)},`,
    `  COALESCE(SUM(CASE WHEN ${assignmentReason} = ${quoteLiteral('merged', dialect)} THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier('merged_ids', dialect)},`,
    `  COALESCE(SUM(CASE WHEN ${assignmentReason} = ${quoteLiteral('split', dialect)} THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier('split_ids', dialect)},`,
    `  COALESCE(SUM(CASE WHEN ${assignmentReason} = ${quoteLiteral('reactivated', dialect)} THEN 1 ELSE 0 END), 0) AS ${quoteIdentifier('reactivated_ids', dialect)},`,
    `  (SELECT COUNT(*) FROM ${aliasesTable} WHERE ${supersededAt} IS NULL) AS ${quoteIdentifier('alias_count', dialect)}`,
    `FROM latest_entity_reason`,
  ].join('\n');
}
