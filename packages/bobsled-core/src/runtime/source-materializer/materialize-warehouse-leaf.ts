/**
 * `materializeWarehouseLeaf` — the freshness-aware wrapper around the dumb
 * `stageWarehouseSourceIntoDuckDb` brick. It gives a foreign `warehouse_table`
 * leaf the same `live`/`lazy` read semantics an `api_resource` leaf already has
 * (`materializeSource`), reusing the SAME freshness engine rather than
 * rebuilding one:
 *
 *   - `live`  → always re-read the warehouse table fresh (never cached).
 *   - `lazy`  → stage once, reuse within `maxAge`, re-stage when stale, keyed by
 *               `(sourceName, filterHash)` in the generic `_bobsled_source_metadata`
 *               table. Identical reuse semantics to a lazy API source.
 *
 * Crucially, the read mode is a **per-reference call argument**, not a field on
 * the `warehouse_table` source entry: the same warehouse model can be read
 * `live` by one mixed model and `lazy` by another, so the mode rides on the
 * reference, not the shared source. (This deliberately diverges from the API
 * source model, where `mode` is global to the source.)
 *
 * The `maxRows` ceiling (the OOM safety floor) is threaded straight through to
 * the brick: every (re)stage — `live` or `lazy` — is bounded.
 */

import { performance } from 'node:perf_hooks';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import type { SourceRegistryEntry, SupportedDialect } from '@bobsled-inc/model-spec';

import { parseMaxAge } from './max-age.js';
import type { MetadataDialect } from './metadata.js';
import { DuckDBMetadataStore } from './metadata-store.js';
import { probeFreshness } from './freshness-probe.js';
import {
  liveReceipt,
  materializedReceipt,
  reusedReceipt,
  type Receipt,
  type RefreshReason,
} from './receipt.js';
import { stageWarehouseSourceIntoDuckDb } from './stage-warehouse-source.js';
import { quoteIdentifier } from './sql-utils.js';

type WarehouseEntry = Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

/** Per-reference read mode for a warehouse leaf. No `extract`: a warehouse table
 *  is always re-readable, so "use the last pull, never refresh" has no meaning. */
export type WarehouseLeafReadMode = 'live' | 'lazy';

/**
 * Default OOM safety floor for the CLI orchestrator's warehouse staging. The
 * brick buffers the whole leaf in memory, so an unbounded read can OOM the host;
 * this caps the full-copy path. It is a deliberately generous floor (dimension
 * tables — the `lazy` use case — sit far below it); a host with tighter memory
 * (e.g. a small Cloud Run instance) should pass its own `maxRows`.
 */
export const DEFAULT_WAREHOUSE_LEAF_ROW_CEILING = 1_000_000;

export interface MaterializeWarehouseLeafArgs {
  /** The resolved warehouse_table entry (carries `fqRef` + declared columns). */
  entry: WarehouseEntry;
  /** DuckDB table name to stage into (the bare source name). */
  sourceName: string;
  /** Engine source schema the staged table + metadata row live in (e.g. `sources`). */
  schema: string;
  /** Runner-backed engine destination (`createRunnerDuckDbDestination`). */
  database: DatabaseDestination;
  /** Engine runner — drives the freshness metadata store + table-existence probe. */
  engineRunner: SqlRunnerModule;
  /** Host's credentialed runner for the source warehouse the rows are read from. */
  sourceRunner: SqlRunnerModule;
  /** Dialect of the source warehouse (for the read SELECT quoting). */
  dialect: SupportedDialect;
  /** Dialect of the engine for metadata SQL. Defaults to `duckdb` (incl. DuckLake). */
  engineDialect?: MetadataDialect;
  /** Scratch dir for the JSONL hop. */
  tempDir: string;
  /** Per-reference read mode — `live` always re-reads, `lazy` reuses within `maxAge`. */
  mode: WarehouseLeafReadMode;
  /** Reuse window for `lazy` (e.g. `15m`, `1h`). Ignored for `live`. Omitted = reuse
   *  indefinitely once staged (matches a lazy API source with no `max_age`). */
  maxAge?: string;
  /** Cache key. Callers without a pushed-down predicate pass `filterHash(undefined)`;
   *  a future pushdown (Work Item B) folds the predicate into this so a subset read
   *  is never reused as if it were the full leaf. */
  currentFilterHash: string;
  /** As-of timestamp for freshness math + the metadata `loaded_at` write. */
  nowIso: string;
  /** Engine kind for the receipt `target` (`duckdb` covers DuckLake too). */
  target?: Receipt['target'];
  /** Hard row ceiling forwarded to the brick (OOM safety floor). */
  maxRows?: number;
}

/** A `Receipt`, mirroring `materializeSource`: `action: 'reused'` on a cache hit,
 *  `'live'`/`'materialized'` on a (re)stage. */
export type MaterializeWarehouseLeafResult = Receipt;

function stageRefreshReason(
  mode: WarehouseLeafReadMode,
  verdict: string,
  tableMissing = false
): RefreshReason {
  if (mode === 'live') return 'live';
  if (tableMissing) return 'table_missing';
  switch (verdict) {
    case 'missing':
      return 'first_load';
    case 'slice_changed':
      return 'filter_changed';
    case 'refresh_due':
      return 'refresh_due';
    default:
      return 'max_age';
  }
}

export async function materializeWarehouseLeaf(
  args: MaterializeWarehouseLeafArgs
): Promise<MaterializeWarehouseLeafResult> {
  const started = performance.now();
  const target = args.target ?? 'duckdb';
  const engineDialect = args.engineDialect ?? 'duckdb';
  const table = `${args.schema}.${args.sourceName}`;

  // Ensure the engine source schema exists before the freshness probe touches
  // its metadata table. The brick's destination creates this schema on stage,
  // but the probe runs first — so self-contained host callers (who haven't
  // pre-created it) would otherwise hit a missing-schema error on the read.
  await args.engineRunner.run(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(args.schema, engineDialect)}`
  );

  const store = new DuckDBMetadataStore({
    runner: args.engineRunner,
    dialect: engineDialect,
  });

  // live → maxAgeSec 0 (always stale → re-read); lazy → the window (undefined =
  // reuse indefinitely, exactly like a lazy API source with no max_age).
  const maxAgeSec = args.mode === 'live' ? 0 : parseMaxAge(args.maxAge);

  const probe = await probeFreshness({
    readRow: (readArgs) => store.read(readArgs),
    schema: args.schema,
    sourceName: args.sourceName,
    currentFilterHash: args.currentFilterHash,
    maxAgeSec,
    nowIso: args.nowIso,
    persistentMode: args.mode === 'lazy',
  });

  let tableMissing = false;
  if (probe.verdict === 'fresh') {
    const present = await store.tableExists({ schema: args.schema, table: args.sourceName });
    if (present) {
      return reusedReceipt({
        source: args.sourceName,
        target,
        table,
        filterHash: args.currentFilterHash,
        snapshotAgeSeconds: probe.ageSec,
        records: probe.recordCount,
        totalRowCount: probe.recordCount,
        durationMs: Math.round(performance.now() - started),
        snapshotKind: 'canonical',
        snapshotVariant: null,
      });
    }
    // Metadata says fresh but the staged table is gone (manual drop, fresh
    // engine) — fall through and re-stage, reported as table_missing.
    tableMissing = true;
  }

  const staged = await stageWarehouseSourceIntoDuckDb({
    entry: args.entry,
    sourceName: args.sourceName,
    schema: args.schema,
    database: args.database,
    sourceRunner: args.sourceRunner,
    dialect: args.dialect,
    tempDir: args.tempDir,
    ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
  });

  await store.write({
    schema: args.schema,
    row: {
      source_name: args.sourceName,
      filter_hash: args.currentFilterHash,
      loaded_at: args.nowIso,
      record_count: staged.rowsAffected,
      row_count: staged.rowsAffected,
      snapshot_kind: 'canonical',
      snapshot_variant: null,
    },
  });

  const receiptInput: Omit<Receipt, 'action'> = {
    source: args.sourceName,
    target,
    table,
    filterHash: args.currentFilterHash,
    snapshotAgeSeconds: 0,
    records: staged.rowsAffected,
    totalRowCount: staged.rowsAffected,
    refreshReason: stageRefreshReason(args.mode, probe.verdict, tableMissing),
    durationMs: Math.round(performance.now() - started),
    snapshotKind: 'canonical',
    snapshotVariant: null,
  };
  return args.mode === 'live' ? liveReceipt(receiptInput) : materializedReceipt(receiptInput);
}
