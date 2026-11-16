import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Command, Option } from 'commander';

import { CommandError, parsePositiveInt } from '@bobsled-inc/protocol';
import { spawnCommand, waitForProcess } from '../runtime/process.js';
import { resolveCliInvocation } from '../runtime/workspace.js';
import { createManifest, getManifestPath, writeManifest } from '../runner/manifest.js';
import {
  emitLoadCountWarnings,
  extractErrorMessage,
  pruneStaleCaptureDirs,
  updateManifestDestination,
  validatePipelineDestinations,
} from './pipeline-fanout.js';
import { parseBatchFormat } from './pipeline-options.js';
import {
  applyHostEnvironmentDeclarations,
  buildEmbedArgs,
  collectInput,
  getDestinations,
  getEmbedConfig,
  getRuntimeCwd,
  getRuntimeEnv,
  maybeRemoveDir,
  maybeRemoveFile,
  prepareEmbedConfig,
} from './pipeline-run-helpers.js';
import {
  buildLoadArgs,
  buildLoadArgsForDestination,
  buildDestinationLoadEnv,
  buildLoadEnv,
  preparePipelineWorkloadIdentity,
} from './pipeline-load-args.js';
import { parseSnowflakeWorkloadIdentityToken } from '../runner/commands/destination-args.js';
import {
  buildLogMessage,
  buildPipelineSummaryMessage,
  clonePipelineSummary,
  createChunkProcessor,
  createPipelineSummary,
  emitPipelineSummary,
  formatDestinationLogLine,
  formatPipelineLogLine,
  mergeSummary,
  writePipelineLogLine,
  writeLogLine,
} from './pipeline-summary.js';
import {
  setupPipelineSignalForwarding,
  terminateAndSettlePipelineChildren,
  throwIfPipelineAborted,
  type PipelineExecutionControl,
  type PipelineExecutionStage,
  type StartedPipelineChild,
} from './pipeline-control.js';
import { buildPipelineExtractArgs } from './pipeline-extract-args.js';
import { addDatabaseDestinationOptions } from './pipeline-destination-options.js';

import type { ProcessResult, RunCommandDependencies } from '../runtime/process.js';
import type { NamedDestination } from '../runner/config/schema.js';
import type { FanOutManifest } from '../runner/manifest.js';
import type { PipelineSummary } from './pipeline-summary.js';

export { buildPipelineSummaryMessage };

function writeManifestCheckpoint(
  manifestPath: string,
  manifest: FanOutManifest,
  logStream?: fs.WriteStream
): void {
  writeManifest(manifestPath, manifest, (message) => {
    writeLogLine(JSON.stringify(buildLogMessage('warn', message)), logStream);
  });
}

function getProcessFailureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface PipelineOptions {
  declaredEnvNames?: readonly string[];
  batch?: boolean;
  batchFormat?: 'jsonl' | 'parquet';
  batchSize?: number;
  bqAccessToken?: string;
  bqTokenCommand?: string;
  bufferSize?: number;
  datasetId?: string;
  databricksHost?: string;
  databricksHttpPath?: string;
  databricksCatalog?: string;
  databricksSchema?: string;
  databricksToken?: string;
  databricksOauthClientId?: string;
  databricksOauthClientSecret?: string;
  dbPath?: string;
  dest?: string;
  emitModelSpecSource?: boolean;
  format?: string;
  fullRefresh?: boolean;
  /** One-shot Snowflake schema reconciliation for selected protocol streams. */
  reconcileSchema?: string[];
  gcsBucket?: string;
  gcsPrefix?: string;
  input?: string[];
  integration: string;
  keyFilename?: string;
  loadStrategy?: NamedDestination['load_strategy'];
  schemaBehavior?: NamedDestination['schema_behavior'];
  destinations?: NamedDestination[];
  destinationsJson?: string;
  embedConfigJson?: string;
  location?: string;
  /** Maximum records emitted per resource. Limited runs never advance durable state. */
  limit?: number;
  logFile?: string;
  logFormat?: string;
  mysqlDatabase?: string;
  mysqlHost?: string;
  mysqlPassword?: string;
  mysqlPort?: number;
  mysqlSsl?: boolean;
  mysqlUser?: string;
  clickhouseHost?: string;
  clickhousePort?: number;
  clickhouseDatabase?: string;
  clickhouseUsername?: string;
  clickhousePassword?: string;
  clickhouseSsl?: boolean;
  clickhouseVectorIndex?: boolean;
  turbopufferApiKey?: string;
  turbopufferRegion?: string;
  turbopufferNamespacePrefix?: string;
  turbopufferDistanceMetric?: string;
  turbopufferFullTextColumns?: string;
  outputDir: string;
  pipelineName?: string;
  postgresDatabase?: string;
  postgresHost?: string;
  postgresPassword?: string;
  postgresPort?: number;
  postgresSchema?: string;
  postgresSsl?: boolean;
  postgresUser?: string;
  projectId?: string;
  quiet?: boolean;
  resource?: string[];
  s3Bucket?: string;
  s3Prefix?: string;
  /** Folder added inside each stream's folder on local, gcs and s3 destinations. */
  streamSubfolder?: string;
  startDate?: string;
  endDate?: string;
  sfAccount?: string;
  sfAccessToken?: string;
  sfDatabase?: string;
  sfPassword?: string;
  sfPrivateKeyPassphrase?: string;
  sfPrivateKeyPath?: string;
  sfRole?: string;
  sfTokenCommand?: string;
  sfWorkloadIdentityToken?: string;
  sfUsername?: string;
  sfWarehouse?: string;
  tablePrefix?: string;
  targetSchema?: string;
  verbose?: boolean;
  via?: string;
  /** Extractor state backend override, normally an isolated project-contained directory. */
  stateBackend?: string;
  /** Preserve raw fan-out captures after failure for CLI debugging. Defaults to true. */
  preserveCaptureOnFailure?: boolean;
  /** Source env names used by workload identity placeholders in project config. */
  workloadIdentitySourceEnvNames?: readonly string[];
  /**
   * Per-resource transport override map. Keys are resolved resource spec names
   * (post entity-variant resolution); values are the transport id to force for
   * that resource. Emitted to the extractor subprocess as repeatable
   * `--resource-via <name>:<id>` flags. Wins over both the source integration's
   * `default_transport` and any pipeline-level `via:` for the named resource;
   * resources not in the map fall back to those.
   */
  resourceVia?: Record<string, string>;
  /** Per-resource extractor input values keyed by resolved protocol stream. */
  resourceInputs?: Record<string, Record<string, string>>;
  /** Static per-resource input tuples, expanded in authored axis order. */
  resourceInputMatrices?: Record<string, Array<Record<string, string | number | boolean>>>;
  /** Static per-resource matrix concurrency limits. */
  resourceInputMatrixConcurrency?: Record<string, number>;
  /** Per-resource strategy overrides keyed by resolved protocol stream. */
  resourceLoadStrategy?: Record<string, NonNullable<NamedDestination['load_strategy']>>;
  /** Per-resource schema behavior overrides keyed by resolved protocol stream. */
  resourceSchemaBehavior?: Record<string, NonNullable<NamedDestination['schema_behavior']>>;
  /** Final database table overrides keyed by resolved protocol stream. */
  resourceTable?: Record<string, string>;
  /** Per-resource reserved warehouse table ownership markers. */
  resourceTableOwnershipMarker?: Record<string, string>;
  /** Pipeline-scoped source warehouse selector, consumed only by Snowflake extraction. */
  warehouse?: string;
  /** Trusted execution-only Snowflake query tag forwarded to source and destination sessions. */
  queryTag?: string;
}

export interface PipelineDependencies extends RunCommandDependencies, PipelineExecutionControl {
  metaUrl?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type { PipelineExecutionStage } from './pipeline-control.js';

interface DestinationResult {
  exitCode: number;
  name: string;
  error?: string;
  summary: PipelineSummary;
}

type RedactPipelineValue = (value: string) => string;

function createWorkloadIdentityRedactor(tokens: Iterable<string | undefined>): RedactPipelineValue {
  const redactionTokens = [...tokens]
    .filter((token): token is string => Boolean(token))
    .filter((token, index, allTokens) => allTokens.indexOf(token) === index)
    .sort((left, right) => right.length - left.length);

  return (value) =>
    redactionTokens.reduce((redacted, token) => redacted.split(token).join('[REDACTED]'), value);
}

function redactPipelineError(error: unknown, redact: RedactPipelineValue): unknown {
  if (typeof error === 'string') {
    return redact(error);
  }
  if (!(error instanceof Error)) {
    return new Error('Pipeline failed with an unknown thrown value.');
  }

  const errorWithMetadata = error as Error & {
    cause?: unknown;
    code?: unknown;
    exitCode?: unknown;
  };
  const sanitizedError =
    error instanceof CommandError
      ? new CommandError(redact(error.message), error.exitCode)
      : new Error(redact(error.message));
  sanitizedError.name = redact(error.name);
  if (error.stack) {
    sanitizedError.stack = redact(error.stack);
  }

  const sanitizedWithMetadata = sanitizedError as Error & {
    cause?: unknown;
    code?: unknown;
    exitCode?: unknown;
  };
  if (typeof errorWithMetadata.code === 'string') {
    sanitizedWithMetadata.code = redact(errorWithMetadata.code);
  } else if (typeof errorWithMetadata.code === 'number') {
    sanitizedWithMetadata.code = errorWithMetadata.code;
  }
  if (error instanceof CommandError) {
    sanitizedWithMetadata.exitCode = error.exitCode;
  } else if (typeof errorWithMetadata.exitCode === 'number') {
    sanitizedWithMetadata.exitCode = errorWithMetadata.exitCode;
  }
  if ('cause' in errorWithMetadata) {
    const cause = errorWithMetadata.cause;
    sanitizedWithMetadata.cause =
      cause instanceof Error
        ? redactPipelineError(cause, redact)
        : typeof cause === 'string'
          ? redact(cause)
          : cause === null ||
              typeof cause === 'number' ||
              typeof cause === 'boolean' ||
              typeof cause === 'undefined'
            ? cause
            : '[REDACTED]';
  }
  return sanitizedError;
}

function waitForReplayStream(replayStream: fs.ReadStream): Promise<void> {
  return new Promise((resolve, reject) => {
    replayStream.on('close', () => resolve());
    replayStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.name === 'AbortError') {
        resolve();
        return;
      }
      reject(err);
    });
  });
}

async function buildExtractEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  try {
    const { getIntegrationsDir } = await import('@bobsled-inc/integrations');
    return {
      ...baseEnv,
      DOGSLED_BUNDLED_INTEGRATIONS_DIR: getIntegrationsDir(),
    };
  } catch {
    return baseEnv;
  }
}

async function commitCapturedState(
  capturePath: string,
  options: PipelineOptions,
  dependencies: PipelineDependencies,
  logStream: fs.WriteStream | undefined,
  redact: RedactPipelineValue,
  childEnv: NodeJS.ProcessEnv
): Promise<number> {
  const metaUrl = dependencies.metaUrl ?? import.meta.url;
  const invocation = resolveCliInvocation('extract', metaUrl, [
    'commit-state',
    '--integration',
    options.integration,
    '--capture-file',
    capturePath,
    '--log-format',
    'json',
    ...(options.verbose ? ['--verbose'] : []),
    ...(options.quiet ? ['--quiet'] : []),
    ...(options.stateBackend ? ['--state-backend', options.stateBackend] : []),
  ]);
  const child = spawnCommand(
    invocation,
    {
      cwd: getRuntimeCwd(dependencies),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: await buildExtractEnv(childEnv),
    },
    dependencies
  );
  const removeSignalHandlers = setupPipelineSignalForwarding([child], dependencies.signal);

  try {
    if (child.stderr) {
      const processChunk = createChunkProcessor(
        createPipelineSummary(),
        '',
        (line) => {
          writeLogLine(formatPipelineLogLine(line, options.logFormat), logStream);
        },
        redact
      );
      const flushChunk = () => processChunk.flush();
      child.stderr.on('data', processChunk.handle);
      child.stderr.on('end', flushChunk);
      child.stderr.on('close', flushChunk);
    }

    const result = await waitForProcess(child, 'extract commit-state CLI');
    return result.exitCode;
  } finally {
    removeSignalHandlers();
  }
}

export async function runPipeline(
  resourceNames: string[],
  options: PipelineOptions,
  dependencies: PipelineDependencies = {}
): Promise<number> {
  options = applyHostEnvironmentDeclarations(options, dependencies.env);
  const configuredDestinations = getDestinations(options);
  const runtimeEnv = getRuntimeEnv(dependencies);
  const { childEnv, redactionTokens } = preparePipelineWorkloadIdentity(
    options,
    configuredDestinations,
    runtimeEnv
  );
  const redact = createWorkloadIdentityRedactor(redactionTokens);
  try {
    throwIfPipelineAborted(dependencies.signal);
    if (options.reconcileSchema?.length && !options.fullRefresh) {
      throw new CommandError(
        '--reconcile-schema requires fullRefresh: true so the extractor and loader both run a full refresh.',
        2
      );
    }
    validatePipelineDestinations(
      configuredDestinations,
      options.dest ?? 'local',
      resourceNames,
      options.loadStrategy,
      options.tablePrefix,
      options.resourceLoadStrategy,
      options.resourceTable,
      options.reconcileSchema
    );
    if (configuredDestinations?.length) {
      return await runMultiDestPipeline(
        resourceNames,
        options,
        dependencies,
        redact,
        runtimeEnv,
        childEnv
      );
    }

    return await runSingleDestPipeline(
      resourceNames,
      options,
      dependencies,
      redact,
      runtimeEnv,
      childEnv
    );
  } catch (error) {
    throw redactPipelineError(error, redact);
  }
}

async function runSingleDestPipeline(
  resourceNames: string[],
  options: PipelineOptions,
  dependencies: PipelineDependencies,
  redact: RedactPipelineValue,
  runtimeEnv: NodeJS.ProcessEnv,
  childEnv: NodeJS.ProcessEnv
): Promise<number> {
  const metaUrl = dependencies.metaUrl ?? import.meta.url;
  const runtimeCwd = getRuntimeCwd(dependencies);
  const embedConfig = getEmbedConfig(options);
  const preparedEmbed = embedConfig ? prepareEmbedConfig(embedConfig) : undefined;
  const extractInvocation = resolveCliInvocation(
    'extract',
    metaUrl,
    buildPipelineExtractArgs(resourceNames, options, preparedEmbed?.configPath, false, childEnv)
  );
  const loadInvocation = resolveCliInvocation('load', metaUrl, buildLoadArgs(options));
  const extractEnv = await buildExtractEnv(childEnv);
  const embedInvocation = preparedEmbed
    ? resolveCliInvocation('embed', metaUrl, buildEmbedArgs(preparedEmbed.configPath, options))
    : undefined;
  const embedTmpDir = preparedEmbed?.tmpDir;
  const embedConfigPath = preparedEmbed?.configPath;

  // Register close/error settlement immediately after every spawn. If a later
  // spawn or pipe precondition fails, earlier children are terminated and
  // awaited before the public call rejects.
  const startedChildren: StartedPipelineChild[] = [];
  let extractChild: ChildProcess;
  let extractDone: Promise<ProcessResult>;
  let embedChild: ChildProcess | undefined;
  let embedDone: Promise<ProcessResult> | undefined;
  let loadChild: ChildProcess;
  let loadDone: Promise<ProcessResult>;
  try {
    throwIfPipelineAborted(dependencies.signal);
    extractChild = spawnCommand(
      extractInvocation,
      { cwd: runtimeCwd, stdio: ['ignore', 'pipe', 'pipe'], env: extractEnv },
      dependencies
    );
    extractDone = waitForProcess(extractChild, 'extract CLI');
    startedChildren.push({ name: 'extract', child: extractChild, done: extractDone });

    if (embedInvocation && embedTmpDir) {
      throwIfPipelineAborted(dependencies.signal);
      embedChild = spawnCommand(
        embedInvocation,
        {
          cwd: runtimeCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...childEnv, DOGSLED_EMBEDDER_TMP_DIR: embedTmpDir },
        },
        dependencies
      );
      embedDone = waitForProcess(embedChild, 'embed CLI');
      startedChildren.push({ name: 'embed', child: embedChild, done: embedDone });
    }

    throwIfPipelineAborted(dependencies.signal);
    loadChild = spawnCommand(
      loadInvocation,
      {
        cwd: runtimeCwd,
        stdio: ['pipe', 'inherit', 'pipe'],
        env: buildLoadEnv(childEnv, options, runtimeEnv),
      },
      dependencies
    );
    loadDone = waitForProcess(loadChild, 'load CLI');
    startedChildren.push({ name: 'load', child: loadChild, done: loadDone });

    if (
      !extractChild.stdout ||
      !loadChild.stdin ||
      (embedChild && (!embedChild.stdin || !embedChild.stdout))
    ) {
      throw new CommandError('Unable to create the extract/load pipeline.');
    }
  } catch (error) {
    await terminateAndSettlePipelineChildren(startedChildren);
    maybeRemoveFile(embedConfigPath);
    maybeRemoveDir(embedTmpDir);
    throw error;
  }

  // Track pipeline metrics from stderr for summary — each child gets its own
  // chunk processor to avoid interleaving partial lines across streams.
  const summary = createPipelineSummary();
  const tablePrefix = options.tablePrefix ?? '';

  let logStream: fs.WriteStream | undefined;
  if (options.logFile) {
    logStream = fs.createWriteStream(options.logFile, { flags: 'w' });
  }

  const pipelineChildren = embedChild
    ? [extractChild, embedChild, loadChild]
    : [extractChild, loadChild];
  const childStages: PipelineExecutionStage[] = embedChild
    ? ['extract', 'embed', 'load']
    : ['extract', 'load'];
  for (const [index, child] of pipelineChildren.entries()) {
    if (child.stderr) {
      const stage = childStages[index];
      const quietChild = options.quiet && stage !== 'load';
      const processChunk = createChunkProcessor(
        summary,
        tablePrefix,
        (line) => writePipelineLogLine(line, options.logFormat, logStream, quietChild),
        redact
      );
      const flushChunk = () => processChunk.flush();
      child.stderr.on('data', (chunk: Buffer) => {
        processChunk.handle(chunk);
        if (stage) dependencies.onSummary?.(stage, summary);
      });
      child.stderr.on('end', flushChunk);
      child.stderr.on('close', flushChunk);
    }
  }

  if (embedChild) {
    extractChild.stdout.pipe(embedChild.stdin!);
    embedChild.stdout!.pipe(loadChild.stdin);
  } else {
    extractChild.stdout.pipe(loadChild.stdin);
  }

  // Suppress EPIPE errors when one side of the pipeline exits before the other.
  extractChild.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  embedChild?.stdin?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  embedChild?.stdout?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  loadChild.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });

  // When extract exits, its stdout closes which signals EOF to the loader's
  // stdin via the pipe. The loader will finish processing and exit on its own.
  // Only kill extract if the loader exits early (e.g. an error).
  loadChild.on('close', () => {
    if (!extractChild.killed) extractChild.kill('SIGTERM');
    if (embedChild && !embedChild.killed) embedChild.kill('SIGTERM');
  });
  extractChild.on('close', (code) => {
    if ((code ?? 0) !== 0) {
      if (embedChild && !embedChild.killed) embedChild.kill('SIGTERM');
      if (!loadChild.killed) loadChild.kill('SIGTERM');
    }
  });
  embedChild?.on('close', (code) => {
    if ((code ?? 0) !== 0) {
      if (!extractChild.killed) extractChild.kill('SIGTERM');
      if (!loadChild.killed) loadChild.kill('SIGTERM');
    }
  });

  const removeSignalHandlers = setupPipelineSignalForwarding(
    embedChild ? [extractChild, embedChild, loadChild] : [extractChild, loadChild],
    dependencies.signal
  );

  try {
    dependencies.onStage?.('extract', 'started');
    if (embedChild) dependencies.onStage?.('embed', 'started');
    dependencies.onStage?.('load', 'started');
    const [extractResult, embedResult, loadResult] = await Promise.all([
      extractDone,
      embedDone ?? Promise.resolve(undefined),
      loadDone,
    ]);
    dependencies.onStage?.('extract', 'completed');
    if (embedChild) dependencies.onStage?.('embed', 'completed');
    dependencies.onStage?.('load', 'completed');
    dependencies.onSummary?.('load', summary);

    emitPipelineSummary(summary, options.integration, logStream);

    if (extractResult.exitCode !== 0) {
      return extractResult.exitCode;
    }

    if (embedResult && embedResult.exitCode !== 0) {
      return embedResult.exitCode;
    }

    if (loadResult.exitCode === 0) {
      maybeRemoveDir(embedTmpDir);
    }

    return loadResult.exitCode;
  } finally {
    removeSignalHandlers();
    maybeRemoveFile(embedConfigPath);
    maybeRemoveDir(embedTmpDir);
    logStream?.end();
  }
}

async function runMultiDestPipeline(
  resourceNames: string[],
  options: PipelineOptions,
  dependencies: PipelineDependencies,
  redact: RedactPipelineValue,
  runtimeEnv: NodeJS.ProcessEnv,
  childEnv: NodeJS.ProcessEnv
): Promise<number> {
  const metaUrl = dependencies.metaUrl ?? import.meta.url;
  const runtimeCwd = getRuntimeCwd(dependencies);
  const destinations = getDestinations(options)!;
  const embedConfig = getEmbedConfig(options);
  const preparedEmbed = embedConfig ? prepareEmbedConfig(embedConfig) : undefined;

  let logStream: fs.WriteStream | undefined;
  if (options.logFile) {
    logStream = fs.createWriteStream(options.logFile, { flags: 'w' });
  }

  for (const destination of destinations) {
    const effectiveLoadStrategy = options.fullRefresh
      ? 'full_refresh'
      : (options.loadStrategy ?? destination.load_strategy);
    if (effectiveLoadStrategy === 'append') {
      writeLogLine(
        JSON.stringify(
          buildLogMessage(
            'warn',
            `Destination "${destination.name}" uses append strategy; retries may produce duplicates.`
          )
        ),
        logStream
      );
    }
  }

  // Clean up stale capture directories from previous failed runs
  pruneStaleCaptureDirs();

  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-capture-'));
  fs.chmodSync(captureDir, 0o700);
  const capturePath = path.join(captureDir, 'output.jsonl');
  const captureStream = fs.createWriteStream(capturePath, { flags: 'wx', mode: 0o600 });
  const captureFinished = new Promise<void>((resolve, reject) => {
    captureStream.once('finish', resolve);
    captureStream.once('error', reject);
  });
  const summary = createPipelineSummary();
  const embedTmpDir = preparedEmbed?.tmpDir;
  const embedConfigPath = preparedEmbed?.configPath;

  // Initialize manifest
  const manifest = createManifest(options.integration, capturePath, destinations, {
    pipelineName: options.pipelineName,
  });
  const manifestPath = getManifestPath(captureDir);
  let commitAttempted = false;
  let preserveCapture = options.preserveCaptureOnFailure ?? true;

  writeLogLine(
    JSON.stringify(buildLogMessage('info', `Capture directory: ${captureDir}`)),
    logStream
  );

  const extractInvocation = resolveCliInvocation(
    'extract',
    metaUrl,
    buildPipelineExtractArgs(resourceNames, options, preparedEmbed?.configPath, true, childEnv)
  );
  const embedInvocation = preparedEmbed
    ? resolveCliInvocation('embed', metaUrl, buildEmbedArgs(preparedEmbed.configPath, options))
    : undefined;
  const producerChildren: StartedPipelineChild[] = [];
  let extractChild: ChildProcess;
  let extractDone: Promise<ProcessResult>;
  let embedChild: ChildProcess | undefined;
  let embedDone: Promise<ProcessResult> | undefined;
  try {
    throwIfPipelineAborted(dependencies.signal);
    extractChild = spawnCommand(
      extractInvocation,
      {
        cwd: runtimeCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: await buildExtractEnv(childEnv),
      },
      dependencies
    );
    extractDone = waitForProcess(extractChild, 'extract CLI');
    producerChildren.push({ name: 'extract', child: extractChild, done: extractDone });

    if (embedInvocation && embedTmpDir) {
      throwIfPipelineAborted(dependencies.signal);
      embedChild = spawnCommand(
        embedInvocation,
        {
          cwd: runtimeCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...childEnv, DOGSLED_EMBEDDER_TMP_DIR: embedTmpDir },
        },
        dependencies
      );
      embedDone = waitForProcess(embedChild, 'embed CLI');
      producerChildren.push({ name: 'embed', child: embedChild, done: embedDone });
    }

    if (!extractChild.stdout || (embedChild && (!embedChild.stdin || !embedChild.stdout))) {
      throw new CommandError('Unable to create capture stream for extractor output.');
    }
  } catch (error) {
    await terminateAndSettlePipelineChildren(producerChildren);
    captureStream.destroy();
    fs.rmSync(captureDir, { recursive: true, force: true });
    maybeRemoveFile(embedConfigPath);
    maybeRemoveDir(embedTmpDir);
    logStream?.end();
    throw error;
  }

  const removeExtractSignalHandlers = setupPipelineSignalForwarding(
    embedChild ? [extractChild, embedChild] : [extractChild],
    dependencies.signal
  );

  try {
    dependencies.onStage?.('extract', 'started');
    if (embedChild) dependencies.onStage?.('embed', 'started');
    const processExtractChunk = createChunkProcessor(
      summary,
      options.tablePrefix ?? '',
      (line) => writePipelineLogLine(line, options.logFormat, logStream, options.quiet),
      redact
    );
    if (extractChild.stderr) {
      const flushExtractChunk = () => processExtractChunk.flush();
      extractChild.stderr.on('data', (chunk: Buffer) => {
        processExtractChunk.handle(chunk);
        dependencies.onSummary?.('extract', summary);
      });
      extractChild.stderr.on('end', flushExtractChunk);
      extractChild.stderr.on('close', flushExtractChunk);
    }

    if (embedChild?.stderr) {
      const processEmbedChunk = createChunkProcessor(
        summary,
        options.tablePrefix ?? '',
        (line) => writePipelineLogLine(line, options.logFormat, logStream, options.quiet),
        redact
      );
      const flushEmbedChunk = () => processEmbedChunk.flush();
      embedChild.stderr.on('data', (chunk: Buffer) => {
        processEmbedChunk.handle(chunk);
        dependencies.onSummary?.('embed', summary);
      });
      embedChild.stderr.on('end', flushEmbedChunk);
      embedChild.stderr.on('close', flushEmbedChunk);
    }

    if (embedChild) {
      extractChild.stdout.pipe(embedChild.stdin!);
      embedChild.stdout!.pipe(captureStream);
      embedChild.stdin!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') throw err;
      });
      embedChild.stdout!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') throw err;
      });
    } else {
      extractChild.stdout.pipe(captureStream);
    }
    extractChild.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
    });
    captureStream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
    });

    extractChild.on('close', (code) => {
      if ((code ?? 0) !== 0 && embedChild && !embedChild.killed) {
        embedChild.kill('SIGTERM');
      }
    });
    embedChild?.on('close', (code) => {
      if ((code ?? 0) !== 0 && !extractChild.killed) {
        extractChild.kill('SIGTERM');
      }
    });

    const [extractResult, embedResult] = await Promise.all([
      extractDone,
      embedDone ?? Promise.resolve(undefined),
    ]);
    dependencies.onStage?.('extract', 'completed');
    if (embedChild) dependencies.onStage?.('embed', 'completed');
    dependencies.onSummary?.(embedChild ? 'embed' : 'extract', summary);
    await captureFinished;

    // Checkpoint 1: extraction complete
    const extractExitCode = extractResult.exitCode;
    const producerExitCode = embedResult?.exitCode ?? extractExitCode;
    manifest.extractor_exit_code = producerExitCode;
    writeManifestCheckpoint(manifestPath, manifest, logStream);

    if (extractExitCode !== 0) {
      manifest.commit_state = { status: 'skipped' };
      emitPipelineSummary(summary, options.integration, logStream);
      return extractExitCode;
    }
    if (embedResult && embedResult.exitCode !== 0) {
      manifest.commit_state = { status: 'skipped' };
      emitPipelineSummary(summary, options.integration, logStream);
      return embedResult.exitCode;
    }

    const loadChildren: ChildProcess[] = [];
    const startedLoads: StartedPipelineChild[] = [];
    const removeLoadSignalHandlers = setupPipelineSignalForwarding(
      loadChildren,
      dependencies.signal
    );

    let loaderResults: DestinationResult[];
    try {
      throwIfPipelineAborted(dependencies.signal);
      dependencies.onStage?.('load', 'started');
      loaderResults = await Promise.all(
        destinations.map(async (destination) => {
          throwIfPipelineAborted(dependencies.signal);
          const loadInvocation = resolveCliInvocation(
            'load',
            metaUrl,
            buildLoadArgsForDestination(destination, options, runtimeEnv)
          );
          const loadChild = spawnCommand(
            loadInvocation,
            {
              cwd: runtimeCwd,
              stdio: ['pipe', 'ignore', 'pipe'],
              env: buildDestinationLoadEnv(childEnv, destination, runtimeEnv),
            },
            dependencies
          );
          loadChildren.push(loadChild);
          const loaderSummary = createPipelineSummary();
          let lastLogLine: string | undefined;
          let lastErrorLine: string | undefined;
          const startedLoad: StartedPipelineChild = {
            name: destination.name,
            child: loadChild,
            done: waitForProcess(loadChild, `load CLI (${destination.name})`),
            summary: loaderSummary,
            getLastError: () => lastErrorLine ?? lastLogLine,
          };
          startedLoads.push(startedLoad);

          if (!loadChild.stdin) {
            throw new CommandError(
              `Unable to create loader stdin for destination "${destination.name}".`
            );
          }

          // Each loader gets its own summary to avoid conflating metrics across destinations
          const processLoadChunk = createChunkProcessor(
            loaderSummary,
            destination.table_prefix ?? options.tablePrefix ?? '',
            (line) => {
              lastLogLine = line;
              lastErrorLine = extractErrorMessage(line) ?? lastErrorLine;
              writeLogLine(
                formatDestinationLogLine(line, destination.name, options.logFormat),
                logStream
              );
            },
            redact
          );
          if (loadChild.stderr) {
            const flushLoadChunk = () => processLoadChunk.flush();
            loadChild.stderr.on('data', (chunk: Buffer) => {
              processLoadChunk.handle(chunk);
              const progressSummary = clonePipelineSummary(summary);
              mergeSummary(progressSummary, loaderSummary);
              dependencies.onSummary?.('load', progressSummary);
            });
            loadChild.stderr.on('end', flushLoadChunk);
            loadChild.stderr.on('close', flushLoadChunk);
          }

          const replayStream = fs.createReadStream(capturePath);
          const stopReplay = () => {
            if (!replayStream.destroyed) {
              replayStream.destroy();
            }
          };
          startedLoad.replayDone = waitForReplayStream(replayStream);
          startedLoad.stopReplay = stopReplay;

          replayStream.pipe(loadChild.stdin);
          loadChild.stdin.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code !== 'EPIPE') throw err;
          });
          loadChild.once('close', stopReplay);

          const loadResult = await startedLoad.done;
          await startedLoad.replayDone;
          const exitCode = loadResult.exitCode;

          if (exitCode === 0) {
            emitLoadCountWarnings(summary, loaderSummary, destination, (line) => {
              writeLogLine(line, logStream);
            });
          }

          mergeSummary(summary, loaderSummary);
          const error = exitCode === 0 ? undefined : startedLoad.getLastError?.();
          updateManifestDestination(
            manifest,
            destination.name,
            exitCode,
            loaderSummary,
            error,
            loadResult.signal
          );
          writeManifestCheckpoint(manifestPath, manifest, logStream);
          return {
            exitCode,
            name: destination.name,
            error,
            summary: loaderSummary,
          } satisfies DestinationResult;
        })
      );
      dependencies.onStage?.('load', 'completed');
      dependencies.onSummary?.('load', summary);
    } catch (error) {
      await terminateAndSettlePipelineChildren(startedLoads);
      const doneSettled = await Promise.allSettled(startedLoads.map((load) => load.done));
      await Promise.allSettled(
        startedLoads.flatMap((load) => (load.replayDone ? [load.replayDone] : []))
      );
      for (let index = 0; index < startedLoads.length; index += 1) {
        const load = startedLoads[index];
        const doneResult = doneSettled[index];
        if (!load || !doneResult || !load.summary) {
          continue;
        }

        if (doneResult.status === 'fulfilled') {
          updateManifestDestination(
            manifest,
            load.name,
            doneResult.value.exitCode,
            load.summary,
            load.getLastError?.(),
            doneResult.value.signal
          );
        } else {
          updateManifestDestination(
            manifest,
            load.name,
            1,
            load.summary,
            load.getLastError?.() ?? redact(getProcessFailureMessage(doneResult.reason))
          );
        }
        writeManifestCheckpoint(manifestPath, manifest, logStream);
      }
      throw error;
    } finally {
      removeLoadSignalHandlers();
    }

    emitPipelineSummary(summary, options.integration, logStream);

    const failedDestinations = loaderResults.filter((result) => result.exitCode !== 0);
    if (failedDestinations.length > 0) {
      manifest.commit_state = { status: 'skipped' };
      const exitCode = Math.max(...failedDestinations.map((result) => result.exitCode));
      writeLogLine(
        JSON.stringify(
          buildLogMessage(
            'error',
            `Multi-destination load failed for: ${failedDestinations.map((result) => result.name).join(', ')}`
          )
        ),
        logStream
      );
      return exitCode;
    }

    // Preview runs intentionally never advance durable cursor state. The
    // extractor still emits STATE into the capture stream so loaders can
    // consume a valid protocol, but committing that truncated cursor would
    // make the next full run skip records beyond the preview bound.
    if (options.limit !== undefined) {
      manifest.commit_state = { status: 'skipped' };
      preserveCapture = false;
      maybeRemoveDir(embedTmpDir);
      return 0;
    }

    throwIfPipelineAborted(dependencies.signal);
    dependencies.onStage?.('state', 'started');
    let commitExitCode: number;
    try {
      commitAttempted = true;
      commitExitCode = await commitCapturedState(
        capturePath,
        options,
        dependencies,
        logStream,
        redact,
        childEnv
      );
    } catch (error) {
      manifest.commit_state = { status: 'failed' };
      throw error;
    }
    if (commitExitCode !== 0) {
      dependencies.onStage?.('state', 'completed');
      manifest.commit_state = { status: 'failed', exit_code: commitExitCode };
      writeLogLine(
        JSON.stringify(
          buildLogMessage('error', 'Failed to commit extractor state after multi-destination load.')
        ),
        logStream
      );
      return commitExitCode;
    }

    manifest.commit_state = { status: 'success', exit_code: 0 };
    dependencies.onStage?.('state', 'completed');
    preserveCapture = false;
    maybeRemoveDir(embedTmpDir);
    return 0;
  } finally {
    removeExtractSignalHandlers();

    // Finalize manifest
    if (!commitAttempted && manifest.commit_state.status === 'pending') {
      manifest.commit_state = { status: 'skipped' };
    }
    manifest.completed_at = new Date().toISOString();
    writeManifestCheckpoint(manifestPath, manifest, logStream);

    if (preserveCapture) {
      // Preserve capture for debugging/replay
      writeLogLine(
        JSON.stringify(
          buildLogMessage(
            'warn',
            `Capture preserved at ${captureDir} - contains raw API data, remove when no longer needed`
          )
        ),
        logStream
      );
      if (embedTmpDir) {
        writeLogLine(
          JSON.stringify(
            buildLogMessage('warn', `Embedder temp files preserved at ${embedTmpDir}`)
          ),
          logStream
        );
      }
    } else {
      fs.rmSync(captureDir, { recursive: true, force: true });
    }

    if (!preserveCapture) {
      maybeRemoveFile(embedConfigPath);
    }
    logStream?.end();
  }
}

export function registerPipelineCommand(
  program: Command,
  run: (
    resourceNames: string[],
    options: PipelineOptions,
    dependencies?: PipelineDependencies
  ) => Promise<number> = runPipeline
): void {
  const pipeline = program
    .command('pipeline')
    .description('Pipe extractor output directly into the loader')
    .requiredOption('--integration <name>', 'Integration to extract from')
    .option('--resource <name...>', 'Resource names to extract (default: all)')
    .option('--format <format>', 'Output format: jsonl, csv, parquet, or arrow')
    .option('--output-dir <dir>', 'Local output directory', './output')
    .option(
      '--dest <dest>',
      'Destination: local, gcs, s3, duckdb, bigquery, snowflake, databricks, postgres, mysql, clickhouse, or turbopuffer'
    )
    .option('--gcs-bucket <bucket>', 'GCS bucket name')
    .option('--gcs-prefix <prefix>', 'GCS object prefix')
    .option('--s3-bucket <bucket>', 'S3 bucket name')
    .option('--s3-prefix <prefix>', 'S3 object prefix')
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--target-schema <schema>', 'Database target schema')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option('--bq-access-token <token>', 'BigQuery pre-minted OAuth token (overrides key-filename)')
    .option('--sf-account <account>', 'Snowflake account identifier')
    .option('--sf-username <user>', 'Snowflake username')
    .option('--sf-password <pass>', 'Snowflake password')
    .option('--sf-private-key-path <path>', 'Path to Snowflake private key file')
    .option('--sf-private-key-passphrase <pass>', 'Passphrase for Snowflake private key')
    .option('--sf-access-token <token>', 'Snowflake pre-minted OIDC JWT')
    .option(
      '--sf-workload-identity-token <env>',
      'Snowflake workload identity token environment variable reference',
      parseSnowflakeWorkloadIdentityToken
    )
    .option(
      '--sf-token-command <command>',
      'Snowflake command printing JSON {"access_token","expires_at"}; takes precedence over --sf-access-token'
    )
    .option('--sf-warehouse <wh>', 'Snowflake warehouse')
    .option('--sf-database <db>', 'Snowflake database')
    .option('--sf-role <role>', 'Snowflake role');

  addDatabaseDestinationOptions(pipeline);

  pipeline
    .option('--load-strategy <strategy>', 'Database load strategy: append, merge, or full_refresh')
    .option('--table-prefix <prefix>', 'Prefix prepended to all table names (e.g. "vantage__")')
    .option('--full-refresh', 'Ignore bookmarks and extract from the beginning')
    .option(
      '--start-date <date>',
      'Backfill start date passed to the extractor as input.start_date'
    )
    .option('--end-date <date>', 'Backfill end date passed to the extractor as input.end_date')
    .option('--batch', 'Enable batch output')
    .option('--batch-format <format>', 'Batch file format: jsonl or parquet', parseBatchFormat)
    .option('--batch-size <count>', 'Records per batch file', parsePositiveInt)
    .option(
      '--buffer-size <count>',
      'Number of records to buffer before flushing in streaming mode',
      parsePositiveInt
    )
    .option('--emit-model-spec-source', 'Generate Model Spec source YAML alongside extraction')
    .option('--input <key=value>', 'Input override values', collectInput, [])
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-file <path>', 'Write all stderr logs to a file (in addition to terminal)')
    .option('--log-format <format>', 'Control log format: json or pretty')
    .option('--embed-config-json <json>', 'Serialized embedder configuration payload')
    .action(async (options: PipelineOptions) => {
      const exitCode = await run(options.resource ?? [], options);
      process.exitCode = exitCode;
    });

  pipeline.addOption(new Option('--pipeline-name <name>').hideHelp());
  pipeline.addOption(new Option('--destinations-json <json>').hideHelp());
}
