import {
  CommandError,
  type LoadStrategy,
  type SchemaBehavior,
  type SchemaMessage,
} from '@bobsled-inc/protocol';

import {
  assertNonEmptyColumns,
  type EnsureTableOptions,
} from '../runtime/destinations/database.js';
import { resolveTargetConfig } from '../runtime/target-loader.js';
import { LoaderConfigSchema, type LoaderConfig } from '../schemas/config.js';
import { buildConfigInput } from './run-cli.js';
import type { DatabaseDestConfig } from './run-database-destination.js';
import type { RunDryRunOptions } from './run-dry-run.js';

/** Return the explicitly selected Snowflake streams, rejecting other destinations. */
export function resolveReconcileSchemaStreams(rawConfig: DatabaseDestConfig): Set<string> {
  const configured = (rawConfig as unknown as { reconcileSchema?: unknown }).reconcileSchema;
  if (rawConfig.dest !== 'snowflake' && Array.isArray(configured) && configured.length > 0) {
    throw new CommandError('--reconcile-schema is only supported for Snowflake destinations.', 2);
  }
  return new Set(rawConfig.dest === 'snowflake' ? (rawConfig.reconcileSchema ?? []) : []);
}

/** Return CLI-selected stream names in a stable, typed form. */
export function requestedReconcileSchema(options: Record<string, unknown>): string[] {
  return Array.isArray(options.reconcileSchema) ? (options.reconcileSchema as string[]) : [];
}

/** Validate the destination before a dry run or a target config is resolved. */
export function assertReconcileSchemaDestination(
  destination: unknown,
  streams: readonly string[]
): void {
  if (streams.length > 0 && destination !== 'snowflake') {
    throw new CommandError('--reconcile-schema is only supported for Snowflake destinations.', 2);
  }
}

/** Validate a schema and record whether this SCHEMA message is selected. */
export function prepareReconcileSchemaMessage(
  message: SchemaMessage,
  effectiveStrategy: LoadStrategy,
  selectedStreams: ReadonlySet<string>,
  seenStreams: Set<string>
): boolean {
  assertNonEmptyColumns(message.stream, message.schema.columns);
  const selected = selectedStreams.has(message.stream);
  if (selected && effectiveStrategy !== 'full_refresh') {
    throw new CommandError(
      `--reconcile-schema stream "${message.stream}" requires effective load strategy "full_refresh".`,
      2
    );
  }
  if (selected) {
    seenStreams.add(message.stream);
  }
  return selected;
}

/** Build the per-schema options consumed by DatabaseDestination.ensureTable. */
export function buildEnsureTableOptions(
  message: SchemaMessage,
  cliSchemaBehavior: SchemaBehavior | undefined,
  reconcileSchema: boolean,
  effectiveStrategy: LoadStrategy,
  streamSchemaBehavior?: SchemaBehavior,
  tableOwnershipMarker?: string
): EnsureTableOptions {
  return {
    keyProperties: message.key_properties,
    cursorField: message.cursor_field,
    partitionBy: message.partition_by,
    loadStrategy: effectiveStrategy,
    schemaBehavior: streamSchemaBehavior ?? cliSchemaBehavior ?? message.schema_behavior,
    ...(reconcileSchema ? { reconcileSchema: true } : {}),
    ...(tableOwnershipMarker === undefined ? {} : { tableOwnershipMarker }),
  };
}

/** Fail when an explicitly selected stream never emitted a SCHEMA message. */
export function assertReconcileSchemaStreamsFound(
  selectedStreams: ReadonlySet<string>,
  seenStreams: ReadonlySet<string>
): void {
  const missing = [...selectedStreams].filter((stream) => !seenStreams.has(stream));
  if (missing.length > 0) {
    throw new CommandError(
      `--reconcile-schema stream(s) not found in input: ${missing.join(', ')}`,
      2
    );
  }
}

export function resolveRunOptions(
  options: Record<string, unknown>,
  command: { getOptionValueSource(key: string): string | undefined }
): Record<string, unknown> {
  return options.loadFile || options.loadIntegration
    ? Object.fromEntries(
        Object.entries(options).filter(([key]) => command.getOptionValueSource(key) !== 'default')
      )
    : options;
}

export function resolveDryRunOptions(
  options: RunDryRunOptions & Record<string, unknown>,
  targetConfig?: LoaderConfig
) {
  return targetConfig
    ? {
        ...options,
        ...targetConfig,
        streamLoadStrategy:
          'streamLoadStrategies' in targetConfig ? targetConfig.streamLoadStrategies : undefined,
        streamTable: 'streamTables' in targetConfig ? targetConfig.streamTables : undefined,
      }
    : options;
}

/** Resolve target/integration config and apply CLI reconciliation overrides. */
export async function resolveRunConfig(options: Record<string, unknown>): Promise<LoaderConfig> {
  const requested = requestedReconcileSchema(options);
  const cliOwnershipMarkers = options.streamTableOwnershipMarker as
    Record<string, string> | undefined;
  const hasCliOwnershipMarkers =
    cliOwnershipMarkers !== undefined && Object.keys(cliOwnershipMarkers).length > 0;
  const targetConfig = await resolveTargetConfig(
    {
      targetFile: options.loadFile as string | undefined,
      loadIntegration: options.loadIntegration as string | undefined,
    },
    process.env,
    process.cwd()
  );

  if (!targetConfig) {
    const configInput = buildConfigInput(options);
    if (hasCliOwnershipMarkers) {
      assertOwnershipMarkerDestination(configInput.dest);
    }
    return LoaderConfigSchema.parse(configInput);
  }

  const runtimeKeys = new Set([
    'tablePrefix',
    'loadStrategy',
    'schemaBehavior',
    'bufferSize',
    'logFormat',
    'maxConcurrentLoads',
    'checkpointDir',
    'maxBufferMemory',
    'memoryLimit',
    'streamLoadStrategy',
    'streamSchemaBehavior',
    'streamTable',
    'streamTableOwnershipMarker',
    'reconcileSchema',
    'targetFileSize',
    'stagingFormat',
    'metricsFile',
    'maxLoadJobs',
  ]);
  const connectionKeys =
    /^(?:sf|postgres|mysql|databricks|ducklake|gcs|s3|clickhouse|turbopuffer|elasticsearch|chroma|pgvector|bq)[A-Z]|^(?:dest|dbPath|targetSchema|projectId|datasetId|location|keyFilename|outputDir)$/;
  const rejected = Object.keys(options).find(
    (key) => options[key] !== undefined && connectionKeys.test(key)
  );
  if (rejected) {
    const flag = rejected.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    throw new CommandError(
      `--${flag} cannot override a named integration or load file. Configure its connection and authentication in the integration.`,
      2
    );
  }
  const runtimeOptions = Object.fromEntries(
    Object.entries(options).filter(([key]) => runtimeKeys.has(key))
  );
  const cliConfig = buildConfigInput({ ...runtimeOptions, dest: targetConfig.dest });
  const cliOverrides = Object.fromEntries(
    Object.entries(cliConfig).filter(([key, value]) => key !== 'dest' && value !== undefined)
  );
  const resolvedTarget = { ...targetConfig, ...cliOverrides } as LoaderConfig;

  // Bobsled Core sends per-resource ownership markers as repeatable CLI overrides
  // even when the connection itself comes from a named target/integration.
  // Preserve target-file markers and let an explicit CLI value win.
  if (hasCliOwnershipMarkers) {
    assertOwnershipMarkerDestination(resolvedTarget.dest);
  }
  const targetWithOwnershipMarkers = hasCliOwnershipMarkers
    ? {
        ...resolvedTarget,
        streamTableOwnershipMarkers: {
          ...('streamTableOwnershipMarkers' in targetConfig
            ? targetConfig.streamTableOwnershipMarkers
            : {}),
          ...cliOwnershipMarkers,
        },
      }
    : resolvedTarget;

  const targetStreams = Array.isArray(
    (targetWithOwnershipMarkers as Record<string, unknown>).reconcileSchema
  )
    ? ((targetWithOwnershipMarkers as Record<string, unknown>).reconcileSchema as string[])
    : [];
  const reconcileSchema = requested.length > 0 ? requested : targetStreams;
  assertReconcileSchemaDestination(targetWithOwnershipMarkers.dest, reconcileSchema);
  return LoaderConfigSchema.parse(
    reconcileSchema.length > 0
      ? { ...targetWithOwnershipMarkers, reconcileSchema }
      : targetWithOwnershipMarkers
  );
}

function assertOwnershipMarkerDestination(destination: unknown): void {
  if (
    destination !== 'snowflake' &&
    destination !== 'bigquery' &&
    destination !== 'postgres' &&
    destination !== 'databricks'
  ) {
    throw new CommandError(
      '--stream-table-ownership-marker is only supported for Snowflake, BigQuery, Postgres, and Databricks destinations.',
      2
    );
  }
}
