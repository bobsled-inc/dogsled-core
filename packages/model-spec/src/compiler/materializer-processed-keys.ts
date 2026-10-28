/** Shared SQL for replacing the output of explicitly processed keys. */
import { quoteIdentifier } from './dialect.js';
import type { SupportedDialect } from './dialect.js';

export interface ProcessedKeySqlOptions {
  /** Already quoted relation references, produced by the compiler or host. */
  target: string;
  processedKeys: string;
  columns: readonly string[];
  /** Non-null keys. The caller must validate key values before execution. */
  keys: readonly string[];
  dialect: SupportedDialect;
}

function columnList(columns: readonly string[], dialect: SupportedDialect, alias?: string): string {
  if (
    columns.length === 0 ||
    new Set(columns.map((name) => quoteIdentifier(name, dialect))).size !== columns.length
  ) {
    throw new Error('Replacement columns must be non-empty and distinct');
  }
  return columns
    .map((name) => `${alias ? `${alias}.` : ''}${quoteIdentifier(name, dialect)}`)
    .join(', ');
}

/** Keep rows for keys that this run did not process, including duplicate output rows. */
export function generateUnprocessedRowsSql(options: ProcessedKeySqlOptions): string {
  const { target, processedKeys, columns, keys, dialect } = options;
  if (
    keys.length === 0 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !columns.includes(key))
  ) {
    throw new Error('Replacement keys must be non-empty, distinct output columns');
  }
  const projection = columnList(columns, dialect, '__old');
  const predicate = keys
    .map((key) => {
      const name = quoteIdentifier(key, dialect);
      return `__old.${name} = __processed.${name}`;
    })
    .join(' AND ');
  return `SELECT ${projection} FROM ${target} AS __old WHERE NOT EXISTS (SELECT 1 FROM ${processedKeys} AS __processed WHERE ${predicate})`;
}

/** acceptedRows must contain only validated rows whose keys belong to processedKeys. */
export function generateProcessedKeyReplacementSql(
  options: ProcessedKeySqlOptions & { acceptedRows: string }
): string {
  return `${generateUnprocessedRowsSql(options)}\nUNION ALL\nSELECT ${columnList(options.columns, options.dialect)} FROM ${options.acceptedRows}`;
}

/** Apply a full validated stage. The caller owns the transaction and commit receipt. */
export function generateStageReplacementDml(options: {
  target: string;
  stage: string;
  columns: readonly string[];
  dialect: SupportedDialect;
}): string[] {
  const columns = columnList(options.columns, options.dialect);
  return [
    `DELETE FROM ${options.target} WHERE TRUE`,
    `INSERT INTO ${options.target} (${columns}) SELECT ${columns} FROM ${options.stage}`,
  ];
}
