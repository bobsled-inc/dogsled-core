import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Readable, Writable } from 'node:stream';
import type { Command } from 'commander';

import type { DuckDbWriter } from '../runtime/duckdb-writer.js';
import { readProtocol } from '../runtime/protocol-reader.js';
import { PendingReplacements } from '../runtime/replace-scope.js';
import { RecordBuffer, MemoryTracker } from '../runtime/record-buffer.js';
import { CheckpointManager } from '../runtime/checkpoint.js';
import {
  type LoaderConfig,
  type FileDestConfig,
  type BigQueryDestConfig,
} from '../schemas/config.js';
import { CommandError, parsePositiveInt } from '@bobsled-inc/protocol';
import { parseSnowflakeWorkloadIdentityToken } from './run-cli.js';
import {
  createDefaultDatabaseDestination,
  isDatabaseDestConfig,
  type DatabaseDestConfig,
} from './run-database-destination.js';
import { createLogger } from '../runtime/logger.js';
import { handleRunError } from './run-errors.js';
import {
  createStreamLoadStrategyOption,
  createStreamSchemaBehaviorOption,
  createStreamTableOwnershipMarkerOption,
  createStreamTableOption,
  collectReconcileSchema,
  resolveStreamDestinationOverrides,
  validateDistinctStreamTables,
} from './stream-overrides.js';
import { runDryRun } from './run-dry-run.js';
import {
  assertReconcileSchemaDestination,
  assertReconcileSchemaStreamsFound,
  buildEnsureTableOptions,
  prepareReconcileSchemaMessage,
  requestedReconcileSchema,
  resolveReconcileSchemaStreams,
  resolveRunConfig,
  resolveRunOptions,
  resolveDryRunOptions,
} from './run-reconciliation.js';

import type { FileDestination } from '../runtime/destinations/types.js';
import { sanitizeSchemaName, sanitizeTableName } from '../runtime/destinations/database.js';
import type { DatabaseDestination, LoadResult } from '../runtime/destinations/database.js';
import type {
  BatchEncoding,
  SchemaMessage,
  LoadStrategy,
  SchemaBehavior,
} from '@bobsled-inc/protocol';
import {
  buildTempFileName,
  createLimiter,
  formatDatabaseError,
  parseMemorySize,
  supportsNativeParquetLoad,
} from './run-helpers.js';
export { parseMemorySize } from './run-helpers.js';
import {
  DEFAULT_JSONL_ENCODING,
  fileUriToPath,
  runFileLoader,
  writeLine,
} from './run-file-loader.js';
export { runFileLoader } from './run-file-loader.js';

export interface RunLoaderDependencies {
  createDestination?: (config: FileDestConfig) => FileDestination;
  createDuckDbWriter?: () => Promise<DuckDbWriter>;
  createDatabaseDestination?: (config: DatabaseDestConfig) => DatabaseDestination;
  input?: Readable;
  stderr?: Writable;
  stdout?: Writable;
  tempRootDir?: string;
  /** Trusted per-run Snowflake query metadata supplied by a programmatic host. */
  queryTag?: string;
}

export interface PublishedFile {
  destinationPath: string;
  stream: string;
  uri: string;
}

export interface RunLoaderResult {
  publishedFiles: PublishedFile[];
  statesForwarded: number;
}

export interface RunDatabaseLoaderResult {
  streamsLoaded: Map<string, number>;
  statesForwarded: number;
}

type RunHandler = (config: LoaderConfig, dependencies?: RunLoaderDependencies) => Promise<unknown>;

function getTargetSchema(rawConfig: DatabaseDestConfig): string {
  switch (rawConfig.dest) {
    case 'duckdb':
    case 'ducklake':
    case 'sqlite':
      return rawConfig.targetSchema;
    case 'bigquery':
      return rawConfig.datasetId;
    case 'snowflake':
      return rawConfig.targetSchema;
    case 'postgres':
    case 'databricks':
    case 'mssql':
    case 'pgvector':
      return rawConfig.schema;
    case 'mysql':
    case 'clickhouse':
      return rawConfig.database;
    case 'elasticsearch':
    case 'turbopuffer':
      return 'default';
    case 'chroma':
      return rawConfig.tenant ?? 'default';
    default: {
      const _exhaustive: never = rawConfig;
      throw new Error(`Unsupported database destination: ${_exhaustive}`);
    }
  }
}

export async function runDatabaseLoader(
  rawConfig: DatabaseDestConfig,
  dependencies: RunLoaderDependencies = {}
): Promise<RunDatabaseLoaderResult> {
  const reconcileSchemaStreams = resolveReconcileSchemaStreams(rawConfig);
  const input = dependencies.input ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const logger = createLogger(stderr, rawConfig.logFormat);

  const providedTempRoot = dependencies.tempRootDir ? path.resolve(dependencies.tempRootDir) : null;

  if (providedTempRoot) {
    await fs.mkdir(providedTempRoot, { recursive: true });
  }

  const ownedTempDir = await fs.mkdtemp(
    path.join(providedTempRoot ?? os.tmpdir(), 'dogsled-loader-')
  );

  const destination =
    dependencies.createDatabaseDestination?.(rawConfig) ??
    (await createDefaultDatabaseDestination(rawConfig, {
      tempDir: ownedTempDir,
      logger,
      queryTag: dependencies.queryTag,
    }));

  const bufferRootDir = path.join(ownedTempDir, 'buffer');
  const normalizedBatchRootDir = path.join(ownedTempDir, 'normalized-batch');
  await fs.mkdir(bufferRootDir, { recursive: true });
  await fs.mkdir(normalizedBatchRootDir, { recursive: true });

  const schemas = new Map<string, SchemaMessage['schema']>();
  const keyProperties = new Map<string, string[]>();
  const streamStrategies = new Map<string, LoadStrategy>();
  // Final destination table -> original protocol stream. Load execution is
  // keyed by table, but structured progress must retain the source identity so
  // Dogsled can attribute rows when `table:` replaces the normal prefix.
  const sourceStreams = new Map<string, string>();
  const seenReconcileSchemaStreams = new Set<string>();
  const buffers = new Map<string, RecordBuffer>();
  const streamsWithData = new Set<string>();
  const streamsLoaded = new Map<string, number>();
  const loadJobCounts = new Map<string, number>();
  let normalizedBatchIndex = 0;
  let statesForwarded = 0;

  let maxConcurrentLoads = rawConfig.maxConcurrentLoads ?? 1;
  if (
    rawConfig.dest === 'snowflake' &&
    (rawConfig.authenticator === 'OAUTH' ||
      rawConfig.accessToken !== undefined ||
      rawConfig.tokenCommand !== undefined) &&
    maxConcurrentLoads > 1
  ) {
    logger.warn(
      `Snowflake OAUTH forces maxConcurrentLoads=1 (was ${maxConcurrentLoads}) to avoid closing an in-flight connection during mid-run token refresh.`
    );
    maxConcurrentLoads = 1;
  }
  const limiter = createLimiter(maxConcurrentLoads);
  const pendingLoads = new Map<string, Promise<void>[]>();

  // Checkpointing support
  const checkpointManager = rawConfig.checkpointDir
    ? new CheckpointManager(rawConfig.checkpointDir)
    : null;

  // Memory tracking support
  const memoryTracker = rawConfig.maxBufferMemory
    ? new MemoryTracker(parseMemorySize(rawConfig.maxBufferMemory))
    : undefined;

  // Metrics collection
  const metricsFile =
    rawConfig.dest === 'bigquery' ? (rawConfig as BigQueryDestConfig).metricsFile : undefined;
  const metricsData: Record<string, unknown>[] = [];

  // Load job quota backpressure (BigQuery)
  const maxLoadJobs =
    rawConfig.dest === 'bigquery' ? (rawConfig as BigQueryDestConfig).maxLoadJobs : undefined;
  let totalLoadJobs = 0;
  let backpressureMultiplier = 1;

  // Progress reporting
  let totalRowsLoaded = 0;
  const loadStartTime = performance.now();
  let lastProgressLog = loadStartTime;

  // Target file size for BigQuery (targetFileSizeMb defaults to 256 in schema)
  const targetFileSizeBytes =
    rawConfig.dest === 'bigquery'
      ? (rawConfig as BigQueryDestConfig).targetFileSizeMb * 1_000_000
      : undefined;

  const targetSchema = sanitizeSchemaName(getTargetSchema(rawConfig));
  const cliLoadStrategy = rawConfig.loadStrategy;
  const cliSchemaBehavior: SchemaBehavior | undefined = rawConfig.schemaBehavior;
  const tablePrefix = rawConfig.tablePrefix ?? '';
  const streamTableOverrides = new Map<string, string>(
    Object.entries(rawConfig.streamTables ?? {})
  );
  let duckDbWriterPromise: Promise<DuckDbWriter> | undefined;

  const getDuckDbWriter = async (): Promise<DuckDbWriter> => {
    if (!duckDbWriterPromise) {
      if (dependencies.createDuckDbWriter) {
        duckDbWriterPromise = dependencies.createDuckDbWriter();
      } else {
        duckDbWriterPromise = import('../runtime/duckdb-writer.js').then(({ createDuckDbWriter }) =>
          createDuckDbWriter()
        );
      }
    }
    return duckDbWriterPromise;
  };

  /**
   * Resolve a raw stream name to its destination table name.
   *
   * A per-stream `table:` override REPLACES the whole computed name — the
   * `tablePrefix` is deliberately NOT re-applied on top of it (documented
   * `bobsled.yml` semantics: `table: raw_stripe__subs_v2` is the final table).
   * Everything else in the database loader (schemas, buffers, strategies,
   * pending loads, checkpoints) is keyed by this return value, so overriding
   * here keeps that keying consistent everywhere.
   */
  const prefixedTableName = (stream: string): string => {
    const override = streamTableOverrides.get(stream);
    return sanitizeTableName(override ?? tablePrefix + stream);
  };
  validateDistinctStreamTables(rawConfig.streamTables, prefixedTableName);
  const {
    streamStrategyOverrides,
    streamSchemaBehaviorOverrides,
    streamTableOwnershipMarkerOverrides,
  } = resolveStreamDestinationOverrides(
    rawConfig.streamLoadStrategies,
    rawConfig.streamSchemaBehaviors,
    'streamTableOwnershipMarkers' in rawConfig ? rawConfig.streamTableOwnershipMarkers : undefined,
    prefixedTableName
  );

  /**
   * Per-stream override wins over the pipeline-level `--load-strategy`, which
   * wins over the extractor's SCHEMA `load_strategy`, which falls back to
   * `append`.
   */
  const resolveEffectiveStrategy = (stream: string): LoadStrategy =>
    streamStrategyOverrides.get(stream) ??
    cliLoadStrategy ??
    streamStrategies.get(stream) ??
    'append';

  const getOrCreateBuffer = (stream: string): RecordBuffer => {
    let buffer = buffers.get(stream);
    if (!buffer) {
      buffer = new RecordBuffer({
        stream,
        flushThreshold: rawConfig.bufferSize * backpressureMultiplier,
        tempDir: bufferRootDir,
        targetFileSizeBytes: targetFileSizeBytes
          ? targetFileSizeBytes * backpressureMultiplier
          : undefined,
        memoryTracker,
      });
      buffers.set(stream, buffer);
    }
    return buffer;
  };

  const loadFile = async (
    filePath: string,
    stream: string,
    cleanupSource: boolean,
    batchId: number = 0,
    sourceEncoding: BatchEncoding = DEFAULT_JSONL_ENCODING
  ): Promise<void> => {
    const schema = schemas.get(stream);
    if (!schema) {
      throw new CommandError(`Received data for stream "${stream}" before SCHEMA message`);
    }

    const keys = keyProperties.get(stream) ?? [];
    let effectiveStrategy: LoadStrategy = resolveEffectiveStrategy(stream);
    if (effectiveStrategy === 'merge' && keys.length === 0) {
      logger.warn(`${stream}: merge requested but no key_properties — falling back to append`);
      effectiveStrategy = 'append';
    }

    let loadPath = filePath;
    let loadEncoding = sourceEncoding;
    let cleanupNormalizedPath: string | undefined;
    if (loadEncoding.format === 'parquet' && !supportsNativeParquetLoad(rawConfig.dest)) {
      const duckdb = await getDuckDbWriter();
      const normalizedPath = path.join(
        normalizedBatchRootDir,
        buildTempFileName(stream, normalizedBatchIndex++, '.jsonl')
      );
      await duckdb.convertFile({
        sourcePath: filePath,
        outputPath: normalizedPath,
        format: 'jsonl',
        sourceEncoding: loadEncoding,
        columns: schema.columns,
      });
      loadPath = normalizedPath;
      loadEncoding = DEFAULT_JSONL_ENCODING;
      cleanupNormalizedPath = normalizedPath;
    }

    const loadStart = performance.now();
    let result: LoadResult;
    try {
      result = await destination.loadAndFinalize(
        targetSchema,
        stream,
        loadPath,
        schema.columns,
        effectiveStrategy,
        keys,
        loadEncoding
      );
    } catch (error) {
      const destType = rawConfig.dest;
      throw formatDatabaseError(error, destType, stream, schema.columns);
    }

    // Persist truncated tables immediately after full_refresh load to prevent
    // data loss if the process crashes before the next STATE message.
    if (effectiveStrategy === 'full_refresh' && checkpointManager) {
      const truncated = destination.getTruncatedTables();
      if (truncated.size > 0) {
        await checkpointManager.saveTruncatedTables(truncated);
      }
    }

    const loadMs = performance.now() - loadStart;
    metricsData.push({ stream, batchId, rowsAffected: result.rowsAffected, loadMs });

    const prev = streamsLoaded.get(stream) ?? 0;
    streamsLoaded.set(stream, prev + result.rowsAffected);
    totalRowsLoaded += result.rowsAffected;
    logger.info(`${stream}: loaded ${result.rowsAffected} rows`, {
      stream: sourceStreams.get(stream) ?? stream,
      batchId,
      rowsAffected: result.rowsAffected,
      loadMs: Math.round(loadMs),
    });

    // Periodic progress report (every 30 seconds)
    const now = performance.now();
    if (now - lastProgressLog >= 30_000) {
      const elapsedSec = (now - loadStartTime) / 1_000;
      const rowsPerSec = Math.round(totalRowsLoaded / elapsedSec);
      const completedStreams = streamsLoaded.size;
      logger.info(
        `Progress: ${completedStreams} streams | ${totalRowsLoaded.toLocaleString()} rows loaded | ${rowsPerSec.toLocaleString()} rows/sec`
      );
      lastProgressLog = now;
    }

    // Track load job count for quota warning and backpressure
    const prevJobCount = loadJobCounts.get(stream) ?? 0;
    const newJobCount = prevJobCount + 1;
    loadJobCounts.set(stream, newJobCount);
    totalLoadJobs++;

    if (newJobCount === 1_000) {
      logger.warn(
        `${stream}: reached 1,000 load jobs — approaching BigQuery daily quota. ` +
          `Consider increasing --buffer-size or --target-file-size to reduce job count.`
      );
    }

    // Apply backpressure by increasing buffer flush threshold when approaching quota
    if (maxLoadJobs !== undefined) {
      const usage = totalLoadJobs / maxLoadJobs;
      const prevMultiplier = backpressureMultiplier;
      if (usage >= 0.95 && backpressureMultiplier < 4) {
        backpressureMultiplier = 4;
        logger.warn(
          `Load job backpressure: ${totalLoadJobs}/${maxLoadJobs} jobs used (95%) — ` +
            `quadrupling buffer size to reduce job count`
        );
      } else if (usage >= 0.8 && backpressureMultiplier < 2) {
        backpressureMultiplier = 2;
        logger.warn(
          `Load job backpressure: ${totalLoadJobs}/${maxLoadJobs} jobs used (80%) — ` +
            `doubling buffer size to reduce job count`
        );
      }
      // Update thresholds on all existing buffers when multiplier increases
      if (backpressureMultiplier > prevMultiplier) {
        for (const buf of buffers.values()) {
          buf.updateThresholds(
            rawConfig.bufferSize * backpressureMultiplier,
            targetFileSizeBytes ? targetFileSizeBytes * backpressureMultiplier : undefined
          );
        }
      }
    }

    if (cleanupSource) {
      await fs.rm(filePath, { force: true });
    }
    if (cleanupNormalizedPath) {
      await fs.rm(cleanupNormalizedPath, { force: true });
    }
  };

  // Track the first load error so we can fail fast
  let firstLoadError: Error | null = null;

  // Per-stream serial chain for full_refresh and merge loads. Full refresh
  // truncates once before appending, while merge destinations snapshot and
  // publish winners in separate operations; both sequences must be exclusive
  // for a stream's destination table.
  const streamChains = new Map<string, Promise<void>>();
  const replacements = new PendingReplacements();

  /**
   * Schedule a load with the concurrency limiter. The returned promise
   * is tracked per-stream so STATE can await pending loads.
   *
   * For full_refresh and merge streams, loads are chained sequentially
   * per-stream to avoid concurrent writes to the same destination table.
   */
  const scheduleLoad = (
    filePath: string | null,
    stream: string,
    cleanupSource: boolean,
    batchId: number = 0,
    sourceEncoding: BatchEncoding = DEFAULT_JSONL_ENCODING
  ): void => {
    if (firstLoadError) {
      throw firstLoadError;
    }

    const effectiveStrategy = resolveEffectiveStrategy(stream);
    // A REPLACE delete must finish before this load and after the previous one.
    const needsSerialPerStream =
      effectiveStrategy === 'full_refresh' ||
      effectiveStrategy === 'merge' ||
      replacements.replaces(stream);
    const replacement = replacements.take(stream);
    const run = async (): Promise<void> => {
      if (replacement) {
        await destination.deleteRows(targetSchema, stream, replacement.key, replacement.values);
      }
      if (filePath !== null) {
        await loadFile(filePath, stream, cleanupSource, batchId, sourceEncoding);
      }
    };

    let promise: Promise<void>;
    if (needsSerialPerStream) {
      // Chain: wait for previous load on this stream to finish before starting
      const prev = streamChains.get(stream) ?? Promise.resolve();
      promise = prev
        .then(() => limiter(run))
        .catch((err: Error) => {
          if (!firstLoadError) {
            firstLoadError = err;
          }
          throw err;
        });
      streamChains.set(
        stream,
        promise.catch(() => {})
      );
    } else {
      promise = limiter(run).catch((err: Error) => {
        if (!firstLoadError) {
          firstLoadError = err;
        }
        throw err;
      });
    }

    let streamPending = pendingLoads.get(stream);
    if (!streamPending) {
      streamPending = [];
      pendingLoads.set(stream, streamPending);
    }
    streamPending.push(promise);
  };

  /**
   * Await and clear all pending loads for a given stream.
   * Uses Promise.allSettled to ensure all promises are consumed, then
   * throws the first error if any failed.
   */
  const drainStreamLoads = async (stream: string): Promise<void> => {
    const pending = pendingLoads.get(stream);
    if (pending && pending.length > 0) {
      const results = await Promise.allSettled(pending);
      pendingLoads.set(stream, []);
      const failed = results.find((r) => r.status === 'rejected') as
        PromiseRejectedResult | undefined;
      if (failed) {
        throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
      }
    }
  };

  try {
    await destination.initialize();

    // Restore truncated tables from checkpoint for full_refresh idempotency on restart
    if (checkpointManager) {
      const savedTruncated = await checkpointManager.loadTruncatedTables();
      if (savedTruncated.size > 0) {
        destination.setTruncatedTables(savedTruncated);
        logger.info(`Restored ${savedTruncated.size} truncated table(s) from checkpoint`);
      }
    }

    for await (const message of readProtocol(input)) {
      switch (message.type) {
        case 'SCHEMA': {
          let safeStream: string;
          try {
            safeStream = prefixedTableName(message.stream);
          } catch {
            const override = streamTableOverrides.get(message.stream);
            throw new CommandError(
              override === undefined
                ? `Stream name '${message.stream}' is not a valid SQL identifier. ` +
                    `Rename the stream in the extractor config to use only letters, numbers, and underscores.`
                : `Table override '${override}' for stream '${message.stream}' is not a valid SQL ` +
                    `identifier. Use only letters, numbers, and underscores.`,
              2
            );
          }
          const existingSource = sourceStreams.get(safeStream);
          if (existingSource !== undefined && existingSource !== message.stream) {
            throw new CommandError(
              `Streams "${existingSource}" and "${message.stream}" both resolve to destination ` +
                `table "${safeStream}". Give each stream a distinct --stream-table value.`,
              2
            );
          }
          const effectiveStrategy =
            streamStrategyOverrides.get(safeStream) ?? cliLoadStrategy ?? message.load_strategy;
          const effectiveSchemaBehavior =
            streamSchemaBehaviorOverrides.get(safeStream) ??
            cliSchemaBehavior ??
            message.schema_behavior;
          if (
            rawConfig.dest === 'snowflake' &&
            effectiveStrategy === 'full_refresh' &&
            effectiveSchemaBehavior !== 'strict' &&
            effectiveSchemaBehavior !== 'freeze' &&
            schemas.has(safeStream) &&
            streamsWithData.has(safeStream)
          ) {
            throw new CommandError(
              `Stream "${message.stream}" emitted another SCHEMA after data during a Snowflake full_refresh run. ` +
                'Split schema versions into separate runs so replacing the table cannot discard rows loaded earlier in this run.',
              2
            );
          }
          const shouldReconcile = prepareReconcileSchemaMessage(
            message,
            effectiveStrategy,
            reconcileSchemaStreams,
            seenReconcileSchemaStreams
          );
          // Flush any records buffered under the previous schema before updating
          const existingBuffer = buffers.get(safeStream);
          if (existingBuffer) {
            const flushedPath = await existingBuffer.flush();
            if (flushedPath) {
              await drainStreamLoads(safeStream);
              scheduleLoad(
                flushedPath,
                safeStream,
                true,
                existingBuffer.lastBatchId,
                DEFAULT_JSONL_ENCODING
              );
              await drainStreamLoads(safeStream);
            }
          }
          schemas.set(safeStream, message.schema);
          keyProperties.set(safeStream, message.key_properties);
          streamStrategies.set(safeStream, message.load_strategy);
          sourceStreams.set(safeStream, message.stream);
          try {
            await destination.ensureTable(
              targetSchema,
              safeStream,
              message.schema.columns,
              buildEnsureTableOptions(
                message,
                cliSchemaBehavior,
                shouldReconcile,
                effectiveStrategy,
                streamSchemaBehaviorOverrides.get(safeStream),
                streamTableOwnershipMarkerOverrides.get(safeStream)
              )
            );
          } catch (error) {
            throw formatDatabaseError(error, rawConfig.dest, safeStream, message.schema.columns);
          }
          logger.info(`${safeStream}: strategy=${resolveEffectiveStrategy(safeStream)}`);
          break;
        }
        case 'BATCH': {
          const safeStream = prefixedTableName(message.stream);
          streamsWithData.add(safeStream);
          for (const uri of message.manifest) {
            scheduleLoad(fileUriToPath(uri), safeStream, false, 0, message.encoding);
          }
          break;
        }
        case 'RECORD': {
          const safeStream = prefixedTableName(message.stream);
          if (!schemas.has(safeStream)) {
            throw new CommandError(
              `Received data for stream "${message.stream}" before SCHEMA message`
            );
          }
          streamsWithData.add(safeStream);
          const record = {
            ...message.record,
            _time_extracted: message.time_extracted,
          };
          const buffer = getOrCreateBuffer(safeStream);
          const flushedPath = await buffer.addRecord(record);
          if (flushedPath) {
            scheduleLoad(flushedPath, safeStream, true, buffer.lastBatchId, DEFAULT_JSONL_ENCODING);
          }
          break;
        }
        case 'REPLACE': {
          const safeStream = prefixedTableName(message.stream);
          replacements.add(safeStream, message, schemas.get(safeStream)?.columns);
          break;
        }
        case 'STATE': {
          const safeStream = prefixedTableName(message.stream);
          const buffer = buffers.get(safeStream);
          const flushedPath = (await buffer?.flush()) ?? null;
          if (flushedPath || replacements.streamsWithPending().includes(safeStream)) {
            scheduleLoad(
              flushedPath,
              safeStream,
              true,
              buffer?.lastBatchId ?? 0,
              DEFAULT_JSONL_ENCODING
            );
          }

          // Wait for all pending loads for this stream before forwarding STATE
          await drainStreamLoads(safeStream);

          // Save checkpoint if configured
          if (checkpointManager) {
            await checkpointManager.save(safeStream, message.value);
            // Persist truncated tables so full_refresh is idempotent on restart
            const truncated = destination.getTruncatedTables();
            if (truncated.size > 0) {
              await checkpointManager.saveTruncatedTables(truncated);
            }
          }

          await writeLine(stdout, `${JSON.stringify(message)}\n`);
          statesForwarded += 1;
          break;
        }
      }
    }

    for (const [stream, buffer] of buffers) {
      const flushedPath = await buffer.flush();
      if (flushedPath) {
        scheduleLoad(flushedPath, stream, true, buffer.lastBatchId, DEFAULT_JSONL_ENCODING);
      }
    }
    // Slices replaced by an empty set of rows still need their old rows deleted.
    for (const stream of replacements.streamsWithPending()) {
      scheduleLoad(null, stream, false);
    }

    for (const stream of pendingLoads.keys()) {
      await drainStreamLoads(stream);
    }

    assertReconcileSchemaStreamsFound(reconcileSchemaStreams, seenReconcileSchemaStreams);

    if (metricsFile && metricsData.length > 0) {
      const resolvedMetricsPath = path.resolve(metricsFile);
      await fs.writeFile(resolvedMetricsPath, JSON.stringify(metricsData, null, 2), 'utf-8');
      logger.info(`Wrote metrics to ${resolvedMetricsPath}`);
    }

    return {
      streamsLoaded,
      statesForwarded,
    };
  } finally {
    for (const buffer of buffers.values()) {
      await buffer.cleanup();
    }

    try {
      await destination.close();
    } catch {
      // Preserve the original error if the pipeline already failed
    }
    try {
      const duckDbWriter = await duckDbWriterPromise;
      await duckDbWriter?.close();
    } catch {
      // Preserve the original error if the pipeline already failed
    }
    await fs.rm(ownedTempDir, { recursive: true, force: true });
  }
}

export async function runLoader(
  rawConfig: LoaderConfig,
  dependencies: RunLoaderDependencies = {}
): Promise<RunLoaderResult | RunDatabaseLoaderResult> {
  if (isDatabaseDestConfig(rawConfig)) {
    return runDatabaseLoader(rawConfig, dependencies);
  }

  return runFileLoader(rawConfig, dependencies);
}

export function registerRunCommand(program: Command, runHandler: RunHandler = runLoader): void {
  program
    .command('run')
    .description('Read protocol messages from stdin and load them into a destination')
    .option('--format <format>', 'Output format: jsonl, csv, parquet, or arrow')
    .option(
      '--dest <dest>',
      'Destination: local, gcs, s3, duckdb, ducklake, sqlite, bigquery, snowflake, postgres, mysql, mssql, databricks, clickhouse, turbopuffer, elasticsearch, chroma, or pgvector',
      'local'
    )
    .option('--output-dir <dir>', 'Local output directory', './output')
    .option('--gcs-bucket <bucket>', 'GCS bucket name')
    .option('--gcs-prefix <prefix>', 'GCS object prefix')
    .option('--s3-bucket <bucket>', 'S3 bucket name')
    .option('--s3-prefix <prefix>', 'S3 object prefix')
    .option('--s3-region <region>', 'AWS region')
    .option('--s3-role-arn <arn>', 'AWS IAM role ARN for assume-role credentials')
    .option('--s3-external-id <id>', 'AWS external ID for assume-role credentials')
    .option(
      '--stream-subfolder <path>',
      'Folder added inside each stream folder for local, gcs and s3 destinations (for example data/run-1)'
    )
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--ducklake-catalog-url <url>', 'DuckLake catalog URL')
    .option('--ducklake-data-path <path>', 'DuckLake data path')
    .option('--ducklake-alias <alias>', 'DuckLake attach alias', 'lake')
    .option('--target-schema <schema>', 'Schema for DuckDB, DuckLake, SQLite, Snowflake', 'main')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option(
      '--bq-access-token <token>',
      'BigQuery pre-minted OAuth access token (mirrors dbt-bigquery oauth-secrets); takes precedence over --key-filename'
    )
    .option(
      '--bq-token-command <command>',
      'Shell command printing JSON {"access_token","expires_at"} for a refreshable BigQuery/GCS token; refreshes mid-run. Takes precedence over --bq-access-token'
    )
    .option(
      '--load-strategy <strategy>',
      'Database load strategy: append, merge, or full_refresh (overrides per-stream)'
    )
    .addOption(createStreamLoadStrategyOption())
    .addOption(createStreamSchemaBehaviorOption())
    .addOption(createStreamTableOption())
    .addOption(createStreamTableOwnershipMarkerOption())
    .option(
      '--schema-behavior <mode>',
      'Schema contract behavior: evolve, strict, or freeze (overrides per-stream)'
    )
    .option(
      '--reconcile-schema <stream...>',
      'One-shot Snowflake schema reconciliation for a stream (repeatable; requires full_refresh)',
      collectReconcileSchema,
      []
    )
    .option('--log-format <format>', 'Log output format: text or json', 'text')
    .option('--memory-limit <size>', 'DuckDB memory limit (e.g., 2GB, 512MB)')
    .option('--dry-run', 'Read protocol and print strategy table without loading')
    .option(
      '--buffer-size <count>',
      'Number of records to buffer before flushing in streaming mode',
      parsePositiveInt,
      10_000
    )
    .option(
      '--target-file-size <mb>',
      'Target file size in MB for BigQuery load jobs',
      parsePositiveInt
    )
    .option('--staging-format <format>', 'BigQuery staging format: parquet or jsonl')
    .option('--gcs-staging-bucket <bucket>', 'GCS bucket for BigQuery staging files')
    .option('--gcs-staging-prefix <prefix>', 'GCS object prefix for BigQuery staging files')
    .option('--max-concurrent-loads <count>', 'Max concurrent load jobs', parsePositiveInt)
    .option('--checkpoint-dir <path>', 'Directory for saving checkpoint state')
    .option('--max-buffer-memory <size>', 'Max memory for record buffers (e.g., 512MB, 2GB)')
    .option('--metrics-file <path>', 'Write JSON metrics summary to this file')
    .option(
      '--max-load-jobs <count>',
      'Max BigQuery load jobs before backpressure (default 9000)',
      parsePositiveInt
    )
    .option('--table-prefix <prefix>', 'Prefix prepended to all table names (e.g. "vantage__")')
    .option('--sf-account <account>', 'Snowflake account identifier')
    .option('--sf-username <user>', 'Snowflake username')
    .option('--sf-password <pass>', 'Snowflake password')
    .option('--sf-access-token <token>', 'Snowflake pre-minted OIDC token; forces OAUTH')
    .option('--sf-token-command <command>', 'Command returning Snowflake OIDC token JSON')
    .option(
      '--sf-workload-identity-token <env>',
      'Snowflake workload identity token environment variable reference',
      parseSnowflakeWorkloadIdentityToken
    )
    .option('--sf-private-key-path <path>', 'Path to Snowflake private key file')
    .option('--sf-private-key-passphrase <pass>', 'Passphrase for Snowflake private key')
    .option('--sf-warehouse <wh>', 'Snowflake warehouse')
    .option('--sf-database <db>', 'Snowflake database')
    .option('--sf-role <role>', 'Snowflake role')
    .option('--query-tag <tag>', 'Trusted Snowflake query tag for this run')
    .option('--postgres-host <host>', 'Postgres host')
    .option('--postgres-port <port>', 'Postgres port', parsePositiveInt)
    .option('--postgres-database <db>', 'Postgres database')
    .option('--postgres-schema <schema>', 'Postgres schema', 'public')
    .option('--postgres-user <user>', 'Postgres username')
    .option('--postgres-password <pass>', 'Postgres password')
    .option('--postgres-ssl', 'Postgres SSL', false)
    .option('--mysql-host <host>', 'MySQL host')
    .option('--mysql-port <port>', 'MySQL port', parsePositiveInt)
    .option('--mysql-database <database>', 'MySQL database name')
    .option('--mysql-user <user>', 'MySQL user')
    .option('--mysql-password <password>', 'MySQL password')
    .option('--mysql-ssl', 'Use SSL for MySQL connection')
    .option('--databricks-host <host>', 'Databricks server hostname')
    .option('--databricks-http-path <path>', 'Databricks HTTP path')
    .option('--databricks-token <token>', 'Databricks access token')
    .option('--databricks-oauth-client-id <id>', 'Databricks OAuth M2M client ID')
    .option('--databricks-oauth-client-secret <secret>', 'Databricks OAuth M2M client secret')
    .option('--databricks-catalog <catalog>', 'Databricks catalog')
    .option('--databricks-schema <schema>', 'Databricks schema')
    .option('--clickhouse-host <host>', 'ClickHouse host')
    .option('--clickhouse-port <port>', 'ClickHouse port', parsePositiveInt)
    .option('--clickhouse-database <db>', 'ClickHouse database')
    .option('--clickhouse-username <user>', 'ClickHouse username')
    .option('--clickhouse-password <pass>', 'ClickHouse password')
    .option('--clickhouse-ssl', 'Use HTTPS for the ClickHouse connection', false)
    .option(
      '--clickhouse-vector-index',
      'Create a vector_similarity index for vector columns (ClickHouse 25.8+)',
      false
    )
    .option('--elasticsearch-host <host>', 'Elasticsearch host')
    .option('--elasticsearch-port <port>', 'Elasticsearch port', parsePositiveInt)
    .option('--elasticsearch-index <index>', 'Elasticsearch index name')
    .option('--elasticsearch-api-key <key>', 'Elasticsearch API key')
    .option('--elasticsearch-username <username>', 'Elasticsearch username')
    .option('--elasticsearch-password <password>', 'Elasticsearch password')
    .option('--elasticsearch-ssl', 'Use HTTPS for Elasticsearch connection', false)
    .option(
      '--elasticsearch-vector-dimension <dims>',
      'Elasticsearch vector dimension',
      parsePositiveInt
    )
    .option('--chroma-host <host>', 'Chroma server hostname')
    .option('--chroma-port <port>', 'Chroma port', parsePositiveInt)
    .option('--chroma-tenant <tenant>', 'Chroma tenant')
    .option('--chroma-database <database>', 'Chroma database')
    .option('--pgvector-host <host>', 'PgVector host')
    .option('--pgvector-port <port>', 'PgVector port', parsePositiveInt)
    .option('--pgvector-database <db>', 'PgVector database')
    .option('--pgvector-schema <schema>', 'PgVector schema', 'public')
    .option('--pgvector-user <user>', 'PgVector username')
    .option('--pgvector-password <pass>', 'PgVector password')
    .option('--pgvector-ssl', 'PgVector SSL', false)
    .option('--vector-dimension <dim>', 'Vector embedding dimension', parsePositiveInt)
    .option('--vector-columns <cols>', 'Comma-separated list of vector columns')
    .option('--turbopuffer-api-key <key>', 'Turbopuffer API key (use $ENV_VAR)')
    .option('--turbopuffer-region <region>', 'Turbopuffer region (default gcp-us-central1)')
    .option('--turbopuffer-namespace-prefix <prefix>', 'Prefix prepended to namespace names')
    .option('--turbopuffer-distance-metric <metric>', 'cosine_distance or euclidean_squared')
    .option(
      '--turbopuffer-full-text-columns <cols>',
      'Comma-separated string columns to index for BM25'
    )
    .option(
      '--load-file <path>',
      'Path to a target YAML file: an integration reference with optional overrides and defaults.'
    )
    .option(
      '--load-integration <name>',
      'Destination integration name. Resolves integrations/<name>.yml. Lighter alternative to --load-file when only the integration is needed.'
    )
    .action(async (options, command: Command) => {
      try {
        const namedTarget = options.loadFile || options.loadIntegration;
        const runOptions = resolveRunOptions(options, command);
        const targetConfig = namedTarget ? await resolveRunConfig(runOptions) : undefined;
        if (options.dryRun) {
          const dryRunOptions = resolveDryRunOptions(runOptions, targetConfig);
          assertReconcileSchemaDestination(
            dryRunOptions.dest,
            requestedReconcileSchema(dryRunOptions)
          );
          await runDryRun(dryRunOptions);
          return;
        }

        const config = targetConfig ?? (await resolveRunConfig(runOptions));
        await runHandler(config, { queryTag: options.queryTag });
      } catch (error) {
        handleRunError(error, options.logFormat === 'json' ? 'json' : 'text');
      }
    });
}

export { runDryRun, handleRunError };
