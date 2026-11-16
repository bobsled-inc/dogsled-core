import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import { queryResource as defaultQueryResource } from '@bobsled-inc/extractor';
import { loadQueryableResourceSpecs } from '@bobsled-inc/integrations';
import { createDefaultDatabaseDestination } from '@bobsled-inc/loader';
import { CommandError } from '@bobsled-inc/protocol';
import type { SchemaColumn } from '@bobsled-inc/protocol';

import {
  resolveDestinationFor,
  type ResolvedDestination,
} from './source-materializer/destination-resolver.js';
import { isMissingTableError, quoteIdentifier, tableRef } from './source-materializer/sql-utils.js';
import { filterHash } from './source-materializer/filter-hash.js';
import { ensureMetadataTable } from './source-materializer/metadata.js';
import { formatReceipt, type Receipt } from './source-materializer/materializer.js';
import { materializeOneSource } from './source-materializer/materialize-one-source.js';
import {
  resolveSourceMaterializerFlags,
  type SourceMaterializerFeatureFlags,
} from './source-materializer/feature-flags.js';
import {
  loadApiResourceEntries,
  sourceNameOf,
  type ApiResourceEntry,
} from './source-materializer/load-specs.js';
import { createRunnerDuckDbDestination } from './source-materializer/runner-duckdb-destination.js';
import { withScratchTable } from './source-materializer/scratch-table.js';
import {
  applySourceFilterParams,
  type SourceFilterParamValue,
  type SourceFilterRuntimeContext,
} from './source-materializer/filter-params.js';
import {
  applySqlWherePushdown,
  isPartialMaterializationEligible,
  type PartialMaterializationEligibility,
} from './source-materializer/sql-pushdown.js';
import { createSqlRunnerFor } from './source-materializer/sql-runner-bridge.js';
import { partialTableName } from './source-materializer/partial-snapshot.js';
import { localStateDir } from '@bobsled-inc/connections';

export interface RunQueryArgs {
  projectRoot: string;
  sql: string;
  queryResourceImpl?: typeof defaultQueryResource;
  integrationSpecLoader?: typeof loadQueryableResourceSpecs;
  onReceipt?: (line: string) => void;
  nowIso?: string;
  resolveDestinationImpl?: typeof resolveDestinationFor;
  createSqlRunnerImpl?: typeof createSqlRunnerFor;
  sourceFilterParams?: SourceFilterRuntimeContext | Record<string, SourceFilterParamValue>;
  featureFlags?: Partial<SourceMaterializerFeatureFlags>;
  /**
   * Optional in-memory source entries. When provided they are used instead of
   * loading the project's `type: source` files from `projectRoot`, so library
   * callers can drive the engine without source YAML on disk. Defaults to disk
   * loading.
   */
  apiResourceEntries?: ApiResourceEntry[];
  /**
   * Optional injected default destination, forwarded to the destination
   * resolver to bypass `.dogsled/config.yml`. Defaults to the on-disk read.
   */
  defaultDestination?: { dest: string } & Record<string, unknown>;
  /**
   * Optional secret map forwarded to API source materialization so the
   * extractor resolves transport auth from injected secrets instead of
   * `process.env`. Defaults to process-env behavior.
   */
  secrets?: Record<string, string | undefined>;
}

export interface RunQueryResult {
  rows: Array<Record<string, unknown>>;
  receipts: string[];
  totalMs: number;
}

const BOBSLED_CORE_QUERY_MAX_SQL_LIMIT = 10_000;
const inFlightQueries = new Map<string, Promise<RunQueryResult>>();

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripSqlStringLiterals(sql: string): string {
  // DuckDB only uses single-quoted string literals — double-quoted names are
  // identifiers and backticks are not valid. Replace single-quoted runs with
  // equal-length whitespace so downstream token offsets stay aligned.
  return sql.replace(/'(?:[^']|'')*'/g, (match) => ' '.repeat(match.length));
}

export function maxSqlLimitLiteral(sql: string): number | undefined {
  // Only count LIMITs at the outermost paren depth — nested subqueries/CTEs do
  // not constrain the returned result, so including them would reject valid SQL.
  const stripped = stripSqlComments(stripSqlStringLiterals(sql));
  const scanner = /[()]|\blimit\s+(?:(\d+)|all)\b/gi;
  let depth = 0;
  let maxLimit: number | undefined;
  let hit: RegExpExecArray | null;
  while ((hit = scanner.exec(stripped)) !== null) {
    const token = hit[0];
    if (token === '(') {
      depth += 1;
      continue;
    }
    if (token === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const literal = hit[1];
    if (!literal) {
      // LIMIT ALL — treat as unbounded
      return Infinity;
    }
    const value = Number(literal);
    if (!Number.isSafeInteger(value)) {
      throw new CommandError(
        `SQL LIMIT "${literal}" is not a safe integer; reduce the limit below 2^53.`,
        2
      );
    }
    maxLimit = maxLimit === undefined ? value : Math.max(maxLimit, value);
  }
  return maxLimit;
}

const SOURCE_REFERENCE_RE =
  /(?:"sources"|sources)\s*\.\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/iy;

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

export function maskSqlIgnoredSegments(sql: string): string {
  let out = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += ' '.repeat(index - start);
      continue;
    }

    if (char === '"' || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += ' '.repeat(index - start);
      continue;
    }

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function hasUserSourcesNamespace(sql: string): boolean {
  const code = maskSqlIgnoredSegments(sql);
  if (/(?:\bWITH\b\s+(?:RECURSIVE\s+)?|,\s*)sources\s+AS\s*\(/i.test(code)) {
    return true;
  }
  if (/\b(?:FROM|JOIN)\b\s*\([^;]*\)\s+(?:AS\s+)?sources\b/i.test(code)) {
    return true;
  }
  return /\b(?:FROM|JOIN)\b\s+(?!sources\s*\.)(?:[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+(?:AS\s+)?sources\b/i.test(
    code
  );
}

function transformSourceReferences(
  sql: string,
  transform: (token: string, name: string) => string | undefined
): string {
  if (hasUserSourcesNamespace(sql)) {
    throw new CommandError(
      'SQL uses "sources" as a CTE/table alias, but "sources" is reserved for Dogsled source references. Rename the alias before running dogsled query.',
      2
    );
  }

  let out = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (!isIdentifierChar(sql[index - 1])) {
      SOURCE_REFERENCE_RE.lastIndex = index;
      const match = SOURCE_REFERENCE_RE.exec(sql);
      if (match?.index === index) {
        const token = match[0];
        const name = match[1] ?? match[2];
        out += name ? (transform(token, name) ?? token) : token;
        index = SOURCE_REFERENCE_RE.lastIndex;
        continue;
      }
    }

    if (char === "'") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += sql.slice(start, index);
      continue;
    }

    if (char === '"' || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += sql.slice(start, index);
      continue;
    }

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

export function referencedSources(sql: string): Set<string> {
  const out = new Set<string>();
  transformSourceReferences(sql, (_token, name) => {
    out.add(name);
    return undefined;
  });
  return out;
}

function serializeSqlRunner(runner: SqlRunnerModule): SqlRunnerModule {
  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const serialized: SqlRunnerModule = {
    run: (sql) => enqueue(() => runner.run(sql)),
    close: async () => {
      await queue;
      await runner.close?.();
    },
  };
  if (runner.query) {
    const query = runner.query;
    serialized.query = (sql) => enqueue(() => query(sql));
  }
  return serialized;
}

function destinationIdentity(destination: ResolvedDestination): string {
  const config = destination.config;
  if (config.dest === 'duckdb') return `duckdb:${config.dbPath}`;
  if (config.dest === 'ducklake') return `ducklake:${config.catalogUrl}`;
  if (config.dest === 'bigquery') return `bigquery:${config.projectId ?? ''}`;
  if (config.dest === 'snowflake') return `snowflake:${config.account}:${config.database}`;
  return `${destination.kind}:${destination.sqlRunnerKind}`;
}

function quotePhysicalRef(destination: ResolvedDestination): string {
  return tableRef(destination.schema, destination.table, destination.sqlRunnerKind);
}

function rewriteLogicalSources(sql: string, byName: Map<string, ResolvedDestination>): string {
  return transformSourceReferences(sql, (token, name) => {
    const destination = byName.get(name);
    return destination ? quotePhysicalRef(destination) : token;
  });
}

function coalescedQueryResult(result: RunQueryResult): RunQueryResult {
  return {
    ...result,
    receipts: result.receipts.map((line) =>
      /\baction=\w+\b/.test(line)
        ? line.replace(/\baction=\w+\b/, 'action=coalesced')
        : `${line} action=coalesced`
    ),
  };
}

function inFlightQueryKey(args: {
  projectRoot: string;
  sql: string;
  destinations: ResolvedDestination[];
  currentFilterHashes: string[];
  featureFlags: Partial<SourceMaterializerFeatureFlags>;
}): string {
  return JSON.stringify({
    projectRoot: args.projectRoot,
    sql: args.sql,
    destinations: args.destinations.map((destination) => ({
      kind: destination.kind,
      schema: destination.schema,
      table: destination.table,
      identity: destinationIdentity(destination),
    })),
    currentFilterHashes: args.currentFilterHashes,
    featureFlags: resolveSourceMaterializerFlags(args.featureFlags),
  });
}

async function queryRows(
  runner: SqlRunnerModule,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  if (!runner.query) {
    throw new CommandError('Resolved SQL runner does not support query execution', 1);
  }
  return runner.query(sql);
}

async function physicalTableExists(
  runner: SqlRunnerModule,
  destination: ResolvedDestination
): Promise<boolean> {
  if (!runner.query) {
    throw new CommandError('Resolved SQL runner does not support query execution', 1);
  }

  try {
    await runner.query(`SELECT 1 FROM ${quotePhysicalRef(destination)} LIMIT 0`);
    return true;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

export { isMissingTableError } from './source-materializer/sql-utils.js';

async function createDestinationFor(
  destination: ResolvedDestination,
  runner: SqlRunnerModule,
  tempDir: string,
  options: { temporary?: boolean } = {}
) {
  if (destination.sqlRunnerKind === 'duckdb') {
    return createRunnerDuckDbDestination(runner, { temporary: options.temporary === true });
  }
  return createDefaultDatabaseDestination(destination.config, { tempDir });
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function identityForMixedDestination(destination: ResolvedDestination): string | undefined {
  return destination.kind === 'in_memory' ? undefined : destinationIdentity(destination);
}

function transientLiveDestination(
  destination: ResolvedDestination,
  index: number
): ResolvedDestination {
  const suffix = randomUUID().replace(/-/g, '_');
  const table = `__dogsled_live_${destination.table}_${index}_${suffix}`;
  return {
    kind: 'in_memory',
    schema: 'temp',
    table,
    fullyQualified: `temp.${table}`,
    sqlRunnerKind: 'duckdb',
    config: {
      dest: 'duckdb',
      dbPath: ':memory:',
      targetSchema: 'temp',
      bufferSize: 100_000,
      logFormat: 'json',
      maxConcurrentLoads: 1,
    },
  };
}

export async function withMixedModeScratchTables<T>(args: {
  entries: ApiResourceEntry[];
  destinations: ResolvedDestination[];
  representative: ResolvedDestination;
  runner: SqlRunnerModule;
  body: (destinations: ResolvedDestination[]) => Promise<T>;
}): Promise<T> {
  // Mixed-mode queries keep persisted snapshots in-place and stage live API
  // sources into short-lived warehouse scratch tables so the final join runs on
  // one engine and cleanup happens immediately after query execution.
  const liveIndexes = args.entries.flatMap((entry, index) =>
    entry.mode === 'live' ? [index] : []
  );

  const recurse = async (
    cursor: number,
    currentDestinations: ResolvedDestination[]
  ): Promise<T> => {
    if (cursor >= liveIndexes.length) {
      return args.body(currentDestinations);
    }

    const index = liveIndexes[cursor];
    if (index === undefined) {
      return args.body(currentDestinations);
    }
    const entry = args.entries[index];
    if (!entry) {
      return recurse(cursor + 1, currentDestinations);
    }

    return withScratchTable(
      {
        runner: args.runner,
        dialect: args.representative.sqlRunnerKind,
        schema: args.representative.schema,
        baseName: `__dogsled_live_${args.representative.table}_${index}`,
        ttlSeconds: 900,
        columns: entry.columns as SchemaColumn[],
      },
      async (scratch) => {
        const nextDestinations = [...currentDestinations];
        nextDestinations[index] = {
          ...args.representative,
          schema: scratch.schemaName,
          table: scratch.tableName,
          fullyQualified: `${scratch.schemaName}.${scratch.tableName}`,
        };
        return recurse(cursor + 1, nextDestinations);
      }
    );
  };

  return recurse(0, args.destinations);
}

function isTransientLiveDestination(
  entry: ApiResourceEntry,
  destination: ResolvedDestination
): boolean {
  return (
    entry.mode === 'live' &&
    ((destination.kind === 'in_memory' && destination.schema === 'temp') ||
      destination.table.startsWith('__dogsled_live_'))
  );
}

function hasDeclaredFilter(entry: ApiResourceEntry): boolean {
  return entry.filter !== undefined && Object.keys(entry.filter).length > 0;
}

function destinationForFilterSlice(
  destination: ResolvedDestination,
  entry: ApiResourceEntry,
  currentFilterHash: string
): ResolvedDestination {
  if (destination.kind === 'in_memory' || !hasDeclaredFilter(entry)) return destination;
  const table = `${destination.table}__${currentFilterHash}`;
  return {
    ...destination,
    table,
    fullyQualified: `${destination.schema}.${table}`,
  };
}

export async function runQueryCommand(args: RunQueryArgs): Promise<RunQueryResult> {
  // `dogsled query` is the ad-hoc SQL escape hatch. Session context belongs to
  // saved artifacts (`dogsled vq run`) where runtime scope is part of the
  // artifact contract, so do not add `--session` here.
  const started = Date.now();
  const nowIso = args.nowIso ?? new Date().toISOString();
  const referenced = referencedSources(args.sql);
  const sqlLimit = maxSqlLimitLiteral(args.sql);

  if (sqlLimit !== undefined && sqlLimit > BOBSLED_CORE_QUERY_MAX_SQL_LIMIT) {
    const limitDescription = sqlLimit === Infinity ? 'LIMIT ALL (unbounded)' : `LIMIT ${sqlLimit}`;
    throw new CommandError(
      `SQL ${limitDescription} exceeds dogsled query's lazy API materialization ceiling of ${BOBSLED_CORE_QUERY_MAX_SQL_LIMIT}. Use a numeric LIMIT ≤ ${BOBSLED_CORE_QUERY_MAX_SQL_LIMIT} or add a more selective source.filter.`,
      2
    );
  }

  if (referenced.size === 0) {
    throw new CommandError(
      'query references no sources.*; "dogsled query" is for sources.* reads',
      2
    );
  }

  const entries = args.apiResourceEntries ?? (await loadApiResourceEntries(args.projectRoot));
  // loadApiResourceEntries() rejects duplicate source names on the disk path;
  // enforce the same invariant for injected entries so a later duplicate cannot
  // silently shadow an earlier one when entryByName is built.
  const seenSourceNames = new Set<string>();
  for (const entry of entries) {
    const name = sourceNameOf(entry);
    if (seenSourceNames.has(name)) {
      throw new CommandError(
        `Duplicate api_resource source name "${name}" in apiResourceEntries; source names must be unique.`,
        2
      );
    }
    seenSourceNames.add(name);
  }
  const entryByName = new Map(entries.map((entry) => [sourceNameOf(entry), entry] as const));
  const selectedEntries: ApiResourceEntry[] = [];
  for (const name of referenced) {
    const entry = entryByName.get(name);
    if (!entry) throw new CommandError(`unknown source "${name}" referenced in SQL`, 2);
    selectedEntries.push(entry);
  }
  const parameterizedEntries = applySourceFilterParams(selectedEntries, args.sourceFilterParams);
  const materializationEntries = applySqlWherePushdown({
    sql: args.sql,
    entries: parameterizedEntries,
    integrationSpecLoader: args.integrationSpecLoader,
  });
  // Partial materialization names the cache table `<source>__limit_<N>` for an
  // eligible `SELECT ... LIMIT N`, splitting the cache per distinct limit. That
  // only pays off when the feature also stores a reduced N-row slice — i.e. when
  // the flag is enabled. With it disabled the materializer writes the FULL fetch
  // regardless, so a limit-named table is just a redundant full copy no other
  // query shape can reuse. Gate eligibility on the flag so a disabled run always
  // uses the canonical per-source table (the LIMIT is applied at read time).
  const materializerFlags = resolveSourceMaterializerFlags(args.featureFlags);
  const partialEligibility: PartialMaterializationEligibility =
    materializerFlags.partialMaterialization
      ? isPartialMaterializationEligible({
          sql: args.sql,
          entries: materializationEntries,
          integrationSpecLoader: args.integrationSpecLoader,
        })
      : { eligible: false, reason: 'partial_materialization_disabled' };
  const currentFilterHashes = materializationEntries.map((entry) =>
    filterHash(entry.filter, {
      nowIso,
      maxAge: entry.maxAge,
    })
  );

  const resolveDestinationImpl = args.resolveDestinationImpl ?? resolveDestinationFor;
  let destinations = await Promise.all(
    materializationEntries.map(async (entry, index) =>
      destinationForFilterSlice(
        await resolveDestinationImpl({
          entry,
          projectRoot: args.projectRoot,
          ...(args.defaultDestination !== undefined
            ? { defaultDestination: args.defaultDestination }
            : {}),
        }),
        entry,
        currentFilterHashes[index]!
      )
    )
  );
  const canonicalTableBySource = new Map<string, string>();
  if (partialEligibility.eligible && partialEligibility.sourceName) {
    destinations = destinations.map((destination, index) => {
      const entry = materializationEntries[index];
      if (
        !entry ||
        sourceNameOf(entry) !== partialEligibility.sourceName ||
        destination.kind === 'in_memory' ||
        entry.mode === 'live'
      ) {
        return destination;
      }

      canonicalTableBySource.set(partialEligibility.sourceName!, destination.table);
      const table = partialTableName(destination.table, partialEligibility.limit!);
      return {
        ...destination,
        table,
        fullyQualified: `${destination.schema}.${table}`,
      };
    });
  }

  const anyLive = destinations.some((destination) => destination.kind === 'in_memory');
  const persistedDestinationIdentities = new Set(
    destinations.map(identityForMixedDestination).filter(isDefined)
  );
  const mixedLiveAndPersisted = anyLive && persistedDestinationIdentities.size > 0;

  // MIXED_SOURCE_TARGET_CHECK: keep source-contract follow-up docs anchored to this guard.
  if (persistedDestinationIdentities.size > 1) {
    throw new CommandError(
      `sources resolve to multiple physical targets (${[...persistedDestinationIdentities].join(
        ', '
      )}); v1 requires one target per query`,
      2
    );
  }

  const representative =
    (mixedLiveAndPersisted
      ? destinations.find((destination) => destination.kind !== 'in_memory')
      : destinations[0]) ?? destinations[0];
  if (!representative) throw new CommandError('No sources selected for query', 2);
  if (mixedLiveAndPersisted && representative.sqlRunnerKind === 'duckdb') {
    destinations = destinations.map((destination, index) =>
      destination.kind === 'in_memory' ? transientLiveDestination(destination, index) : destination
    );
  }

  const createSqlRunnerImpl = args.createSqlRunnerImpl ?? createSqlRunnerFor;

  const runMaterializedQuery = async (): Promise<RunQueryResult> => {
    const runner = serializeSqlRunner(await createSqlRunnerImpl({ destination: representative }));
    const receipts: string[] = [];
    const tempDir = join(localStateDir(args.projectRoot), 'tmp');
    await mkdir(tempDir, { recursive: true });

    try {
      const schemas = new Map<string, ResolvedDestination>();
      for (const destination of destinations) schemas.set(destination.schema, destination);
      for (const destination of schemas.values()) {
        if (destination.schema === 'temp') continue;
        await runner.run(
          `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(destination.schema, destination.sqlRunnerKind)}`
        );
        await ensureMetadataTable({
          runner,
          schema: destination.schema,
          dialect: destination.sqlRunnerKind,
          // Each query opens a new connection: the takeover is settled per warehouse instead.
          destination: destinationIdentity(destination),
        });
      }

      const executeMaterializedQuery = async (
        activeDestinations: ResolvedDestination[]
      ): Promise<RunQueryResult> => {
        const transientTables: ResolvedDestination[] = [];
        try {
          const materializations = await Promise.all(
            materializationEntries.map(async (entry, index): Promise<Receipt | undefined> => {
              const destination = activeDestinations[index];
              if (!entry || !destination) {
                return undefined;
              }

              const isTransientLive = isTransientLiveDestination(entry, destination);
              if (isTransientLive) transientTables.push(destination);
              const database = await createDestinationFor(destination, runner, tempDir, {
                temporary: isTransientLive,
              });

              try {
                const currentFilterHash = currentFilterHashes[index]!;
                const sourceName = sourceNameOf(entry);
                const queryLimit =
                  partialEligibility.eligible && partialEligibility.sourceName === sourceName
                    ? partialEligibility.limit
                    : undefined;
                const receipt = await materializeOneSource({
                  entry,
                  destination,
                  database,
                  runner,
                  nowIso,
                  tempDir,
                  currentFilterHash,
                  isTransientLive,
                  ...(queryLimit !== undefined ? { queryLimit } : {}),
                  ...(canonicalTableBySource.has(sourceName)
                    ? { canonicalTable: canonicalTableBySource.get(sourceName)! }
                    : {}),
                  ...(args.queryResourceImpl !== undefined
                    ? { queryResourceImpl: args.queryResourceImpl }
                    : {}),
                  ...(args.integrationSpecLoader !== undefined
                    ? { integrationSpecLoader: args.integrationSpecLoader }
                    : {}),
                  ...(args.featureFlags !== undefined ? { featureFlags: args.featureFlags } : {}),
                  ...(args.secrets !== undefined ? { secrets: args.secrets } : {}),
                  physicalTableExists: ({ schema, table }) =>
                    physicalTableExists(runner, {
                      ...destination,
                      schema,
                      table,
                      fullyQualified: `${schema}.${table}`,
                    }),
                  destinationIdentity,
                });
                return receipt;
              } finally {
                await database.close();
              }
            })
          );
          for (const materialization of materializations) {
            if (!materialization) continue;
            const line = formatReceipt(materialization);
            receipts.push(line);
            args.onReceipt?.(line);
          }

          const destinationByName = new Map<string, ResolvedDestination>();
          for (let index = 0; index < materializationEntries.length; index += 1) {
            const entry = materializationEntries[index];
            const destination = activeDestinations[index];
            const name = entry ? sourceNameOf(entry) : undefined;
            if (name && destination) destinationByName.set(name, destination);
          }
          const physicalSql = rewriteLogicalSources(args.sql, destinationByName);
          const rows = await queryRows(runner, physicalSql);
          return { rows, receipts, totalMs: Date.now() - started };
        } finally {
          await Promise.all(
            transientTables.map((destination) =>
              runner.run(`DROP TABLE IF EXISTS ${quotePhysicalRef(destination)}`).catch(() => {})
            )
          );
        }
      };

      if (mixedLiveAndPersisted && representative.sqlRunnerKind !== 'duckdb') {
        return await withMixedModeScratchTables({
          entries: materializationEntries,
          destinations,
          representative,
          runner,
          body: executeMaterializedQuery,
        });
      }

      return await executeMaterializedQuery(destinations);
    } finally {
      await runner.close?.();
    }
  };

  const flags = resolveSourceMaterializerFlags(args.featureFlags);
  // The in-flight query key is derived from projectRoot/sql/destinations/filter
  // hashes only — it does not capture request-scoped library injections. Two
  // concurrent calls with the same SQL but different secrets, injected entries,
  // or injected destination would otherwise coalesce and return one caller's
  // result to the other. Skip coalescing whenever any such override is present.
  const hasRequestScopedOverrides =
    args.secrets !== undefined ||
    args.apiResourceEntries !== undefined ||
    args.defaultDestination !== undefined;
  if (!flags.inFlightDedup || hasRequestScopedOverrides) {
    return runMaterializedQuery();
  }

  const key = inFlightQueryKey({
    projectRoot: args.projectRoot,
    sql: args.sql,
    destinations,
    currentFilterHashes,
    featureFlags: args.featureFlags ?? {},
  });
  const existing = inFlightQueries.get(key);
  if (existing) {
    const result = coalescedQueryResult(await existing);
    for (const line of result.receipts) args.onReceipt?.(line);
    return result;
  }

  const promise = runMaterializedQuery();
  inFlightQueries.set(key, promise);
  void promise.then(
    () => {
      inFlightQueries.delete(key);
    },
    () => {
      inFlightQueries.delete(key);
    }
  );
  return promise;
}

export type LazyQueryEngineDeps = Omit<RunQueryArgs, 'sql'>;

export class LazyQueryEngine {
  constructor(private readonly deps: LazyQueryEngineDeps) {}

  runQuery(sql: string, opts: Partial<LazyQueryEngineDeps> = {}): Promise<RunQueryResult> {
    return runQueryCommand({
      ...this.deps,
      ...opts,
      sql,
    });
  }
}
