import { throwIfCancelled, type SqlQueryRunner } from '@bobsled-inc/connections';
import { quoteIdentifier, quoteLiteral, type SupportedDialect } from '@bobsled-inc/model-spec';

/** Probe a host-resolved model table. Never interpret a source request as SQL. */
export function agenticSelfTableProbe(target: string, dialect: SupportedDialect): string {
  if (!['duckdb', 'postgres', 'snowflake', 'bigquery', 'databricks'].includes(dialect)) {
    throw new Error('Unsupported agent source dialect');
  }
  if (!target || target.length > 1024 || target.endsWith('.')) {
    throw new Error('Invalid model table');
  }
  const parts: string[] = [];
  let rest = target;
  while (rest) {
    const match = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([A-Za-z_][A-Za-z0-9_-]*))(?:\.|$)/.exec(
      rest
    );
    if (!match) throw new Error('Invalid model table');
    parts.push(match[1]?.replaceAll('""', '"') ?? match[2]?.replaceAll('``', '`') ?? match[3]!);
    rest = rest.slice(match[0].length);
  }
  if (dialect === 'bigquery' && parts.length === 2) parts.splice(0, 1, ...parts[0]!.split('.'));
  if (parts.length < 2 || parts.length > (dialect === 'postgres' ? 2 : 3)) {
    throw new Error('Invalid model table');
  }
  const q = (value: string) => quoteIdentifier(value, dialect);
  const lit = (value: string) => quoteLiteral(value, dialect);
  const schema = parts.at(-2)!;
  const table = parts.at(-1)!;
  const catalog = parts.length === 3 ? parts[0] : undefined;
  const info =
    dialect === 'bigquery'
      ? `${parts.slice(0, -1).map(q).join('.')}.INFORMATION_SCHEMA`
      : catalog && dialect !== 'duckdb'
        ? `${q(catalog)}.information_schema`
        : 'information_schema';
  const condition =
    dialect === 'duckdb'
      ? `table_catalog = ${catalog ? lit(catalog) : 'current_database()'} AND lower(table_schema) = lower(${lit(schema)}) AND lower(table_name) = lower(${lit(table)})`
      : `table_schema = ${lit(schema)} AND table_name = ${lit(table)}`;
  return `SELECT table_type FROM ${info}.TABLES WHERE ${condition} LIMIT 2`;
}

export async function agenticSelfTableExists(
  query: SqlQueryRunner,
  target: string,
  dialect: SupportedDialect,
  signal: AbortSignal
): Promise<boolean> {
  throwIfCancelled(signal);
  const rows = await query(agenticSelfTableProbe(target, dialect), undefined, { signal });
  throwIfCancelled(signal);
  if (!rows.length) return false;
  const typeKey = Object.keys(rows[0]!).find((key) => key.toLowerCase() === 'table_type');
  if (
    rows.length !== 1 ||
    !typeKey ||
    !['BASE TABLE', 'MANAGED'].includes(String(rows[0]![typeKey]))
  ) {
    throw new Error('Agent self source must be a base table');
  }
  return true;
}
