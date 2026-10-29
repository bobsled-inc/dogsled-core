import type { ControlLogger } from './control.js';
import { BigQueryWarehouseClient } from './bigquery-client.js';

/**
 * Resolves the BigQuery SQL cast expression for a cursor column by reading live
 * table metadata. Called when no `cursor_type` is declared in the resource spec.
 * Returns e.g. `'CAST(? AS INT64)'` for numeric types, `'?'` for string-safe
 * types or on lookup failure (warning logged).
 *
 * This is extracted from the main extraction orchestrator to keep it within the
 * file-size budget. The caller (`warehouse-extractor.ts`) passes pre-resolved
 * dataset and table values and delegates all metadata I/O and logging here.
 */
export async function resolveBqCastExpr(
  client: BigQueryWarehouseClient,
  project: string | undefined,
  dataset: string,
  table: string,
  cursorField: string,
  logger: ControlLogger
): Promise<string> {
  const expr = await client.resolveColumnCastExpr(project, dataset, table, cursorField);
  if (expr === undefined) {
    await logger.warn(
      `BigQuery: could not determine the type of cursor column "${cursorField}" for table ` +
        `"${dataset}.${table}". Declare cursor_type explicitly in the resource spec ` +
        `(e.g. cursor_type: integer for INT64 columns).`
    );
  }
  return expr ?? '?';
}
