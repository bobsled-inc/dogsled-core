import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { DatabaseDestConfig } from '@bobsled-inc/loader';
import type { SourceRegistryEntry } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';
import YAML from 'yaml';
import { z } from 'zod';

import { sourceNameOf } from './load-specs.js';
import { IDENTIFIER_PATTERN, validateIdentifier } from './sql-utils.js';

export interface ResolvedDestination {
  kind: 'bigquery' | 'snowflake' | 'duckdb' | 'ducklake' | 'in_memory';
  schema: string;
  table: string;
  fullyQualified: string;
  config: DatabaseDestConfig;
  sqlRunnerKind: 'bigquery' | 'snowflake' | 'duckdb';
}

export interface ResolveDestinationArgs {
  entry: Extract<SourceRegistryEntry, { kind: 'api_resource' }>;
  projectRoot: string;
  /**
   * Optional injected default destination. When provided it bypasses the
   * `.dogsled/config.yml` read so library callers can drive the engine without
   * an on-disk project config. `dest` selects the destination kind; remaining
   * fields mirror the `default_destination` block. When a SQL runner is
   * injected separately, credentials here may be omitted.
   */
  defaultDestination?: { dest: string } & Record<string, unknown>;
}

const ProjectConfigSchema = z
  .object({
    default_destination: z.object({ dest: z.string() }).passthrough().optional(),
  })
  .passthrough();

function toIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  if (!IDENTIFIER_PATTERN.test(prefixed)) {
    throw new CommandError(`Could not sanitize source name "${value}" to a SQL identifier`, 2);
  }
  return prefixed;
}

function stringField(config: Record<string, unknown>, field: string): string | undefined {
  const value = config[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

async function readProjectDefault(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(join(root, '.dogsled', 'config.yml'), 'utf8');
    return ProjectConfigSchema.parse(YAML.parse(text)).default_destination;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function resolveDestinationFor(
  args: ResolveDestinationArgs
): Promise<ResolvedDestination> {
  const sourceName = sourceNameOf(args.entry);
  const table = toIdentifier(sourceName);
  const schemaOverride = args.entry.destination?.schema;
  if (schemaOverride) validateIdentifier(schemaOverride);

  if (args.entry.mode === 'live') {
    const schema = schemaOverride ?? 'sources';
    validateIdentifier(schema);
    const config: DatabaseDestConfig = {
      dest: 'duckdb',
      dbPath: ':memory:',
      targetSchema: schema,
      bufferSize: 100_000,
      logFormat: 'json',
      maxConcurrentLoads: 1,
    };
    return {
      kind: 'in_memory',
      schema,
      table,
      fullyQualified: `${schema}.${table}`,
      config,
      sqlRunnerKind: 'duckdb',
    };
  }

  const projectDefault = args.defaultDestination ?? (await readProjectDefault(args.projectRoot));
  const defaults = projectDefault ?? {};
  const destKind = stringField(defaults, 'dest') ?? 'ducklake';

  if (destKind === 'bigquery') {
    const projectId = stringField(defaults, 'projectId') ?? stringField(defaults, 'project');
    const datasetId =
      schemaOverride ?? stringField(defaults, 'datasetId') ?? stringField(defaults, 'dataset');
    if (!datasetId) {
      throw new CommandError('bigquery default_destination requires datasetId (or dataset)', 2);
    }
    validateIdentifier(datasetId);
    const config: DatabaseDestConfig = {
      dest: 'bigquery',
      projectId,
      datasetId,
      location: stringField(defaults, 'location'),
      keyFilename: stringField(defaults, 'keyFilename'),
      bufferSize: 100_000,
      logFormat: 'json',
      targetFileSizeMb: 256,
      stagingFormat: 'parquet',
      maxConcurrentLoads: 4,
      maxLoadJobs: 9000,
    };
    return {
      kind: 'bigquery',
      schema: datasetId,
      table,
      fullyQualified: `${datasetId}.${table}`,
      config,
      sqlRunnerKind: 'bigquery',
    };
  }

  if (destKind === 'snowflake') {
    const account = stringField(defaults, 'account');
    const username = stringField(defaults, 'username');
    const database = stringField(defaults, 'database');
    const warehouse = stringField(defaults, 'warehouse');
    const targetSchema =
      schemaOverride ?? stringField(defaults, 'targetSchema') ?? stringField(defaults, 'schema');
    if (!account || !username || !database || !warehouse || !targetSchema) {
      throw new CommandError(
        'snowflake default_destination requires account, username, database, warehouse, and targetSchema (or schema)',
        2
      );
    }
    validateIdentifier(targetSchema);
    const authenticator = stringField(defaults, 'authenticator');
    const config: DatabaseDestConfig = {
      dest: 'snowflake',
      account,
      username,
      password: stringField(defaults, 'password'),
      privateKeyPath: stringField(defaults, 'privateKeyPath'),
      privateKeyPassphrase: stringField(defaults, 'privateKeyPassphrase'),
      authenticator:
        authenticator === 'OAUTH' || authenticator === 'SNOWFLAKE_JWT'
          ? (authenticator as 'OAUTH' | 'SNOWFLAKE_JWT')
          : undefined,
      oauthClientId: stringField(defaults, 'oauthClientId'),
      oauthClientSecret: stringField(defaults, 'oauthClientSecret'),
      oauthTokenUrl: stringField(defaults, 'oauthTokenUrl'),
      warehouse,
      database,
      targetSchema,
      role: stringField(defaults, 'role'),
      bufferSize: 100_000,
      logFormat: 'json',
      maxConcurrentLoads: 1,
    };
    return {
      kind: 'snowflake',
      schema: targetSchema,
      table,
      fullyQualified: `${targetSchema}.${table}`,
      config,
      sqlRunnerKind: 'snowflake',
    };
  }

  if (destKind === 'duckdb') {
    const dbPath = stringField(defaults, 'dbPath');
    if (!dbPath) {
      throw new CommandError('duckdb default_destination requires dbPath', 2);
    }
    const schema = schemaOverride ?? stringField(defaults, 'targetSchema') ?? 'sources';
    validateIdentifier(schema);
    const config: DatabaseDestConfig = {
      dest: 'duckdb',
      dbPath: resolveProjectPath(dbPath, args.projectRoot),
      targetSchema: schema,
      bufferSize: 100_000,
      logFormat: 'json',
      maxConcurrentLoads: 1,
      memoryLimit: stringField(defaults, 'memoryLimit'),
    };
    return {
      kind: 'duckdb',
      schema,
      table,
      fullyQualified: `${schema}.${table}`,
      config,
      sqlRunnerKind: 'duckdb',
    };
  }

  if (destKind === 'ducklake') {
    const schema = schemaOverride ?? stringField(defaults, 'targetSchema') ?? 'sources';
    validateIdentifier(schema);
    const metadataSchema = stringField(defaults, 'metadataSchema');
    if (metadataSchema) validateIdentifier(metadataSchema);
    const configuredCatalogUrl = stringField(defaults, 'catalogUrl');
    const catalogUrl = configuredCatalogUrl
      ? resolveDuckLakeCatalogUrl(configuredCatalogUrl, args.projectRoot)
      : `ducklake:${join(args.projectRoot, '.dogsled', 'lake', 'catalog.ducklake')}`;
    const configuredDataPath = stringField(defaults, 'dataPath');
    const config: DatabaseDestConfig = {
      dest: 'ducklake',
      catalogUrl,
      dataPath: configuredDataPath
        ? resolveProjectPath(configuredDataPath, args.projectRoot)
        : undefined,
      attachAlias: stringField(defaults, 'attachAlias') ?? 'lake',
      targetSchema: schema,
      ...(metadataSchema ? { metadataSchema } : {}),
      bufferSize: 100_000,
      logFormat: 'json',
      memoryLimit: stringField(defaults, 'memoryLimit'),
      maxConcurrentLoads: 1,
      maxBufferMemory: stringField(defaults, 'maxBufferMemory'),
      tablePrefix: stringField(defaults, 'tablePrefix'),
    };
    return {
      kind: 'ducklake',
      schema,
      table,
      fullyQualified: `${schema}.${table}`,
      config,
      sqlRunnerKind: 'duckdb',
    };
  }

  throw new CommandError(`unknown default_destination.dest "${destKind}"`, 2);
}

/** Resolve a relative local path from `.dogsled/config.yml` against the project root. */
export function resolveProjectPath(value: string, projectRoot: string): string {
  if (value === ':memory:' || isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return value;
  }
  return resolve(projectRoot, value);
}

/** Resolve the file path in a `ducklake:<path>` catalog URL; other catalog kinds pass through. */
export function resolveDuckLakeCatalogUrl(catalogUrl: string, projectRoot: string): string {
  const match = /^ducklake:(.*)$/.exec(catalogUrl);
  if (!match || match[1] === undefined) return catalogUrl;
  return `ducklake:${resolveProjectPath(match[1], projectRoot)}`;
}
