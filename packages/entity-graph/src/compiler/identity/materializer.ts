/**
 * Resolution materializer — bootstrap DDL for persistent tables and views.
 *
 * Generates CREATE TABLE IF NOT EXISTS for tables that persist across
 * pipeline runs (__review_decisions, __not_match_edges, etc.) and
 * CREATE OR REPLACE VIEW for semantic view artifacts. Pipeline tables
 * with CREATE OR REPLACE are handled by their codegen modules.
 */

import { quoteIdentifier, buildFqName, getCanonicalDialect } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SqlStatement } from './types.js';
import { OUTPUT_TABLES, outputTableName } from '../output-tables/index.js';
import type { OutputTableDef } from '../output-tables/index.js';
import { buildMentionQualityViewSelect } from '../../runtime/mention/quality-view.js';
import { nullOfType } from './sql.js';

const ENTITY_ID_BOOTSTRAP_SUFFIXES = new Set([
  '__entity_id_events',
  '__entity_id_record_map',
  '__entity_id_current',
  '__entity_id_aliases',
]);

/** Map abstract column types to dialect-specific SQL types. */
export function mapColumnType(type: string, dialect: SupportedDialect): string {
  const canonicalDialect = getCanonicalDialect(dialect);
  switch (type) {
    case 'STRING':
      return dialect === 'redshift'
        ? 'VARCHAR(4096)'
        : canonicalDialect === 'bigquery' || canonicalDialect === 'databricks'
          ? 'STRING'
          : canonicalDialect === 'mysql'
            ? 'VARCHAR(4096)'
            : canonicalDialect === 'snowflake'
              ? 'VARCHAR'
              : canonicalDialect === 'postgres'
                ? 'VARCHAR(4096)'
                : 'VARCHAR';
    case 'FLOAT':
      return canonicalDialect === 'bigquery'
        ? 'FLOAT64'
        : canonicalDialect === 'mysql'
          ? 'DOUBLE'
          : canonicalDialect === 'snowflake'
            ? 'FLOAT'
            : 'DOUBLE PRECISION';
    case 'INTEGER':
      return canonicalDialect === 'bigquery'
        ? 'INT64'
        : canonicalDialect === 'mysql'
          ? 'INT'
          : canonicalDialect === 'snowflake'
            ? 'NUMBER'
            : 'INTEGER';
    case 'TIMESTAMP':
      return canonicalDialect === 'bigquery'
        ? 'TIMESTAMP'
        : canonicalDialect === 'mysql'
          ? 'DATETIME'
          : 'TIMESTAMP';
    case 'ARRAY_FLOAT':
      if (canonicalDialect === 'duckdb') return 'DOUBLE[]';
      if (canonicalDialect === 'bigquery') return 'ARRAY<FLOAT64>';
      if (canonicalDialect === 'postgres') return 'DOUBLE PRECISION[]';
      if (canonicalDialect === 'snowflake') return 'ARRAY';
      if (canonicalDialect === 'databricks') return 'ARRAY<DOUBLE>';
      return 'JSON';
    default:
      return type;
  }
}

/** Generate a single CREATE TABLE IF NOT EXISTS statement. */
/**
 * Dialect-typed NULL literal. Bare `NULL` in a SELECT/UNION ALL chain lets
 * BigQuery infer INT64 and then reject the insert into STRING/FLOAT/TIMESTAMP
 * columns — always cast NULLs to the abstract column type instead.
 */
export function typedNull(type: string, dialect: SupportedDialect): string {
  return nullOfType(mapColumnType(type, dialect), dialect);
}

function generateCreateIfNotExists(
  tableDef: OutputTableDef,
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement | null {
  // Only generate DDL for append-only tables (create_if_not_exists)
  if (tableDef.ddlStrategy !== 'create_if_not_exists') return null;
  if ((tableDef.kind ?? 'table') !== 'table') return null;

  const fullTableName = buildFqName(
    targetSchema,
    outputTableName(entityName, tableDef.suffix),
    dialect
  );

  const columnDefs = tableDef.columns
    .map((col) => {
      const name = quoteIdentifier(col.name, dialect);
      const type = mapColumnType(col.type, dialect);
      return `  ${name} ${type}`;
    })
    .join(',\n');

  const sql = `CREATE TABLE IF NOT EXISTS ${fullTableName} (\n${columnDefs}\n)`;

  return {
    name: `ddl_${tableDef.suffix.replace(/^__/, '')}`,
    sql,
    tableCreated: outputTableName(entityName, tableDef.suffix),
  };
}

function generateCreateOrReplaceView(
  tableDef: OutputTableDef,
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement | null {
  if (tableDef.kind !== 'view') return null;
  if (tableDef.suffix === '__golden_masked') return null;
  if (tableDef.suffix !== '__document_mentions__quality') {
    throw new Error(`No view generator registered for ${tableDef.suffix}`);
  }

  const viewName = buildFqName(targetSchema, outputTableName(entityName, tableDef.suffix), dialect);
  const mentionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__document_mentions'),
    dialect
  );
  const selectSql = buildMentionQualityViewSelect({ mentionsTable, dialect });
  const sql = `CREATE OR REPLACE VIEW ${viewName} AS\n${selectSql}`;

  return {
    name: `ddl_${tableDef.suffix.replace(/^__/, '')}`,
    sql,
    tableCreated: outputTableName(entityName, tableDef.suffix),
  };
}

/**
 * Generate DDL for persistent output artifacts that need bootstrap DDL.
 *
 * Returns CREATE TABLE IF NOT EXISTS statements for append-only tables
 * and CREATE OR REPLACE VIEW statements for semantic views.
 */
export function generateMaterializeDdl(
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const tableDefs = [...OUTPUT_TABLES.for('identity'), ...OUTPUT_TABLES.for('semantic')];

  for (const tableDef of tableDefs) {
    const stmt =
      generateCreateIfNotExists(tableDef, entityName, dialect, targetSchema) ??
      generateCreateOrReplaceView(tableDef, entityName, dialect, targetSchema);
    if (stmt) statements.push(stmt);
  }

  return statements;
}

export function generateEntityIdBootstrapDdl(
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement[] {
  return generateMaterializeDdl(entityName, dialect, targetSchema).filter((statement) => {
    // Reverse generateCreateIfNotExists' ddl_<suffix> statement name back to __<suffix>.
    const suffix = statement.name.replace(/^ddl_/, '__');
    return ENTITY_ID_BOOTSTRAP_SUFFIXES.has(suffix);
  });
}
