import { assertBigQueryQuotedIdentifier } from '@bobsled-inc/protocol';
/**
 * BigQuery catalog helpers for the run preflight: table-reference parsing and
 * read-only INFORMATION_SCHEMA lookups.
 */

import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';

import type { SqlQueryRow, SqlRunnerModule } from '../compiler/index.js';

export interface BigQueryTableRef {
  dataset: string;
  table: string;
  project?: string;
}

export function parseBigQueryTableRef(fqRef: string): BigQueryTableRef | undefined {
  // Strip backticks per identifier segment so `project`.`dataset`.`table`
  // parses the same as project.dataset.table. A single full-string strip would
  // leave inner backticks intact and break the parse.
  const parts = fqRef
    .split('.')
    .map((part) => part.trim().replace(/^`|`$/g, ''))
    .filter((part) => part.length > 0);
  if (parts.length === 2) {
    const [dataset, table] = parts;
    if (!dataset || !table) return undefined;
    return { dataset, table };
  }
  if (parts.length === 3) {
    const [project, dataset, table] = parts;
    if (!project || !dataset || !table) return undefined;
    return { project, dataset, table };
  }
  return undefined;
}

export function sameBigQueryTable(a: BigQueryTableRef, b: BigQueryTableRef): boolean {
  if (a.project && b.project && a.project.toLowerCase() !== b.project.toLowerCase()) return false;
  return (
    a.dataset.toLowerCase() === b.dataset.toLowerCase() &&
    a.table.toLowerCase() === b.table.toLowerCase()
  );
}

/**
 * Return the subset of `relations` (keyed by model) that exist, using one
 * INFORMATION_SCHEMA.TABLES read per dataset. Returns `undefined` when the
 * catalog cannot be read, so callers keep today's up-front behavior.
 */
export async function probeBigQueryRelations(
  query: NonNullable<SqlRunnerModule['query']>,
  relations: ReadonlyMap<string, BigQueryTableRef>,
  signal: AbortSignal | undefined,
  onWarn: (message: string) => void
): Promise<Set<string> | undefined> {
  const existing = new Set<string>();
  const byDataset = new Map<string, { ref: BigQueryTableRef; models: Map<string, string> }>();
  for (const [model, ref] of relations) {
    const key = `${ref.project ?? ''}\u0000${ref.dataset}`;
    const group = byDataset.get(key) ?? { ref, models: new Map<string, string>() };
    group.models.set(model, ref.table.toLowerCase());
    byDataset.set(key, group);
  }

  for (const { ref, models } of byDataset.values()) {
    throwIfCancelled(signal);
    const infoSchemaPath = ref.project
      ? `${ref.project}.${ref.dataset}.INFORMATION_SCHEMA.TABLES`
      : `${ref.dataset}.INFORMATION_SCHEMA.TABLES`;
    const names = [...new Set(models.values())].sort();
    const sql =
      `SELECT table_name FROM \`${escapeBigQueryIdentifierPath(infoSchemaPath)}\` ` +
      `WHERE LOWER(table_name) IN (${names.map((name) => `'${escapeBigQueryString(name)}'`).join(', ')})`;
    let rows: SqlQueryRow[];
    try {
      rows = signal ? await query(sql, undefined, { signal }) : await query(sql);
    } catch (err) {
      if (isCancellationError(err, signal)) throw err;
      onWarn(
        `BigQuery preflight could not read ${infoSchemaPath} to order dry runs; ` +
          `every model is dry-run before execution starts: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
    const found = new Set(
      rows
        .map((row) => row['table_name'] ?? row['TABLE_NAME'])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.toLowerCase())
    );
    for (const [model, table] of models) {
      if (found.has(table)) existing.add(model);
    }
  }
  return existing;
}

export async function fetchBigQueryColumns(
  query: NonNullable<SqlRunnerModule['query']>,
  tableRef: BigQueryTableRef,
  signal?: AbortSignal
): Promise<Set<string>> {
  const infoSchemaPath = tableRef.project
    ? `${tableRef.project}.${tableRef.dataset}.INFORMATION_SCHEMA.COLUMNS`
    : `${tableRef.dataset}.INFORMATION_SCHEMA.COLUMNS`;
  const sql = `SELECT column_name FROM \`${escapeBigQueryIdentifierPath(infoSchemaPath)}\` WHERE table_name = '${escapeBigQueryString(tableRef.table)}'`;
  // Preserve the original call arity when the caller opted out of cancellation.
  const rows = signal ? await query(sql, undefined, { signal }) : await query(sql);
  return new Set(rows.map((row) => getColumnName(row)).filter((name): name is string => !!name));
}

function getColumnName(row: SqlQueryRow): string | undefined {
  const value = row['column_name'] ?? row['COLUMN_NAME'] ?? row['columnName'];
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function escapeBigQueryIdentifierPath(value: string): string {
  return assertBigQueryQuotedIdentifier(value, 'BigQuery table path');
}

function escapeBigQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}
