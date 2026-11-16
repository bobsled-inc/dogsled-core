import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandError, EXIT_VALIDATION, PROTOCOL_VERSION } from '@bobsled-inc/protocol';

import type { NamedDestination } from '../runner/config/schema.js';
import type { FanOutManifest } from '../runner/manifest.js';
import type { LogMessage } from '@bobsled-inc/protocol';

export interface FanOutStreamSummaryLike {
  records_emitted: number;
  rows_loaded: number;
}

export interface FanOutPipelineSummaryLike {
  streams: Map<string, FanOutStreamSummaryLike>;
}

const DESTINATION_MERGE_SUPPORT: ReadonlySet<string> = new Set([
  'duckdb',
  'bigquery',
  'snowflake',
  'postgres',
  'mysql',
  'clickhouse',
  'turbopuffer',
]);
const FILE_DESTINATIONS: ReadonlySet<string> = new Set(['local', 'gcs', 's3']);

interface DestinationCapabilities {
  name: string;
  type: string;
  load_strategy?: NamedDestination['load_strategy'];
  table_prefix?: string;
}

const STALE_CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function validateDestinationCapabilities(
  destinations: DestinationCapabilities[],
  defaultLoadStrategy?: NamedDestination['load_strategy'],
  /**
   * Per-resource load-strategy overrides (resolved resource name → strategy).
   * They beat both the destination-level and pipeline-level strategy at load
   * time, so a `merge` override has to clear the same capability gate.
   */
  resourceLoadStrategy?: Record<string, NonNullable<NamedDestination['load_strategy']>>,
  /** Per-resource table overrides are meaningful only for database destinations. */
  resourceTable?: Record<string, string>
): void {
  const strategyEntries = Object.entries(resourceLoadStrategy ?? {});
  const strategyResources = strategyEntries.map(([resource]) => resource).sort();
  const mergeResources = strategyEntries
    .filter(([, strategy]) => strategy === 'merge')
    .map(([resource]) => resource)
    .sort();
  const tableResources = Object.keys(resourceTable ?? {}).sort();
  for (const destination of destinations) {
    const supportsMerge = DESTINATION_MERGE_SUPPORT.has(destination.type);
    const effectiveStrategy = defaultLoadStrategy ?? destination.load_strategy;
    if (effectiveStrategy === 'merge' && !supportsMerge) {
      throw new CommandError(
        `Destination "${destination.name}" (${destination.type}) does not support merge strategy.`,
        EXIT_VALIDATION
      );
    }
    if (mergeResources.length > 0 && !supportsMerge) {
      throw new CommandError(
        `Destination "${destination.name}" (${destination.type}) does not support merge strategy, ` +
          `requested by per-resource load_strategy on [${mergeResources.join(', ')}].`,
        EXIT_VALIDATION
      );
    }
    if (FILE_DESTINATIONS.has(destination.type) && strategyResources.length > 0) {
      throw new CommandError(
        `Destination "${destination.name}" (${destination.type}) does not support per-resource ` +
          `load_strategy overrides, requested on [${strategyResources.join(', ')}].`,
        EXIT_VALIDATION
      );
    }
    if (FILE_DESTINATIONS.has(destination.type) && tableResources.length > 0) {
      throw new CommandError(
        `Destination "${destination.name}" (${destination.type}) does not support per-resource ` +
          `table overrides, requested on [${tableResources.join(', ')}].`,
        EXIT_VALIDATION
      );
    }
  }
}

/**
 * Reject ambiguous final-table routing before any extractor or loader starts.
 * The loader keys schemas, buffers, strategies, and checkpoints by final table;
 * allowing two raw resources to converge would mix their state and leak one
 * resource's strategy into its sibling.
 */
export function validateResourceTableTargets(
  destinations: DestinationCapabilities[],
  resourceNames: string[],
  defaultTablePrefix: string | undefined,
  resourceTable: Record<string, string> | undefined
): void {
  if (resourceNames.length === 0) return;
  for (const destination of destinations) {
    if (FILE_DESTINATIONS.has(destination.type)) continue;
    const prefix = destination.table_prefix ?? defaultTablePrefix ?? '';
    const owners = new Map<string, string>();
    for (const resource of resourceNames) {
      const table = resourceTable?.[resource] ?? `${prefix}${resource}`;
      const existing = owners.get(table);
      if (existing && existing !== resource) {
        throw new CommandError(
          `Destination "${destination.name}" maps resources "${existing}" and "${resource}" ` +
            `to the same table "${table}". Give each resource a distinct table override.`,
          EXIT_VALIDATION
        );
      }
      owners.set(table, resource);
    }
  }
}

export function validatePipelineDestinations(
  configuredDestinations: DestinationCapabilities[] | undefined,
  singleDestinationType: string,
  resourceNames: string[],
  defaultLoadStrategy: NamedDestination['load_strategy'] | undefined,
  defaultTablePrefix: string | undefined,
  resourceLoadStrategy: Record<string, NonNullable<NamedDestination['load_strategy']>> | undefined,
  resourceTable: Record<string, string> | undefined,
  reconcileSchema: readonly string[] | undefined
): void {
  const destinations =
    configuredDestinations && configuredDestinations.length > 0
      ? configuredDestinations
      : [{ name: 'destination', type: singleDestinationType }];
  validateDestinationCapabilities(
    destinations,
    defaultLoadStrategy,
    resourceLoadStrategy,
    resourceTable
  );
  if (reconcileSchema && reconcileSchema.length > 0) {
    const unsupported = destinations.filter((destination) => destination.type !== 'snowflake');
    if (unsupported.length > 0) {
      throw new CommandError(
        '--reconcile-schema is only supported for Snowflake destinations. ' +
          `Unsupported destination(s): ${unsupported.map((destination) => destination.name).join(', ')}.`,
        EXIT_VALIDATION
      );
    }
  }
  validateResourceTableTargets(destinations, resourceNames, defaultTablePrefix, resourceTable);
}

export function pruneStaleCaptureDirs(
  tmpDir: string = os.tmpdir(),
  maxAgeMs: number = STALE_CAPTURE_MAX_AGE_MS
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith('bobsled-capture-')) {
      continue;
    }

    const fullPath = path.join(tmpDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory() || !hasCompletedManifest(fullPath)) {
        continue;
      }

      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore ENOENT races or permission errors.
    }
  }
}

export function extractErrorMessage(line: string): string | undefined {
  if (!line.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(line);
    if (!isErrorLogLine(parsed)) {
      return undefined;
    }

    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
    if (typeof parsed.event === 'string') {
      return parsed.event;
    }
  } catch {
    // Ignore non-JSON log lines.
  }

  return undefined;
}

export function updateManifestDestination(
  manifest: FanOutManifest,
  destinationName: string,
  exitCode: number,
  summary: FanOutPipelineSummaryLike,
  error?: string,
  signal: NodeJS.Signals | null = null
): void {
  const entry = manifest.destinations.find((destination) => destination.name === destinationName);
  if (!entry) {
    return;
  }

  entry.status = getDestinationStatus(exitCode, signal);
  entry.exit_code = exitCode;
  entry.rows_loaded = getRowsLoaded(summary);

  if (error) {
    entry.error = error;
  }
}

export function emitLoadCountWarnings(
  extractSummary: FanOutPipelineSummaryLike,
  loaderSummary: FanOutPipelineSummaryLike,
  destination: { name: string; type: string },
  log: (line: string) => void
): void {
  const destinationName = destination.name;
  for (const [streamName, extractStream] of extractSummary.streams) {
    if (extractStream.records_emitted === 0) {
      continue;
    }

    const loadedStream = loaderSummary.streams.get(streamName);
    const rowsLoaded = loadedStream?.rows_loaded ?? 0;
    let message: string | undefined;

    if (!loadedStream && FILE_DESTINATIONS.has(destination.type)) {
      continue;
    } else if (!loadedStream) {
      message = `Destination "${destinationName}" did not report any loaded rows for stream "${streamName}" after extracting ${extractStream.records_emitted} records.`;
    } else if (extractStream.records_emitted !== rowsLoaded) {
      message = `Destination "${destinationName}" loaded ${rowsLoaded} rows for stream "${streamName}" after extracting ${extractStream.records_emitted} records.`;
    }

    if (message) {
      log(
        JSON.stringify({
          _v: PROTOCOL_VERSION,
          type: 'LOG',
          level: 'warn',
          message,
          time: new Date().toISOString(),
        } satisfies LogMessage)
      );
    }
  }
}

function hasCompletedManifest(captureDir: string): boolean {
  try {
    const manifestPath = path.join(captureDir, 'manifest.json');
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return hasCompletedAt(manifest);
  } catch {
    return false;
  }
}

function getDestinationStatus(
  exitCode: number,
  signal: NodeJS.Signals | null = null
): 'success' | 'failed' | 'killed' {
  if (exitCode === 0) {
    return 'success';
  }
  if (signal !== null) {
    return 'killed';
  }
  return 'failed';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorLogLine(
  value: unknown
): value is { event?: string; level: 'error'; message?: string } {
  return (
    isObjectRecord(value) &&
    value.level === 'error' &&
    (typeof value.message === 'string' || typeof value.event === 'string')
  );
}

function hasCompletedAt(value: unknown): value is Pick<FanOutManifest, 'completed_at'> {
  return (
    isObjectRecord(value) && typeof value.completed_at === 'string' && value.completed_at.length > 0
  );
}

function getRowsLoaded(summary: FanOutPipelineSummaryLike): Record<string, number> | undefined {
  const rowsLoaded = Object.fromEntries(
    [...summary.streams.entries()]
      .filter(([, stream]) => stream.rows_loaded > 0)
      .map(([name, stream]) => [name, stream.rows_loaded])
  );

  return Object.keys(rowsLoaded).length > 0 ? rowsLoaded : undefined;
}
