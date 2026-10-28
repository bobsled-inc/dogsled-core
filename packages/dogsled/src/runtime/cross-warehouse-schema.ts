import {
  buildFqNameWithDatabase,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { reverseMapDbType } from '@bobsled-inc/loader/runtime';
import {
  assertBigQueryQuotedIdentifier,
  CommandError,
  type SchemaColumn,
} from '@bobsled-inc/protocol';
import { throwIfCancelled, type SqlRunnerModule } from '@bobsled-inc/connections';

interface ColumnDiff {
  added: SchemaColumn[];
  removed: SchemaColumn[];
  changed: Array<{ before: SchemaColumn; after: SchemaColumn }>;
  hasChanges: boolean;
}

export async function describeTable(
  runner: SqlRunnerModule,
  database: string | undefined,
  schema: string,
  table: string,
  dialect: SupportedDialect,
  signal?: AbortSignal
): Promise<SchemaColumn[] | null> {
  throwIfCancelled(signal);
  if (!runner.query) {
    throw new CommandError('Destination runner lacks query() for schema drift check.', 1);
  }
  const sql = buildInformationSchemaSql(database, schema, table, dialect);
  const rows = signal ? await runner.query(sql, undefined, { signal }) : await runner.query(sql);
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    name: String(readRowValue(row, 'column_name')),
    type: normalizeColumnType(String(readRowValue(row, 'data_type'))),
  }));
}

export async function enforceSchemaDrift(
  runner: SqlRunnerModule,
  expectedColumns: SchemaColumn[],
  target: {
    database?: string;
    schema: string;
    table: string;
    fqn: string;
    dialect: SupportedDialect;
  },
  onSchemaChange: 'fail' | 'full_refresh',
  options: { dropOnFullRefresh?: boolean; signal?: AbortSignal } = {}
): Promise<{ fullRefresh: boolean }> {
  const existing = await describeTable(
    runner,
    target.database,
    target.schema,
    target.table,
    target.dialect,
    options.signal
  );
  if (!existing) return { fullRefresh: true };

  const drift = diffColumns(expectedColumns, existing);
  if (!drift.hasChanges) return { fullRefresh: false };

  if (onSchemaChange === 'full_refresh') {
    if (options.dropOnFullRefresh !== false) {
      if (options.signal) {
        await runner.run(`DROP TABLE IF EXISTS ${target.fqn}`, { signal: options.signal });
      } else {
        await runner.run(`DROP TABLE IF EXISTS ${target.fqn}`);
      }
    }
    return { fullRefresh: true };
  }

  throw new CommandError(
    [
      `Cross-warehouse target ${target.fqn} schema drifted from model "${target.table}":`,
      formatDrift(drift),
      'Set materialization.on_schema_change: full_refresh to auto-rebuild.',
    ].join(' '),
    3
  );
}

export function targetFqn(
  database: string | undefined,
  schema: string,
  table: string,
  dialect: SupportedDialect
): string {
  return buildFqNameWithDatabase(schema, table, dialect, database);
}

function buildInformationSchemaSql(
  database: string | undefined,
  schema: string,
  table: string,
  dialect: SupportedDialect
): string {
  const schemaLiteral = quoteLiteral(foldInfoSchemaName(schema, dialect), dialect);
  const tableLiteral = quoteLiteral(foldInfoSchemaName(table, dialect), dialect);

  switch (dialect) {
    case 'snowflake': {
      const infoSchema = database
        ? `${quoteIdentifier(database, dialect)}.INFORMATION_SCHEMA.COLUMNS`
        : 'INFORMATION_SCHEMA.COLUMNS';
      return (
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type FROM ${infoSchema} ` +
        `WHERE TABLE_SCHEMA = ${schemaLiteral} AND TABLE_NAME = ${tableLiteral} ` +
        'ORDER BY ORDINAL_POSITION'
      );
    }
    case 'bigquery': {
      const path = database
        ? `${database}.${schema}.INFORMATION_SCHEMA.COLUMNS`
        : `${schema}.INFORMATION_SCHEMA.COLUMNS`;
      const infoSchema = `\`${assertBigQueryQuotedIdentifier(path, 'BigQuery schema path')}\``;
      return (
        `SELECT column_name, data_type FROM ${infoSchema} ` +
        `WHERE table_name = ${tableLiteral} ORDER BY ordinal_position`
      );
    }
    case 'databricks':
      return (
        'SELECT column_name, data_type FROM system.information_schema.columns ' +
        `WHERE table_catalog = ${quoteLiteral(database ?? '', dialect)} ` +
        `AND table_schema = ${schemaLiteral} AND table_name = ${tableLiteral} ` +
        'ORDER BY ordinal_position'
      );
    default:
      return (
        'SELECT column_name, data_type FROM information_schema.columns ' +
        `WHERE table_schema = ${schemaLiteral} AND table_name = ${tableLiteral} ` +
        'ORDER BY ordinal_position'
      );
  }
}

function foldInfoSchemaName(name: string, dialect: SupportedDialect): string {
  return dialect === 'snowflake' ? name.toUpperCase() : name.toLowerCase();
}

function readRowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
}

function normalizeColumnType(dbType: string): Exclude<SchemaColumn['type'], 'vector'> {
  const type = reverseMapDbType(dbType);
  return type === 'vector' ? 'array' : type;
}

function diffColumns(expected: SchemaColumn[], existing: SchemaColumn[]): ColumnDiff {
  const expectedByName = indexColumns(expected);
  const existingByName = indexColumns(existing);
  const added: SchemaColumn[] = [];
  const removed: SchemaColumn[] = [];
  const changed: Array<{ before: SchemaColumn; after: SchemaColumn }> = [];

  for (const [key, after] of expectedByName) {
    const before = existingByName.get(key);
    if (!before) {
      added.push(after);
      continue;
    }
    if (before.type !== after.type) {
      changed.push({ before, after });
    }
  }

  for (const [key, before] of existingByName) {
    if (!expectedByName.has(key)) {
      removed.push(before);
    }
  }

  return {
    added,
    removed,
    changed,
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

function indexColumns(columns: SchemaColumn[]): Map<string, SchemaColumn> {
  const map = new Map<string, SchemaColumn>();
  for (const column of columns) {
    map.set(column.name.toLowerCase(), column);
  }
  return map;
}

function formatDrift(diff: ColumnDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`missing columns: ${diff.added.map((column) => column.name).join(', ')}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`extra columns: ${diff.removed.map((column) => column.name).join(', ')}`);
  }
  if (diff.changed.length > 0) {
    parts.push(
      `type changes: ${diff.changed
        .map((change) => `${change.after.name} ${change.before.type}->${change.after.type}`)
        .join(', ')}`
    );
  }
  return parts.join('; ');
}
