/** SQL differences for the same processed-key materialization operation. */
import { caseName, quoteIdentifier, quoteLiteral } from '../compiler/dialect.js';
import type { AgenticColumn } from './model.js';
import { digestAgenticState } from './state.js';

export type PublicationDialect = 'postgres' | 'snowflake' | 'bigquery' | 'databricks';
export function publicationNames(
  target: string,
  dialect: PublicationDialect,
  systemSchema?: string
) {
  // Read quoted components, including dots inside quotes. Never accept SQL fragments.
  const parts: string[] = [];
  let rest = target;
  while (rest) {
    const match = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([A-Za-z_][A-Za-z0-9_-]*))(?:\.|$)/.exec(
      rest
    );
    if (!match) throw new Error('Publication requires a qualified table name');
    parts.push(match[1]?.replaceAll('""', '"') ?? match[2]?.replaceAll('``', '`') ?? match[3]!);
    rest = rest.slice(match[0].length);
  }
  // BigQuery registries can quote project.dataset as one namespace.
  if (dialect === 'bigquery' && parts.length === 2) parts.splice(0, 1, ...parts[0]!.split('.'));
  if (parts.length < 2 || parts.length > (dialect === 'postgres' ? 2 : 3)) {
    throw new Error('Publication requires schema.table or database.schema.table');
  }
  const q = (name: string) => quoteIdentifier(name, dialect);
  const normalized = parts.map((part) => caseName(part, dialect));
  const sql = normalized.map(q).join('.');
  const namespace = normalized.slice(0, -1).map(q).join('.');
  if (systemSchema !== undefined && (!systemSchema.trim() || systemSchema.length > 1024)) {
    throw new Error('Invalid publication system schema');
  }
  const storageNamespace =
    systemSchema === undefined
      ? namespace
      : [...normalized.slice(0, -2), caseName(systemSchema, dialect)].map(q).join('.');
  const prefix = `_dogsled_pub_${digestAgenticState(sql).slice(0, 24)}`;
  const ref = (name: string) => `${storageNamespace}.${q(name)}`;
  if (normalized.at(-1)!.toLowerCase().startsWith('_dogsled_pub_')) {
    throw new Error('Publication metadata names are reserved');
  }
  return {
    target: sql,
    namespace,
    storageNamespace,
    schema: normalized.at(-2)!,
    table: normalized.at(-1)!,
    catalog: normalized.length === 3 ? normalized[0] : undefined,
    control: ref(`${prefix}_control`),
    manifests: ref(`${prefix}_stages`),
    receipts: ref(`${prefix}_receipts`),
    // PostgreSQL identifiers are limited to 63 bytes. Keep 192 bits of the digest.
    stage: (id: string, suffix = '') => ref(`_dogsled_pub_${id.slice(0, 48)}${suffix}`),
  };
}
export function publicationType(type: AgenticColumn['type'], dialect: PublicationDialect): string {
  switch (type) {
    case 'string':
      return dialect === 'postgres' ? 'TEXT' : dialect === 'snowflake' ? 'VARCHAR' : 'STRING';
    case 'integer':
      return dialect === 'bigquery' ? 'INT64' : 'BIGINT';
    case 'number':
      return dialect === 'bigquery'
        ? 'FLOAT64'
        : dialect === 'postgres'
          ? 'DOUBLE PRECISION'
          : 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'timestamp':
      return dialect === 'snowflake' ? 'TIMESTAMP_NTZ' : 'TIMESTAMP';
    case 'object':
    case 'array':
      return dialect === 'postgres' ? 'JSONB' : dialect === 'bigquery' ? 'JSON' : 'VARIANT';
  }
}
export function publicationDdl(
  columns: readonly AgenticColumn[],
  dialect: PublicationDialect
): string {
  return columns
    .map(
      (column) =>
        `${quoteIdentifier(column.name, dialect)} ${publicationType(column.type, dialect)}${column.nullable ? '' : ' NOT NULL'}`
    )
    .join(', ');
}
export function publicationTableSuffix(dialect: PublicationDialect): string {
  return dialect === 'databricks'
    ? " TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported')"
    : '';
}
/** Atomic scripts use one submission: authentication refresh cannot split a transaction. */
export function publicationTransactionSql(
  dialect: PublicationDialect,
  statements: readonly string[],
  assertion: string
): string {
  const body = statements.join(';\n');
  switch (dialect) {
    case 'postgres':
      throw new Error('PostgreSQL uses a dedicated connection transaction');
    case 'bigquery':
      return `BEGIN TRANSACTION;\n${body};\nASSERT (${assertion}) AS 'Stale publication owner or target version';\nCOMMIT TRANSACTION;`;
    case 'databricks':
      return `BEGIN ATOMIC\n${body};\nIF NOT (${assertion}) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stale publication owner or target version'; END IF;\nEND;`;
    case 'snowflake':
      return `DECLARE stale EXCEPTION (-20001, 'Stale publication owner or target version'); matches INTEGER;\nBEGIN\nBEGIN TRANSACTION;\n${body};\nmatches := (SELECT CASE WHEN (${assertion}) THEN 1 ELSE 0 END);\nIF (matches <> 1) THEN RAISE stale; END IF;\nCOMMIT;\nEXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;\nEND;`;
  }
}
export const publicationLiteral = (value: string | number, dialect: PublicationDialect) =>
  quoteLiteral(value, dialect);
