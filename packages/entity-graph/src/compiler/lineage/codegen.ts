import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec } from '../identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../survivorship/types.js';
import type { SqlStatement } from '../identity/types.js';
import { ENTITY_GRAPH_SCHEMA } from '../audit/codegen.js';
import { generateAuditInsertSql } from '../audit/codegen.js';
import { buildLineageRows } from './merge.js';
import type { LineageCompileResult, LineageRow } from './types.js';

export const LINEAGE_TABLE = 'lineage';

function lineageTableName(dialect: SupportedDialect, contractSchema = ENTITY_GRAPH_SCHEMA): string {
  return buildFqName(contractSchema, LINEAGE_TABLE, dialect);
}

function booleanLiteral(value: boolean, _dialect: SupportedDialect): string {
  return value ? 'TRUE' : 'FALSE';
}

function nullOrLiteral(value: string | null, dialect: SupportedDialect): string {
  return value === null ? 'NULL' : quoteLiteral(value, dialect);
}

/** DDL to create entity_graph.lineage if it does not exist. */
export function buildLineageTableDdl(
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): SqlStatement[] {
  const tableName = lineageTableName(dialect, contractSchema);
  const ti = (name: string) => quoteIdentifier(name, dialect);

  const columns = [
    `  ${ti('entity_type')} VARCHAR`,
    `  ${ti('entity_id')} VARCHAR`,
    `  ${ti('attribute')} VARCHAR`,
    `  ${ti('profile_table')} VARCHAR`,
    `  ${ti('profile_column')} VARCHAR`,
    `  ${ti('source_system')} VARCHAR`,
    `  ${ti('source_table')} VARCHAR`,
    `  ${ti('source_column')} VARCHAR`,
    `  ${ti('field_path')} VARCHAR`,
    `  ${ti('transform_ref')} VARCHAR`,
    `  ${ti('transform_step')} VARCHAR`,
    `  ${ti('is_complete')} BOOLEAN`,
    `  ${ti('loaded_at')} TIMESTAMP`,
  ].join(',\n');

  return [
    {
      name: 'ddl_lineage_table',
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (\n${columns}\n)`,
      tableCreated: `${contractSchema}.${LINEAGE_TABLE}`,
    },
  ];
}

/**
 * DELETE + INSERT statements that refresh schema-level lineage rows for one
 * entity type (entity_id IS NULL). Idempotent: old rows are removed before the
 * new batch is inserted.
 */
export function buildLineageInsertSql(
  entityType: string,
  rows: LineageRow[],
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): SqlStatement[] {
  const tableName = lineageTableName(dialect, contractSchema);
  const ti = (name: string) => quoteIdentifier(name, dialect);

  const deleteStmt: SqlStatement = {
    name: `lineage_delete_${entityType}`,
    sql: [
      `DELETE FROM ${tableName}`,
      `WHERE ${ti('entity_type')} = ${quoteLiteral(entityType, dialect)}`,
      `  AND ${ti('entity_id')} IS NULL`,
    ].join('\n'),
  };

  if (rows.length === 0) {
    return [deleteStmt];
  }

  const valueRows = rows.map((row) => {
    return [
      `  (`,
      `    ${quoteLiteral(row.entity_type, dialect)},`,
      `    NULL,`,
      `    ${quoteLiteral(row.attribute, dialect)},`,
      `    ${quoteLiteral(row.profile_table, dialect)},`,
      `    ${quoteLiteral(row.profile_column, dialect)},`,
      `    ${nullOrLiteral(row.source_system, dialect)},`,
      `    ${quoteLiteral(row.source_table, dialect)},`,
      `    ${quoteLiteral(row.source_column, dialect)},`,
      `    ${nullOrLiteral(row.field_path, dialect)},`,
      `    ${nullOrLiteral(row.transform_ref, dialect)},`,
      `    ${nullOrLiteral(row.transform_step, dialect)},`,
      `    ${booleanLiteral(row.is_complete, dialect)},`,
      `    CURRENT_TIMESTAMP`,
      `  )`,
    ].join('\n');
  });

  const insertStmt: SqlStatement = {
    name: `lineage_insert_${entityType}`,
    sql: [
      `INSERT INTO ${tableName} (`,
      `  ${ti('entity_type')}, ${ti('entity_id')}, ${ti('attribute')},`,
      `  ${ti('profile_table')}, ${ti('profile_column')}, ${ti('source_system')},`,
      `  ${ti('source_table')}, ${ti('source_column')}, ${ti('field_path')},`,
      `  ${ti('transform_ref')}, ${ti('transform_step')}, ${ti('is_complete')},`,
      `  ${ti('loaded_at')}`,
      `) VALUES`,
      valueRows.join(',\n'),
    ].join('\n'),
  };

  return [deleteStmt, insertStmt];
}

/** SQL to query lineage rows for a given entity type and attribute. */
export function buildLineageQuerySql(options: {
  entityType: string;
  attribute: string;
  entityId?: string;
  dialect: SupportedDialect;
  contractSchema?: string;
}): string {
  const tableName = lineageTableName(options.dialect, options.contractSchema);
  const ti = (name: string) => quoteIdentifier(name, options.dialect);

  const predicates = [
    `${ti('entity_type')} = ${quoteLiteral(options.entityType, options.dialect)}`,
    `${ti('attribute')} = ${quoteLiteral(options.attribute, options.dialect)}`,
  ];
  if (options.entityId !== undefined) {
    predicates.push(
      `(${ti('entity_id')} = ${quoteLiteral(options.entityId, options.dialect)} OR ${ti('entity_id')} IS NULL)`
    );
  }

  return [
    `SELECT`,
    `  ${ti('entity_type')}, ${ti('entity_id')}, ${ti('attribute')},`,
    `  ${ti('profile_table')}, ${ti('profile_column')}, ${ti('source_system')},`,
    `  ${ti('source_table')}, ${ti('source_column')}, ${ti('field_path')},`,
    `  ${ti('transform_ref')}, ${ti('transform_step')}, ${ti('is_complete')},`,
    `  ${ti('loaded_at')}`,
    `FROM ${tableName}`,
    `WHERE ${predicates.join('\n  AND ')}`,
    `ORDER BY ${ti('source_system')}, ${ti('source_table')}, ${ti('source_column')}`,
  ].join('\n');
}

/**
 * Compile lineage DDL + data statements for one entity type, given its
 * resolution and survivorship specs.
 *
 * Emits:
 *   1. CREATE TABLE IF NOT EXISTS entity_graph.lineage
 *   2. DELETE old schema-level rows for this entity_type
 *   3. INSERT new lineage rows
 *   4. Audit INSERT for lineage_refresh event
 */
export function compileLineage(
  resolutionSpec: ResolvedResolutionSpec,
  survivorshipSpec: ResolvedSurvivorshipSpec,
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): LineageCompileResult {
  const entityType = survivorshipSpec.entity;
  const { rows, warnings } = buildLineageRows(resolutionSpec, survivorshipSpec);

  const completeCount = rows.filter((r) => r.is_complete).length;
  const incompleteCount = rows.filter((r) => !r.is_complete).length;

  const ddlStatements = buildLineageTableDdl(dialect, contractSchema);
  const dataStatements = buildLineageInsertSql(entityType, rows, dialect, contractSchema);
  const auditStatement = generateAuditInsertSql({
    name: `audit_lineage_refresh_${entityType}`,
    dialect,
    contractSchema,
    category: 'mutation',
    subjectType: 'lineage_compile',
    subjectId: entityType,
    payload: {
      kind: 'lineage_refresh',
      entity_type: entityType,
      attribute_count: rows.length,
      complete_count: completeCount,
      incomplete_count: incompleteCount,
    },
    actor: 'system',
    actorType: 'system',
    eventIdDiscriminator: `${rows.length}-${completeCount}-${incompleteCount}`,
  });

  if (incompleteCount > 0) {
    warnings.push(
      `${entityType}: ${incompleteCount} lineage row(s) marked is_complete=false — provenance chain is incomplete for those attributes`
    );
  }

  return {
    entity_type: entityType,
    rows,
    warnings,
    statements: [...ddlStatements, ...dataStatements, auditStatement],
  };
}
