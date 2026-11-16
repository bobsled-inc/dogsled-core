import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import type { SourceRegistryEntry } from '@bobsled-inc/model-spec';
import {
  queryResource as defaultQueryResource,
  resolveCursorKind,
  type QueryFilterInput,
  type QueryFilterValue,
  type QueryRateLimitInfo,
  type QueryResourceOptions,
  type QueryResourceResult,
  type QueryValue,
  type CursorKind,
} from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { CommandError, type LoadStrategy, type SchemaColumn } from '@bobsled-inc/protocol';

import {
  resolveSourceMaterializerFlags,
  type SourceMaterializerFeatureFlags,
} from './feature-flags.js';
import { probeFreshness } from './freshness-probe.js';
import { runIncrementalRefresh, type IncrementalFallbackReason } from './incremental-refresh.js';
import { sourceNameOf } from './load-specs.js';
import { parseMaxAge } from './max-age.js';
import type { CursorType, MetadataRow, SnapshotKind } from './metadata.js';
import { dedupeByKey, maxCursorInRecords } from './record-helpers.js';
import type { MetadataLeaseResult } from './metadata-store.js';
import { materializePartial } from './partial-snapshot.js';
import { withRefreshLease } from './refresh-lease.js';
import {
  coalescedReceipt as buildCoalescedReceipt,
  liveReceipt,
  materializedReceipt,
  reusedReceipt,
  type Receipt,
  type RefreshReason,
} from './receipt.js';
import { snapshotKey } from './snapshot-key.js';
import { withScratchTable } from './scratch-table.js';
import { escapeLiteral, type SqlDialect, quoteIdentifier, tableRef } from './sql-utils.js';

export type { Receipt, ReceiptAction, RefreshReason } from './receipt.js';
export { formatReceipt } from './receipt-format.js';

export interface MaterializeSourceArgs {
  entry: Extract<SourceRegistryEntry, { kind: 'api_resource' }>;
  nowIso: string;
  tempRootDir: string;
  target: Receipt['target'];
  schema: string;
  table: string;
  canonicalTable?: string;
  destination: DatabaseDestination;
  destinationScopeKey?: string;
  readRow: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
  }) => Promise<MetadataRow | undefined>;
  tableExists?: (args: { schema: string; table: string }) => Promise<boolean>;
  upsertRow: (args: { schema: string; row: MetadataRow }) => Promise<void>;
  beginRefresh?: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
  }) => Promise<MetadataLeaseResult>;
  finishRefresh?: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
    inProgressUntil?: string;
  }) => Promise<void>;
  currentFilterHash: string;
  queryResourceImpl?: typeof defaultQueryResource;
  integrationSpecLoader?: typeof loadQueryableResourceSpecs;
  featureFlags?: Partial<SourceMaterializerFeatureFlags>;
  runner?: SqlRunnerModule;
  dialect?: SqlDialect;
  queryLimit?: number;
  /**
   * Optional secret map forwarded to `queryResource()` so the API transport
   * resolves auth from injected secrets instead of `process.env`. Undefined
   * preserves the default process-env behavior.
   */
  secrets?: Record<string, string | undefined>;
}

const inFlightMaterializations = new Map<string, Promise<Receipt>>();

type LoadedQuerySpecs = NonNullable<ReturnType<typeof loadQueryableResourceSpecs>>;

const LOADER_SYSTEM_COLUMNS: SchemaColumn[] = [
  { name: '_time_extracted', type: 'timestamp' },
  { name: '_bobsled_loaded_at', type: 'timestamp' },
];

interface FetchRecordsResult {
  records: Array<Record<string, unknown>>;
  requestCount: number;
  etag?: string;
  notModified: boolean;
  rateLimit?: QueryRateLimitInfo;
}

interface RefreshConfig {
  loadStrategy: LoadStrategy;
  keyProperties: string[];
  cursorField?: string;
  cursorType?: CursorType;
}

interface SourceRefreshSpec {
  strategy: LoadStrategy;
  cursor_field?: string;
  primary_key?: string | string[];
}

interface PriorRefreshMetadata {
  recordCount: number;
  etag?: string;
  cursorField?: string;
  cursorValue?: string;
}

async function writeJsonl(path: string, records: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path, 'utf8');
  for (const record of records) {
    const ok = stream.write(JSON.stringify(record) + '\n');
    if (!ok) await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function loadQuerySpecs(args: MaterializeSourceArgs): LoadedQuerySpecs {
  const specLoader = args.integrationSpecLoader ?? loadQueryableResourceSpecs;
  const loaded = specLoader(args.entry.integration, args.entry.resource);
  if (!loaded) {
    throw new CommandError(
      `Resource "${args.entry.integration}.${args.entry.resource}" has no query surface. Add a query: block to the resource YAML.`,
      2
    );
  }
  return loaded;
}

function cursorTypeFromOutputField(outputType: unknown): CursorKind | undefined {
  switch (outputType) {
    case 'timestamp':
      return 'timestamp';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return undefined;
  }
}

function sourceRefreshSpec(
  entry: Extract<SourceRegistryEntry, { kind: 'api_resource' }>
): SourceRefreshSpec | undefined {
  const value = (entry as { refresh?: unknown }).refresh;
  if (!value || typeof value !== 'object') return undefined;
  const refresh = value as Partial<SourceRefreshSpec>;
  return refresh.strategy === 'merge' ||
    refresh.strategy === 'append' ||
    refresh.strategy === 'full_refresh'
    ? {
        strategy: refresh.strategy,
        ...(typeof refresh.cursor_field === 'string' ? { cursor_field: refresh.cursor_field } : {}),
        ...(typeof refresh.primary_key === 'string' || Array.isArray(refresh.primary_key)
          ? { primary_key: refresh.primary_key }
          : {}),
      }
    : undefined;
}

function primaryKeyList(value: string | string[] | undefined): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return undefined;
}

function refreshConfigFor(
  args: MaterializeSourceArgs,
  loaded: LoadedQuerySpecs,
  hintValue?: string
): RefreshConfig {
  const extract = loaded.resource.extract;
  const table = extract?.table;
  const sourceRefresh = sourceRefreshSpec(args.entry);
  const loadStrategy =
    sourceRefresh?.strategy ??
    (table?.load_strategy === 'merge' || table?.load_strategy === 'append'
      ? table.load_strategy
      : 'full_refresh');
  const keyProperties =
    primaryKeyList(sourceRefresh?.primary_key) ??
    table?.primary_key ??
    (args.entry.columns.some((column) => column.name === 'id') ? ['id'] : []);
  const cursorField =
    loadStrategy === 'full_refresh'
      ? undefined
      : (sourceRefresh?.cursor_field ?? extract?.incremental?.cursor_field);
  const cursorOutput = cursorField ? loaded.resource.output?.[cursorField] : undefined;
  const cursorType = cursorField
    ? (resolveCursorKind({
        specCursorType: cursorTypeFromOutputField(cursorOutput?.type),
        hintValue,
      }) as CursorType | undefined)
    : undefined;

  return {
    loadStrategy,
    keyProperties,
    ...(cursorField !== undefined ? { cursorField } : {}),
    ...(cursorType !== undefined ? { cursorType } : {}),
  };
}

function managedColumnsFor(args: MaterializeSourceArgs): SchemaColumn[] {
  if (args.target === 'bigquery' || args.target === 'snowflake') {
    return [...args.entry.columns, ...LOADER_SYSTEM_COLUMNS];
  }
  return args.entry.columns as SchemaColumn[];
}

function timestampLiteral(value: string, dialect: SqlDialect): string {
  const escaped = escapeLiteral(value);
  return dialect === 'bigquery' ? `TIMESTAMP('${escaped}')` : `TIMESTAMP '${escaped}'`;
}

async function readTableRowCount(args: MaterializeSourceArgs): Promise<number | undefined> {
  if (!args.runner?.query) return undefined;
  const rows = (await args.runner.query(
    `SELECT COUNT(*) AS c FROM ${tableRef(args.schema, args.table, args.dialect ?? 'duckdb')}`
  )) as Array<{ c?: number | bigint }>;
  const value = rows[0]?.c;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return undefined;
}

async function queryRecords(
  args: MaterializeSourceArgs,
  loaded: LoadedQuerySpecs,
  sourceName: string,
  options: Pick<QueryResourceOptions, 'etag' | 'filter' | 'limit'> = {}
): Promise<FetchRecordsResult> {
  const queryImpl = args.queryResourceImpl ?? defaultQueryResource;
  const baseFilter = args.entry.filter as QueryFilterInput | undefined;
  const filter =
    options.filter === undefined ? baseFilter : mergeQueryFilters(baseFilter, options.filter);
  try {
    const result = await queryImpl({
      integration: loaded.integration,
      resource: loaded.resource,
      filter,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.etag !== undefined ? { etag: options.etag } : {}),
      ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
    });
    return {
      records: result.records as Array<Record<string, unknown>>,
      requestCount: result.requestCount ?? 0,
      ...(result.etag !== undefined ? { etag: result.etag } : {}),
      notModified: result.notModified === true,
      ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
    };
  } catch (error) {
    if (isProviderThrottleError(error)) {
      throw new CommandError(
        `Upstream provider rate-limited "${sourceName}" while querying ${args.entry.integration}.${args.entry.resource}; retry later: ${error instanceof Error ? error.message : String(error)}`,
        1
      );
    }
    throw error;
  }
}

function mergeQueryFilters(
  baseFilter: QueryFilterInput | undefined,
  extraFilter: QueryFilterInput
): QueryFilterInput {
  if (baseFilter === undefined) {
    return extraFilter;
  }

  const merged: QueryFilterInput = { ...baseFilter };
  for (const [fieldName, extraValue] of Object.entries(extraFilter)) {
    const baseValue = merged[fieldName];
    merged[fieldName] =
      baseValue === undefined ? extraValue : mergeQueryFilterValues(baseValue, extraValue);
  }
  return merged;
}

function mergeQueryFilterValues(
  baseValue: QueryFilterValue,
  extraValue: QueryFilterValue
): QueryFilterValue {
  if (isQueryScalarValue(baseValue) && isQueryScalarValue(extraValue)) {
    return extraValue;
  }

  return Object.fromEntries(
    Object.entries({
      ...normalizeQueryFilterValue(baseValue),
      ...normalizeQueryFilterValue(extraValue),
    }).map(([operator, value]) => [`$${operator}`, value])
  );
}

function normalizeQueryFilterValue(value: QueryFilterValue): Record<string, QueryValue> {
  if (isQueryScalarValue(value)) {
    return { eq: value };
  }

  return Object.fromEntries(
    Object.entries(value).map(([operator, operatorValue]) => [
      operator.startsWith('$') ? operator.slice(1) : operator,
      operatorValue,
    ])
  );
}

function isQueryScalarValue(value: QueryFilterValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isProviderThrottleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:429|rate\s*limit|too many requests|throttl(?:ed|ing))\b/i.test(message);
}

async function invalidatePartialVariants(
  args: MaterializeSourceArgs,
  sourceName: string
): Promise<void> {
  if (!args.runner || !args.dialect || args.target === 'in_memory' || args.schema === 'temp') {
    return;
  }
  await args.runner.run(
    `UPDATE ${tableRef(args.schema, '_bobsled_source_metadata', args.dialect)} SET loaded_at = ${timestampLiteral(
      '1970-01-01T00:00:00.000Z',
      args.dialect
    )} WHERE source_name = '${escapeLiteral(sourceName)}' AND filter_hash = '${escapeLiteral(
      args.currentFilterHash
    )}' AND snapshot_kind = 'limited'`
  );
}

function inFlightKey(
  args: MaterializeSourceArgs,
  sourceName: string,
  snapshotVariant: string | null = null,
  priorCursorValue?: string
): string {
  return [
    args.destinationScopeKey ?? 'default',
    args.target,
    args.schema,
    args.table,
    sourceName,
    args.entry.integration,
    args.entry.resource,
    args.currentFilterHash,
    snapshotVariant ?? 'canonical',
    priorCursorValue ?? '',
  ].join('\0');
}

function coalescedReceipt(receipt: Receipt, started: number): Receipt {
  return buildCoalescedReceipt(receipt, Math.round(performance.now() - started));
}

function fallbackRefreshReason(reason: IncrementalFallbackReason): RefreshReason {
  switch (reason) {
    case 'cursor_regression':
      return 'incremental_fallback_cursor_regression';
    case 'missing_keys':
      return 'incremental_fallback_missing_keys';
    case 'null_cursor':
      return 'incremental_fallback_null_cursor';
    case 'schema_drift':
      return 'incremental_fallback_schema_drift';
  }
}

function incrementalRefreshReason(
  entryMode: MaterializeSourceArgs['entry']['mode'],
  loadStrategy: RefreshConfig['loadStrategy']
): RefreshReason {
  if (entryMode === 'live') return 'live';
  return loadStrategy === 'append' ? 'incremental_append' : 'incremental_merge';
}

function materializeMiss(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  refreshReason: RefreshReason,
  priorMetadata?: PriorRefreshMetadata,
  mode: 'full' | 'incremental' = 'full'
): Promise<Receipt> {
  const flags = resolveSourceMaterializerFlags(args.featureFlags);
  // Injected secrets change the auth context, but the in-flight key does not
  // capture them — coalescing across different secret maps could return one
  // caller's data to another. Skip coalescing whenever secrets are injected.
  if (!flags.inFlightDedup || args.secrets !== undefined) {
    return withRefreshLease({
      context: args,
      sourceName,
      operation: () =>
        mode === 'incremental'
          ? materializeIncrementalMiss(args, sourceName, started, priorMetadata)
          : materializeFreshMiss(args, sourceName, started, refreshReason, priorMetadata),
      retry: () => materializeSource(args),
    });
  }

  const key = inFlightKey(args, sourceName, null, priorMetadata?.cursorValue);
  const existing = inFlightMaterializations.get(key);
  if (existing) {
    return existing.then((receipt) => coalescedReceipt(receipt, started));
  }

  const promise =
    mode === 'incremental'
      ? withRefreshLease({
          context: args,
          sourceName,
          operation: () => materializeIncrementalMiss(args, sourceName, started, priorMetadata),
          retry: () => {
            inFlightMaterializations.delete(key);
            return materializeSource(args);
          },
        })
      : withRefreshLease({
          context: args,
          sourceName,
          operation: () =>
            materializeFreshMiss(args, sourceName, started, refreshReason, priorMetadata),
          retry: () => {
            inFlightMaterializations.delete(key);
            return materializeSource(args);
          },
        });
  inFlightMaterializations.set(key, promise);
  void promise.then(
    () => {
      inFlightMaterializations.delete(key);
    },
    () => {
      inFlightMaterializations.delete(key);
    }
  );
  return promise;
}

export async function materializeSource(args: MaterializeSourceArgs): Promise<Receipt> {
  const started = performance.now();
  const sourceName = sourceNameOf(args.entry);
  const flags = resolveSourceMaterializerFlags(args.featureFlags);
  const mode = args.entry.mode ?? 'lazy';

  if (args.queryLimit !== undefined && flags.partialMaterialization && mode === 'lazy') {
    return materializePartialSource(args, sourceName, started, args.queryLimit);
  }

  const maxAgeSec =
    mode === 'live' ? 0 : mode === 'extract' ? undefined : parseMaxAge(args.entry.maxAge);

  const probe = await probeFreshness({
    readRow: args.readRow,
    schema: args.schema,
    sourceName,
    currentFilterHash: args.currentFilterHash,
    maxAgeSec,
    nowIso: args.nowIso,
    incrementalEnabled: flags.incrementalRefresh,
    persistentMode: mode === 'lazy',
  });

  if (mode === 'extract' && probe.verdict === 'missing') {
    const tablePresent =
      args.tableExists === undefined
        ? false
        : await args.tableExists({ schema: args.schema, table: args.table });
    if (tablePresent) {
      const recordCount = (await readTableRowCount(args)) ?? 0;
      return reusedReceipt({
        source: sourceName,
        target: args.target,
        table: `${args.schema}.${args.table}`,
        filterHash: args.currentFilterHash,
        snapshotAgeSeconds: 0,
        records: recordCount,
        totalRowCount: recordCount,
        durationMs: Math.round(performance.now() - started),
        snapshotKind: 'canonical',
        snapshotVariant: null,
      });
    }
  }

  if (probe.verdict === 'fresh') {
    const tablePresent =
      args.tableExists === undefined
        ? true
        : await args.tableExists({ schema: args.schema, table: args.table });
    if (!tablePresent) {
      if (mode === 'extract') {
        throw new CommandError(
          `source "${sourceName}" is mode: extract but table ${args.schema}.${args.table} is missing; run dogsled pipeline before querying it.`,
          1
        );
      }
      return materializeMiss(args, sourceName, started, 'table_missing');
    }

    const receiptInput: Omit<Receipt, 'action'> = {
      source: sourceName,
      target: args.target,
      table: `${args.schema}.${args.table}`,
      filterHash: args.currentFilterHash,
      snapshotAgeSeconds: probe.ageSec,
      records: probe.recordCount,
      totalRowCount: probe.recordCount,
      durationMs: Math.round(performance.now() - started),
      snapshotKind: 'canonical',
      snapshotVariant: null,
    };
    return mode === 'live' ? liveReceipt(receiptInput) : reusedReceipt(receiptInput);
  }

  if (mode === 'extract') {
    throw new CommandError(
      `source "${sourceName}" is mode: extract but has not been extracted for this query; run dogsled pipeline before querying it.`,
      1
    );
  }

  if (probe.verdict === 'incremental_eligible') {
    return materializeMiss(
      args,
      sourceName,
      started,
      'incremental_merge',
      {
        recordCount: probe.recordCount,
        cursorField: probe.cursorField,
        cursorValue: probe.cursorValue,
      },
      'incremental'
    );
  }

  const reason =
    probe.verdict === 'missing'
      ? 'first_load'
      : probe.verdict === 'slice_changed'
        ? 'filter_changed'
        : probe.verdict === 'refresh_due'
          ? 'refresh_due'
          : 'max_age';
  const priorRow =
    probe.verdict === 'aged_out' || probe.verdict === 'refresh_due'
      ? await args.readRow({
          schema: args.schema,
          sourceName,
          filterHash: args.currentFilterHash,
        })
      : undefined;
  return materializeMiss(
    args,
    sourceName,
    started,
    reason,
    probe.verdict === 'aged_out' || probe.verdict === 'refresh_due'
      ? {
          recordCount: probe.recordCount,
          ...(probe.etag !== undefined ? { etag: probe.etag } : {}),
          ...(priorRow?.cursor_field !== undefined ? { cursorField: priorRow.cursor_field } : {}),
          ...(priorRow?.cursor_value !== undefined ? { cursorValue: priorRow.cursor_value } : {}),
        }
      : undefined
  );
}

async function materializePartialSource(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  limit: number
): Promise<Receipt> {
  const snapshot = snapshotKey({ filterHash: args.currentFilterHash, limit });
  const maxAgeSec = parseMaxAge(args.entry.maxAge) ?? 3600;

  const probe = await probeFreshness({
    readRow: async ({ schema, sourceName: probedSourceName, filterHash }) =>
      args.readRow({
        schema,
        sourceName: probedSourceName,
        filterHash,
        snapshotKind: snapshot.snapshotKind,
        snapshotVariant: snapshot.snapshotVariant,
      }),
    schema: args.schema,
    sourceName,
    currentFilterHash: args.currentFilterHash,
    maxAgeSec,
    nowIso: args.nowIso,
    incrementalEnabled: false,
  });

  if (probe.verdict === 'fresh') {
    const tablePresent =
      args.tableExists === undefined
        ? true
        : await args.tableExists({ schema: args.schema, table: args.table });
    if (tablePresent) {
      return reusedReceipt({
        source: sourceName,
        target: args.target,
        table: `${args.schema}.${args.table}`,
        filterHash: args.currentFilterHash,
        snapshotAgeSeconds: probe.ageSec,
        records: probe.recordCount,
        totalRowCount: probe.recordCount,
        refreshReason: 'partial_reuse',
        durationMs: Math.round(performance.now() - started),
        snapshotKind: snapshot.snapshotKind,
        snapshotVariant: snapshot.snapshotVariant,
      });
    }
  }

  const flags = resolveSourceMaterializerFlags(args.featureFlags);
  // See materializeMiss: injected secrets must not coalesce across credentials.
  if (!flags.inFlightDedup || args.secrets !== undefined) {
    return materializePartialMissWithLease(args, sourceName, started, limit);
  }

  const key = inFlightKey(args, sourceName, snapshot.snapshotVariant);
  const existing = inFlightMaterializations.get(key);
  if (existing) {
    return existing.then((receipt) => coalescedReceipt(receipt, started));
  }

  const promise = materializePartialMissWithLease(args, sourceName, started, limit);
  inFlightMaterializations.set(key, promise);
  void promise.then(
    () => {
      inFlightMaterializations.delete(key);
    },
    () => {
      inFlightMaterializations.delete(key);
    }
  );
  return promise;
}

function materializePartialMissWithLease(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  limit: number
): Promise<Receipt> {
  const snapshot = snapshotKey({ filterHash: args.currentFilterHash, limit });
  return withRefreshLease({
    context: {
      ...args,
      snapshotKind: snapshot.snapshotKind,
      snapshotVariant: snapshot.snapshotVariant,
    },
    sourceName,
    operation: () => materializePartialMiss(args, sourceName, started, limit),
    retry: () => materializeSource(args),
  });
}

async function materializePartialMiss(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  limit: number
): Promise<Receipt> {
  const snapshot = snapshotKey({ filterHash: args.currentFilterHash, limit });
  const loaded = loadQuerySpecs(args);
  const refreshConfig = refreshConfigFor(args, loaded);
  const jsonlPath = join(args.tempRootDir, `${args.schema}.${args.table}.${Date.now()}.jsonl`);
  let rateLimit: QueryRateLimitInfo | undefined;
  let rowsAffected = 0;

  try {
    const partialResult = await materializePartial({
      integration: loaded.integration,
      resource: loaded.resource,
      limit,
      queryResourceImpl: async (options) => {
        const result = await queryRecords(args, loaded, sourceName, { limit: options.limit });
        rateLimit = result.rateLimit ?? rateLimit;
        return {
          records: result.records,
          limitReached: false,
          requestCount: result.requestCount,
          ...(result.etag !== undefined ? { etag: result.etag } : {}),
          ...(result.notModified ? { notModified: true } : {}),
          ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
        } as QueryResourceResult<Record<string, unknown>>;
      },
      writePartialImpl: async (records) => {
        await writeJsonl(jsonlPath, records);
        await args.destination.initialize();
        await args.destination.ensureTable(args.schema, args.table, args.entry.columns, {
          keyProperties: refreshConfig.keyProperties,
        });
        const result = await args.destination.loadAndFinalize(
          args.schema,
          args.table,
          jsonlPath,
          args.entry.columns,
          'full_refresh',
          refreshConfig.keyProperties
        );
        rowsAffected = result.rowsAffected;
      },
    });

    const recordCount = rowsAffected || partialResult.recordCount;
    await args.upsertRow({
      schema: args.schema,
      row: {
        source_name: sourceName,
        filter_hash: args.currentFilterHash,
        loaded_at: args.nowIso,
        record_count: recordCount,
        snapshot_kind: snapshot.snapshotKind,
        snapshot_variant: snapshot.snapshotVariant,
        row_count: recordCount,
      },
    });

    return materializedReceipt({
      source: sourceName,
      target: args.target,
      table: `${args.schema}.${args.table}`,
      filterHash: args.currentFilterHash,
      snapshotAgeSeconds: 0,
      records: recordCount,
      totalRowCount: recordCount,
      refreshReason: 'partial_rebuild',
      durationMs: Math.round(performance.now() - started),
      ...(rateLimit?.remaining !== undefined ? { rateBudgetRemaining: rateLimit.remaining } : {}),
      ...(rateLimit?.limit !== undefined ? { rateBudgetLimit: rateLimit.limit } : {}),
      snapshotKind: snapshot.snapshotKind,
      snapshotVariant: snapshot.snapshotVariant,
    });
  } finally {
    await unlinkIfPresent(jsonlPath);
  }
}

async function mergeFromScratch(
  args: MaterializeSourceArgs,
  scratchTable: { qualifiedName: string },
  keyProperties: string[],
  columnNames: string[]
): Promise<void> {
  if (!args.runner || !args.dialect) {
    throw new CommandError('incremental refresh requires a SQL runner and dialect', 1);
  }

  const targetRef = tableRef(args.schema, args.table, args.dialect);
  const onClause = keyProperties
    .map(
      (key) => `t.${quoteIdentifier(key, args.dialect)} = s.${quoteIdentifier(key, args.dialect)}`
    )
    .join(' AND ');
  const updateSet = columnNames
    .filter((column) => !keyProperties.includes(column))
    .map(
      // DuckDB MERGE rejects the target-table alias inside UPDATE SET assignments.
      (column) =>
        `${args.dialect === 'duckdb' ? quoteIdentifier(column, args.dialect) : `t.${quoteIdentifier(column, args.dialect)}`} = s.${quoteIdentifier(column, args.dialect)}`
    )
    .join(', ');
  const insertColumns = columnNames
    .map((column) => quoteIdentifier(column, args.dialect))
    .join(', ');
  const insertValues = columnNames
    .map((column) => `s.${quoteIdentifier(column, args.dialect)}`)
    .join(', ');

  const mergeSql = updateSet
    ? `${args.dialect === 'bigquery' ? 'MERGE' : 'MERGE INTO'} ${targetRef} AS t USING ${scratchTable.qualifiedName} AS s ON ${onClause} ` +
      `WHEN MATCHED THEN UPDATE SET ${updateSet} ` +
      `WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues})`
    : `${args.dialect === 'bigquery' ? 'MERGE' : 'MERGE INTO'} ${targetRef} AS t USING ${scratchTable.qualifiedName} AS s ON ${onClause} ` +
      `WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues})`;

  await args.runner.run(mergeSql);
}

async function mergeDeltaThroughScratch(
  args: MaterializeSourceArgs,
  deltaRecords: Array<Record<string, unknown>>,
  keyProperties: string[]
): Promise<void> {
  if (!args.runner || !args.dialect) {
    throw new CommandError('incremental refresh requires a SQL runner and dialect', 1);
  }

  const jsonlPath = join(
    args.tempRootDir,
    `${args.schema}.${args.table}.delta.${Date.now()}.jsonl`
  );
  try {
    await writeJsonl(jsonlPath, deltaRecords);
    await args.destination.initialize();
    await withScratchTable(
      {
        runner: args.runner,
        dialect: args.dialect,
        schema: args.schema,
        baseName: args.table,
        ttlSeconds: 900,
        columns: managedColumnsFor(args),
      },
      async (scratchTable) => {
        await args.destination.loadAndFinalize(
          scratchTable.schemaName,
          scratchTable.tableName,
          jsonlPath,
          args.entry.columns,
          'full_refresh',
          keyProperties
        );
        await mergeFromScratch(
          args,
          scratchTable,
          keyProperties,
          managedColumnsFor(args).map((column) => column.name)
        );
      }
    );
  } finally {
    await unlinkIfPresent(jsonlPath);
  }
}

async function appendDelta(
  args: MaterializeSourceArgs,
  deltaRecords: Array<Record<string, unknown>>
): Promise<void> {
  const jsonlPath = join(
    args.tempRootDir,
    `${args.schema}.${args.table}.delta.${Date.now()}.jsonl`
  );
  try {
    await writeJsonl(jsonlPath, deltaRecords);
    await args.destination.initialize();
    await args.destination.ensureTable(args.schema, args.table, args.entry.columns, {
      keyProperties: [],
    });
    await args.destination.loadAndFinalize(
      args.schema,
      args.table,
      jsonlPath,
      args.entry.columns,
      'append',
      []
    );
  } finally {
    await unlinkIfPresent(jsonlPath);
  }
}

async function materializeIncrementalMiss(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  priorMetadata?: PriorRefreshMetadata
): Promise<Receipt> {
  if (!priorMetadata?.cursorField || !priorMetadata.cursorValue) {
    return materializeFreshMiss(
      args,
      sourceName,
      started,
      'incremental_fallback_schema_drift',
      priorMetadata
    );
  }

  const loaded = loadQuerySpecs(args);
  const refreshConfig = refreshConfigFor(args, loaded, priorMetadata.cursorValue);
  if (
    (refreshConfig.loadStrategy !== 'merge' && refreshConfig.loadStrategy !== 'append') ||
    refreshConfig.cursorField !== priorMetadata.cursorField ||
    !refreshConfig.cursorType
  ) {
    return materializeFreshMiss(
      args,
      sourceName,
      started,
      'incremental_fallback_schema_drift',
      priorMetadata
    );
  }

  let rateLimit: QueryRateLimitInfo | undefined;
  const incrementalResult = await runIncrementalRefresh({
    strategy: refreshConfig.loadStrategy,
    integration: loaded.integration,
    resource: loaded.resource,
    priorCursorValue: priorMetadata.cursorValue,
    cursorField: priorMetadata.cursorField,
    cursorType: refreshConfig.cursorType,
    keyProperties: refreshConfig.keyProperties,
    queryResourceImpl: async (options) => {
      const result = await queryRecords(args, loaded, sourceName, {
        filter: options.filter as QueryFilterInput | undefined,
      });
      rateLimit = result.rateLimit ?? rateLimit;
      return {
        records: result.records,
        limitReached: false,
        requestCount: result.requestCount,
        ...(result.etag !== undefined ? { etag: result.etag } : {}),
        ...(result.rateLimit !== undefined ? { rateLimit: result.rateLimit } : {}),
      } as QueryResourceResult<Record<string, unknown>>;
    },
    mergeImpl: async (records) => {
      await mergeDeltaThroughScratch(args, records, refreshConfig.keyProperties);
    },
    appendImpl: async (records) => {
      await appendDelta(args, records);
    },
  });

  if (incrementalResult.outcome === 'fallback') {
    return materializeFreshMiss(
      args,
      sourceName,
      started,
      fallbackRefreshReason(incrementalResult.fallbackReason ?? 'schema_drift'),
      priorMetadata
    );
  }

  const totalRowCount =
    incrementalResult.outcome === 'zero_delta'
      ? priorMetadata.recordCount
      : ((await readTableRowCount(args)) ??
        priorMetadata.recordCount + incrementalResult.deltaRowCount);
  const cursorValue =
    incrementalResult.outcome === 'zero_delta'
      ? priorMetadata.cursorValue
      : incrementalResult.newCursorValue;

  await args.upsertRow({
    schema: args.schema,
    row: {
      source_name: sourceName,
      filter_hash: args.currentFilterHash,
      loaded_at: args.nowIso,
      record_count: totalRowCount,
      cursor_field: priorMetadata.cursorField,
      cursor_type: refreshConfig.cursorType,
      ...(cursorValue !== undefined ? { cursor_value: cursorValue } : {}),
      snapshot_kind: 'canonical',
      snapshot_variant: null,
      row_count: totalRowCount,
    },
  });
  await invalidatePartialVariants(args, sourceName);

  const receiptInput: Omit<Receipt, 'action'> = {
    source: sourceName,
    target: args.target,
    table: `${args.schema}.${args.table}`,
    filterHash: args.currentFilterHash,
    snapshotAgeSeconds: 0,
    records: totalRowCount,
    totalRowCount,
    refreshReason: incrementalRefreshReason(args.entry.mode, refreshConfig.loadStrategy),
    durationMs: Math.round(performance.now() - started),
    ...(rateLimit?.remaining !== undefined ? { rateBudgetRemaining: rateLimit.remaining } : {}),
    ...(rateLimit?.limit !== undefined ? { rateBudgetLimit: rateLimit.limit } : {}),
    ...(cursorValue !== undefined ? { cursorValue } : {}),
    deltaRowCount: incrementalResult.deltaRowCount,
    snapshotKind: 'canonical',
    snapshotVariant: null,
  };
  if (args.entry.mode === 'live') return liveReceipt(receiptInput);
  return incrementalResult.outcome === 'zero_delta'
    ? reusedReceipt(receiptInput)
    : materializedReceipt(receiptInput);
}

async function materializeFreshMiss(
  args: MaterializeSourceArgs,
  sourceName: string,
  started: number,
  refreshReason: RefreshReason,
  priorMetadata?: PriorRefreshMetadata
): Promise<Receipt> {
  const loaded = loadQuerySpecs(args);
  const refreshConfig = refreshConfigFor(args, loaded, priorMetadata?.cursorValue);

  let fetched = await queryRecords(args, loaded, sourceName, { etag: priorMetadata?.etag });
  if (fetched.notModified && priorMetadata) {
    const tablePresent =
      args.tableExists === undefined
        ? true
        : await args.tableExists({ schema: args.schema, table: args.table });
    if (!tablePresent) {
      fetched = await queryRecords(args, loaded, sourceName);
    } else {
      await args.upsertRow({
        schema: args.schema,
        row: {
          source_name: sourceName,
          filter_hash: args.currentFilterHash,
          loaded_at: args.nowIso,
          record_count: priorMetadata.recordCount,
          ...(fetched.etag !== undefined || priorMetadata.etag !== undefined
            ? { etag: fetched.etag ?? priorMetadata.etag }
            : {}),
          ...(priorMetadata.cursorField !== undefined
            ? { cursor_field: priorMetadata.cursorField }
            : {}),
          ...(refreshConfig.cursorType !== undefined
            ? { cursor_type: refreshConfig.cursorType }
            : {}),
          ...(priorMetadata.cursorValue !== undefined
            ? { cursor_value: priorMetadata.cursorValue }
            : {}),
          snapshot_kind: 'canonical',
          snapshot_variant: null,
          row_count: priorMetadata.recordCount,
        },
      });
      await invalidatePartialVariants(args, sourceName);

      const receiptInput: Omit<Receipt, 'action'> = {
        source: sourceName,
        target: args.target,
        table: `${args.schema}.${args.table}`,
        filterHash: args.currentFilterHash,
        snapshotAgeSeconds: 0,
        records: priorMetadata.recordCount,
        totalRowCount: priorMetadata.recordCount,
        refreshReason,
        durationMs: Math.round(performance.now() - started),
        etagHit: true,
        ...(fetched.rateLimit?.remaining !== undefined
          ? { rateBudgetRemaining: fetched.rateLimit.remaining }
          : {}),
        ...(fetched.rateLimit?.limit !== undefined
          ? { rateBudgetLimit: fetched.rateLimit.limit }
          : {}),
        ...(priorMetadata.cursorValue !== undefined
          ? { cursorValue: priorMetadata.cursorValue }
          : {}),
        snapshotKind: 'canonical',
        snapshotVariant: null,
      };
      return args.entry.mode === 'live' ? liveReceipt(receiptInput) : reusedReceipt(receiptInput);
    }
  }

  // Live queries land via full_refresh, which never dedups; collapse duplicate
  // primary keys (e.g. from paginating over a mutable sort key) so a live query
  // never returns two rows with the same key. See dedupeByKey.
  let records: Array<Record<string, unknown>> | undefined =
    args.entry.mode === 'live'
      ? dedupeByKey(fetched.records, refreshConfig.keyProperties)
      : fetched.records;
  const cursorValue = maxCursorInRecords(
    records,
    refreshConfig.cursorField,
    refreshConfig.cursorType
  );
  const jsonlPath = join(args.tempRootDir, `${args.schema}.${args.table}.${Date.now()}.jsonl`);
  try {
    await writeJsonl(jsonlPath, records);
    records = undefined;

    await args.destination.initialize();
    await args.destination.ensureTable(args.schema, args.table, args.entry.columns, {
      keyProperties: refreshConfig.keyProperties,
      ...(refreshConfig.cursorField !== undefined
        ? { cursorField: refreshConfig.cursorField }
        : {}),
    });
    const result = await args.destination.loadAndFinalize(
      args.schema,
      args.table,
      jsonlPath,
      args.entry.columns,
      'full_refresh',
      refreshConfig.keyProperties
    );

    await args.upsertRow({
      schema: args.schema,
      row: {
        source_name: sourceName,
        filter_hash: args.currentFilterHash,
        loaded_at: args.nowIso,
        record_count: result.rowsAffected,
        ...(fetched.etag !== undefined ? { etag: fetched.etag } : {}),
        ...(refreshConfig.cursorField !== undefined
          ? { cursor_field: refreshConfig.cursorField }
          : {}),
        ...(refreshConfig.cursorType !== undefined
          ? { cursor_type: refreshConfig.cursorType }
          : {}),
        ...(cursorValue !== undefined ? { cursor_value: cursorValue } : {}),
        snapshot_kind: 'canonical',
        snapshot_variant: null,
        row_count: result.rowsAffected,
      },
    });
    await invalidatePartialVariants(args, sourceName);

    const receiptInput: Omit<Receipt, 'action'> = {
      source: sourceName,
      target: args.target,
      table: `${args.schema}.${args.table}`,
      filterHash: args.currentFilterHash,
      snapshotAgeSeconds: 0,
      records: result.rowsAffected,
      totalRowCount: result.rowsAffected,
      refreshReason,
      durationMs: Math.round(performance.now() - started),
      ...(fetched.rateLimit?.remaining !== undefined
        ? { rateBudgetRemaining: fetched.rateLimit.remaining }
        : {}),
      ...(fetched.rateLimit?.limit !== undefined
        ? { rateBudgetLimit: fetched.rateLimit.limit }
        : {}),
      ...(fetched.etag !== undefined ? { etagHit: false } : {}),
      ...(cursorValue !== undefined ? { cursorValue } : {}),
      snapshotKind: 'canonical',
      snapshotVariant: null,
    };
    return args.entry.mode === 'live'
      ? liveReceipt(receiptInput)
      : materializedReceipt(receiptInput);
  } finally {
    await unlinkIfPresent(jsonlPath);
  }
}
