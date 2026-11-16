/**
 * Integration discovery + resolution for the Model Spec CLI.
 *
 * Reads integration files via `@bobsled-inc/connections` and surfaces the
 * fields Model Spec needs from an active integration: the target dialect, the default
 * target schema, and (where relevant) the default target database. Project
 * loaders read every `type: integration` file in a project index, identified
 * by `name` wherever it lives; the directory functions read one
 * `<projectDir>/<integrationsDir>` folder. The active integration is chosen
 * either via `--integration` or auto-selected when exactly one exists.
 *
 * Cross-references:
 *   - `@bobsled-inc/connections` `loadIndexedIntegrations` — indexed parsing + identity
 *   - `@bobsled-inc/connections/fs/load-integration` — directory discovery + parsing
 *   - `packages/model-spec/src/compiler/dialect.ts` — SupportedDialect mapping
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  EnvSecretResolver,
  findIndexedIntegration,
  loadIndexedIntegrations,
  loadIntegration,
  loadIntegrationDirectory,
  type IntegrationFile,
  type SecretResolver,
  type SourceType,
} from '@bobsled-inc/connections';
import type { ProjectIndex } from '@bobsled-inc/project-index';
import YAML from 'yaml';

import { CommandError } from './commands/common.js';
import { DEFAULT_RESOLVED_SCHEMA } from './config.js';

import type { SupportedDialect } from './compiler/dialect.js';

/**
 * Result of resolving the active integration. `targetDatabase` is only set
 * when the integration's dialect actually supports 3-part names and the file
 * declares a default database.
 */
export interface ResolvedIntegration {
  handle: string;
  dialect: SupportedDialect;
  targetSchema: string;
  targetDatabase?: string;
  targetWarehouse?: string;
  integration: IntegrationFile;
}

/**
 * Shape of a parsed `--secrets` YAML file — a flat map of env-var names to
 * string values. Values are validated individually; the narrowing to `string`
 * happens at runtime.
 */
type SecretsFileMap = { [envVarName: string]: unknown };

/**
 * Subset of an integration's `connection` block Model Spec reads to derive default
 * target schema/database. Access is typed rather than using a broad
 * `Record<string, unknown>` cast.
 */
interface ConnectionBlockSubset {
  schema?: unknown;
  /** BigQuery spells the default-schema field `dataset`. */
  dataset?: unknown;
  database?: unknown;
  warehouse?: unknown;
}

/**
 * `source_type` values from `@bobsled-inc/connections` correspond 1:1 with
 * Model Spec `SupportedDialect` values for the dialects that have an integration
 * schema. Other Model Spec dialects (redshift, mysql, pgvector) have none yet —
 * those are out-of-scope for now.
 */
const SOURCE_TYPE_TO_DIALECT: Record<SourceType, SupportedDialect> = {
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  postgres: 'postgres',
  databricks: 'databricks',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
};

/**
 * Load an integration by explicit handle, then adapt it into a
 * `ResolvedIntegration`. File-not-found / invalid-schema errors bubble up as
 * `CommandError(2)` from `@bobsled-inc/connections`.
 */
export async function resolveIntegrationByHandle(
  projectDir: string,
  handle: string,
  integrationsDir: string
): Promise<ResolvedIntegration> {
  const file = await loadIntegration(projectDir, handle, { dirName: integrationsDir });
  return adapt(handle, file);
}

/**
 * Load every integration declared under `<projectDir>/<integrationsDir>` and
 * adapt them into `ResolvedIntegration` objects keyed by handle. Throws when
 * the directory is missing or empty — callers need at least one integration to
 * pick a dialect.
 */
export async function loadAllIntegrations(
  projectDir: string,
  integrationsDir: string
): Promise<Map<string, ResolvedIntegration>> {
  const files = await loadIntegrationDirectory(projectDir, { dirName: integrationsDir });
  if (files.size === 0) {
    throw new CommandError(
      `No integrations found in ${integrationsDir}/. ` +
        `Create ${integrationsDir}/<handle>.yml with your warehouse credentials.`,
      2
    );
  }

  const out = new Map<string, ResolvedIntegration>();
  for (const [handle, file] of files) {
    out.set(handle, adapt(handle, file));
  }
  return out;
}

/**
 * Narrow a loaded integration map by an optional requested handle. When the
 * handle is `undefined`, all integrations pass through in declaration order
 * (Map iteration order = insertion order from `loadIntegrationDirectory`,
 * which sorts lexicographically). When present, only the matching entry is
 * returned — unknown handles produce a CommandError(2) listing what's
 * available.
 */
export function pickIntegrationsByHandle(
  all: Map<string, ResolvedIntegration>,
  requestedHandle: string | undefined
): ResolvedIntegration[] {
  if (requestedHandle === undefined) return [...all.values()];
  const hit = all.get(requestedHandle);
  if (!hit) {
    const available = [...all.keys()].sort().join(', ');
    throw new CommandError(
      `Integration "${requestedHandle}" not found. Available: ${available || '(none)'}.`,
      2
    );
  }
  return [hit];
}

/**
 * Auto-pick the active integration from `<projectDir>/<integrationsDir>`.
 *
 * Retained for Entity Graph and legacy single-integration callers (lineage tests,
 * `buildCompileContext` wrapper). Post–multi-integration, Model Spec commands use
 * `loadAllIntegrations` + `pickIntegrationsByHandle` directly.
 *
 * Rules:
 *   - Zero files found      → throw: directory must contain at least one integration.
 *   - Exactly one file      → auto-select.
 *   - Two or more + handle  → use handle (throws if handle not present).
 *   - Two or more, no handle → throw with actionable list of handles.
 */
export async function resolveActiveIntegration(
  projectDir: string,
  integrationsDir: string,
  requestedHandle: string | undefined
): Promise<ResolvedIntegration> {
  return pickActiveIntegration(
    await loadAllIntegrations(projectDir, integrationsDir),
    requestedHandle,
    ` in ${integrationsDir}/`
  );
}

function pickActiveIntegration(
  all: Map<string, ResolvedIntegration>,
  requestedHandle: string | undefined,
  location: string
): ResolvedIntegration {
  if (requestedHandle !== undefined) {
    const picked = pickIntegrationsByHandle(all, requestedHandle);
    // pickIntegrationsByHandle guarantees length 1 on a hit.
    return picked[0] as ResolvedIntegration;
  }

  if (all.size === 1) {
    return [...all.values()][0] as ResolvedIntegration;
  }

  const handles = [...all.keys()].sort();
  throw new CommandError(
    `Multiple integrations found${location}: ${handles.join(', ')}. ` +
      `Pass --integration <handle> to pick one.`,
    2
  );
}

/**
 * Return the set of integration handles declared under `<projectDir>/<integrationsDir>`.
 * Empty set when the directory does not exist. Used to cross-reference source
 * `connection` fields so unknown handles surface as typed errors.
 */
export async function listIntegrationHandles(
  projectDir: string,
  integrationsDir: string
): Promise<Set<string>> {
  const integrations = await loadIntegrationDirectory(projectDir, { dirName: integrationsDir });
  return new Set(integrations.keys());
}

/**
 * Every warehouse integration a project index declares (`type: integration`
 * anywhere in the project, identified by `name`), adapted and keyed by handle
 * in handle order. Throws when the project declares none; callers need at
 * least one integration to pick a dialect.
 */
export function resolveIndexedIntegrations(index: ProjectIndex): Map<string, ResolvedIntegration> {
  const files = loadIndexedIntegrations(index);
  if (files.size === 0) {
    throw new CommandError(
      'No integrations found. Add a YAML file with type: integration (for example ' +
        'integrations/<handle>.yml) that holds your warehouse credentials.',
      2
    );
  }

  const out = new Map<string, ResolvedIntegration>();
  for (const [handle, file] of files) {
    out.set(handle, adapt(handle, file.integration));
  }
  return out;
}

/**
 * The warehouse integration whose `name` is `handle`, wherever its file lives.
 * A same-named file that is not a warehouse integration fails the warehouse
 * schema with its path; an unknown handle lists the declared ones.
 */
export function resolveIndexedIntegrationByHandle(
  index: ProjectIndex,
  handle: string
): ResolvedIntegration {
  const found = findIndexedIntegration(index, handle);
  if (found) return adapt(handle, found.integration);
  const available = [...loadIndexedIntegrations(index).keys()].join(', ');
  throw new CommandError(
    `Integration "${handle}" not found. Available: ${available || '(none)'}.`,
    2
  );
}

/**
 * The integration a command works on: `requestedHandle` when given (throws
 * if it is not declared), else the only integration. Two or more without a
 * handle is an error listing them.
 */
export function selectActiveIntegration(
  all: Map<string, ResolvedIntegration>,
  requestedHandle: string | undefined
): ResolvedIntegration {
  return pickActiveIntegration(all, requestedHandle, '');
}

/**
 * Cross-check each source's `connection` handle (encoded in the registry key
 * as `<handle>.<source_name>`) against the set of declared integrations.
 * Surfaces unknown handles as a CommandError(2) so Model Spec commands fail early
 * with an actionable message instead of producing SQL that references a
 * phantom warehouse.
 */
export function validateSourceIntegrationRefs(
  sourceRegistryKeys: Iterable<string>,
  knownHandles: ReadonlySet<string>
): void {
  if (knownHandles.size === 0) {
    // No integrations declared at all — skip validation so bundle-only or
    // bundle-preview workflows (where the user has not yet wired an
    // integration) keep surfacing their native errors rather than this one.
    return;
  }

  const unknownByHandle = new Map<string, string[]>();
  for (const key of sourceRegistryKeys) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const handle = key.slice(0, dot);
    const sourceName = key.slice(dot + 1);
    if (!knownHandles.has(handle)) {
      const bucket = unknownByHandle.get(handle);
      if (bucket) {
        bucket.push(sourceName);
      } else {
        unknownByHandle.set(handle, [sourceName]);
      }
    }
  }

  if (unknownByHandle.size === 0) return;

  const lines = [...unknownByHandle.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([handle, names]) => `  - "${handle}" used by ${names.sort().join(', ')}`);
  const declared = [...knownHandles].sort().join(', ');
  throw new CommandError(
    `Source files reference undeclared integrations:\n${lines.join('\n')}\n` +
      `Declared integrations: ${declared || '(none)'}. ` +
      `Add an integration file (type: integration, name: <handle>) for each missing handle, or update the source's "connection:" field.`,
    2
  );
}

/**
 * Build the `SecretResolver` `bobsled model run` feeds into `resolveRunner` /
 * `interpolateSecrets`. When `--secrets <path>` is provided, the file's flat
 * `string → string` map overlays on top of `process.env`; otherwise the
 * resolver is a plain `EnvSecretResolver`.
 *
 * File shape:
 *   ```yaml
 *   SNOWFLAKE_ACCOUNT: xt00000
 *   SF_PAT: ${SOME_OTHER_VAR}   # no shell interpolation — values are literal
 *   ```
 * The file contents are considered secrets; the CLI opens it with
 * standard FS permissions and never logs its values.
 */
export async function buildSecretResolver(
  projectDir: string,
  secretsPath: string | undefined
): Promise<SecretResolver> {
  if (secretsPath === undefined) {
    return new EnvSecretResolver();
  }

  const resolvedPath = path.isAbsolute(secretsPath)
    ? secretsPath
    : path.resolve(projectDir, secretsPath);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Failed to read secrets file ${secretsPath}: ${message}`, 1);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Invalid YAML in secrets file ${secretsPath}: ${message}`, 2);
  }

  if (parsed === null || parsed === undefined) {
    return new EnvSecretResolver();
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError(
      `Secrets file ${secretsPath} must be a YAML map of env-var names to values.`,
      2
    );
  }

  const secretsMap = parsed as SecretsFileMap;
  const fileBag: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretsMap)) {
    if (typeof value !== 'string') {
      throw new CommandError(
        `Secrets file ${secretsPath}: value for "${key}" must be a string (got ${typeof value}).`,
        2
      );
    }
    fileBag[key] = value;
  }

  // File values take precedence over process.env so test-time overrides work
  // without having to export them first.
  return new EnvSecretResolver({ ...process.env, ...fileBag });
}

/**
 * Adapt a parsed integration file into the narrower shape Model Spec commands need.
 * Extracted so both by-handle and auto-select paths share one code path.
 */
function adapt(handle: string, integration: IntegrationFile): ResolvedIntegration {
  const dialect = SOURCE_TYPE_TO_DIALECT[integration.source_type];
  const connection = integration.connection as ConnectionBlockSubset;

  const rawSchema =
    typeof connection.schema === 'string'
      ? connection.schema
      : typeof connection.dataset === 'string'
        ? connection.dataset
        : undefined;
  const rawDatabase = typeof connection.database === 'string' ? connection.database : undefined;
  const rawWarehouse = typeof connection.warehouse === 'string' ? connection.warehouse : undefined;

  return {
    handle,
    dialect,
    targetSchema: resolveOptionalEnvTemplate(rawSchema, 'schema') ?? DEFAULT_RESOLVED_SCHEMA,
    targetDatabase: resolveOptionalEnvTemplate(rawDatabase, 'database'),
    targetWarehouse: resolveOptionalEnvTemplate(rawWarehouse, 'warehouse'),
    integration,
  };
}

const WHOLE_ENV_TEMPLATE_RE = /^\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

function resolveOptionalEnvTemplate(
  value: string | undefined,
  fieldName?: string
): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(WHOLE_ENV_TEMPLATE_RE);
  if (!match) return value;
  const envName = match[1];
  if (!envName) return undefined;
  const resolved = process.env[envName];
  if (!resolved || resolved.length === 0) {
    const field = fieldName ? ` '${fieldName}'` : '';
    throw new CommandError(
      `Integration field${field} references env var '${envName}' which is not set.\n` +
        `Set the ${envName} environment variable or remove the env template from your integration YAML.`,
      2
    );
  }
  return resolved;
}
