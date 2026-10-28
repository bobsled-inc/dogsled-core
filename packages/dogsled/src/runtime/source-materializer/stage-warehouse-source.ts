/**
 * Stage a foreign `warehouse_table` source into the shared DuckDB engine so a
 * DuckDB-engine (live/view) mixed model can read it. This is the warehouse-leaf
 * counterpart to `materializeOneSource` (which stages `api_resource` leaves):
 * read the rows from the source warehouse via its own runner, write them as
 * JSONL, and load them into `sources.<name>` in the shared DuckDB through the
 * runner-backed DuckDB destination (TRUNCATE + `read_json_auto`).
 *
 * The model compiler emits a warehouse source's *physical* table name, not
 * `sources.<name>`, so the orchestrator must additionally rewrite the source
 * registry to point the ref at the staged table (see
 * `runProjectWithLazySources`). This module only performs the data movement.
 *
 * v1 limitations: full read on every run (no incremental/cursor pushdown), the
 * SELECT projects the declared columns by name (a case-mismatched warehouse
 * column would land null), and the whole leaf is buffered in memory for the
 * JSONL hop (no streaming yet). BIGINT values are preserved precisely by writing
 * them as strings (see `jsonReplacer`) and casting on load.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import {
  quoteIdentifier,
  type SourceEntryColumn,
  type SourceRegistryEntry,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { CommandError, type SchemaColumn } from '@bobsled-inc/protocol';

import { projectColumns } from '../cross-warehouse-rows.js';

type WarehouseEntry = Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

// A warehouse `fqRef` is caller-controlled (it comes from the source YAML
// `table:` field, or directly from a host via the public API), and it is
// interpolated into `FROM <fqRef>`. Validate it is a dot-separated path of
// warehouse identifiers before use — this blocks SQL injection while leaving a
// legitimate ref byte-identical, including 1-3 segment refs and hyphenated
// BigQuery project ids (`my-project.dataset.table`). Anything with whitespace,
// quotes, semicolons, parentheses, or comment markers is rejected.
const SAFE_FQREF_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function assertSafeFqRef(fqRef: string): void {
  if (!SAFE_FQREF_PATTERN.test(fqRef)) {
    throw new CommandError(
      `Unsafe warehouse table reference "${fqRef}". A source table must be a dot-separated path of ` +
        'identifiers (letters, digits, underscores, hyphens), e.g. "schema.table" or "project.dataset.table".',
      2
    );
  }
}

export interface StageWarehouseSourceArgs {
  /** The resolved warehouse_table entry (carries `fqRef` + declared columns). */
  entry: WarehouseEntry;
  /** DuckDB table name to stage into (the bare source name). */
  sourceName: string;
  /** DuckDB schema the staged table lands in (the engine source schema). */
  schema: string;
  /** Runner-backed DuckDB destination over the shared engine file. */
  database: DatabaseDestination;
  /** Runner for the source warehouse the rows are read from. */
  sourceRunner: SqlRunnerModule;
  /** Dialect of the source warehouse (for the read SELECT quoting). */
  dialect: SupportedDialect;
  /** Scratch dir for the JSONL hop. */
  tempDir: string;
  /**
   * Optional hard row ceiling — the OOM safety floor. The brick buffers the
   * whole leaf in memory for the JSONL hop, so an unbounded warehouse table can
   * OOM the host (e.g. a Cloud Run instance). When set, the read is bounded to
   * `maxRows + 1` rows and the stage aborts with a `CommandError` if the source
   * returns more than `maxRows` — before the rows are written out — instead of
   * silently buffering an arbitrarily large result. Omitted = today's unbounded
   * full read.
   */
  maxRows?: number;
}

export interface StageWarehouseSourceResult {
  sourceName: string;
  rowsAffected: number;
}

function toSchemaColumns(columns: SourceEntryColumn[]): SchemaColumn[] {
  return columns.map((column) => ({ name: column.name, type: column.type }));
}

/**
 * JSON.stringify replacer: emit BIGINT as a STRING, not a JS number. `Number()`
 * silently corrupts values above 2^53 - 1 (large IDs / cursors), which would
 * break joins after staging. The JSONL string is cast back to the declared
 * column type (e.g. BIGINT) by `loadAndFinalize`, preserving full precision.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function stageWarehouseSourceIntoDuckDb(
  args: StageWarehouseSourceArgs
): Promise<StageWarehouseSourceResult> {
  const { entry, sourceName, schema, database, sourceRunner, dialect, tempDir, maxRows } = args;
  if (!sourceRunner.query) {
    throw new CommandError(
      `Source runner for "${entry.fqRef}" does not support query(); cannot stage it into the DuckDB engine.`,
      1
    );
  }
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 0)) {
    throw new CommandError(
      `maxRows for "${entry.fqRef}" must be a non-negative integer; got ${maxRows}.`,
      2
    );
  }
  assertSafeFqRef(entry.fqRef);

  const columns = toSchemaColumns(entry.columns);
  const columnList = columns.map((column) => quoteIdentifier(column.name, dialect)).join(', ');
  // Read one extra row past the ceiling so an over-limit table is detectable
  // before it is buffered/written. LIMIT is portable across duckdb/snowflake/bigquery.
  const limitClause = maxRows === undefined ? '' : ` LIMIT ${maxRows + 1}`;
  const rows = (await sourceRunner.query(
    `SELECT ${columnList} FROM ${entry.fqRef}${limitClause}`
  )) as Record<string, unknown>[];
  if (maxRows !== undefined && rows.length > maxRows) {
    throw new CommandError(
      `Warehouse source "${entry.fqRef}" exceeds the staging row ceiling of ${maxRows} rows. ` +
        'Staging buffers the whole leaf in memory, so it is capped to protect the host from OOM. ' +
        'Read this leaf in "live" mode with predicate pushdown, narrow it upstream, or raise the ceiling.',
      1
    );
  }

  await mkdir(tempDir, { recursive: true });
  const jsonlPath = join(tempDir, `xwh-duck-stage-${sourceName}.jsonl`);
  // projectColumns does a case-insensitive row-key lookup (warehouses like
  // Snowflake return UPPERCASE keys) and normalizes JSON values, matching the
  // warehouse-to-warehouse staging path.
  const body = rows
    .map((row) => JSON.stringify(projectColumns(row, columns), jsonReplacer))
    .join('\n');
  await writeFile(jsonlPath, body, 'utf8');

  await database.ensureTable(schema, sourceName, columns);
  const { rowsAffected } = await database.loadAndFinalize(
    schema,
    sourceName,
    jsonlPath,
    columns,
    'full_refresh',
    [],
    { format: 'jsonl' }
  );

  return { sourceName, rowsAffected };
}
