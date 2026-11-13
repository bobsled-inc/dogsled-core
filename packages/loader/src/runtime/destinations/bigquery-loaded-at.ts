import type { LoaderLogger } from '../logger.js';
import { quoteBqIdentifier } from './bigquery-identifiers.js';
import { SYSTEM_COLUMNS } from './database.js';
import { takeOverLoadedAtSql } from './loaded-at-takeover.js';

interface BigQueryField {
  name?: string | undefined;
  description?: string | undefined;
}

/**
 * The loaded-at takeover on BigQuery (see loaded-at-takeover.ts). Some tables refuse
 * RENAME COLUMN (search index, row access policy, partitioning on the column); the earlier
 * column is then kept and copied into the current one. The copy is marked done with the
 * earlier column's description, read from table metadata, never from the data.
 */
export function takeOverBigQueryLoadedAt<F extends BigQueryField>(args: {
  table: string;
  existing: Map<string, string>;
  runQuery(query: string): Promise<void>;
  readFields(): Promise<F[]>;
  typeOf(field: NoInfer<F>): string;
  logger?: LoaderLogger | undefined;
}): Promise<() => Promise<void>> {
  const field = async (name: string) => (await args.readFields()).find((f) => f.name === name);
  return takeOverLoadedAtSql({
    table: args.table,
    existing: args.existing,
    current: SYSTEM_COLUMNS.LOADED_AT,
    quote: quoteBqIdentifier,
    run: args.runQuery,
    reread: async () =>
      new Map((await args.readFields()).map((f) => [String(f.name), args.typeOf(f)])),
    marker: {
      done: async (from, note) => (await field(from))?.description === note,
      mark: (from, note) =>
        args.runQuery(
          `ALTER TABLE ${args.table} ALTER COLUMN ${quoteBqIdentifier(from)} SET OPTIONS (description = '${note.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}')`
        ),
    },
    logger: args.logger,
  });
}
