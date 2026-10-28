import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
/**
 * Target file loader + integration resolver.
 *
 * Targets are thin load-intent wrappers that point at an integration:
 *
 *   integrations/<handle>.yml   owns connection + auth + source_type
 *   targets/<handle>.yml        owns load-time overrides + defaults + integration ref
 *
 * At resolve time we:
 *   1. Load the target YAML, validate against `TargetFileSchema`.
 *   2. Load the referenced integration YAML, validate against `IntegrationFileSchema`.
 *   3. Capability check — reject API / source-only integrations as load targets.
 *   4. Resolve `*_env` fields against the process environment.
 *   5. Merge integration connection fields + target `overrides` → return a `LoaderConfig`.
 *
 * Secrets always come from env vars named by the integration's `*_env` fields.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';
import YAML from 'yaml';

import type { BigQueryDestConfig, LoaderConfig, SnowflakeDestConfig } from '../schemas/config.js';
import {
  API_SOURCE_TYPE,
  IntegrationFileSchema,
  TARGET_CAPABLE_SOURCE_TYPES,
  type BigQueryIntegration,
  type IntegrationFile,
  type SnowflakeIntegration,
} from '../schemas/integration.js';
import {
  TargetFileSchema,
  type TargetDefaults,
  type TargetFile,
  type TargetOverrides,
} from '../schemas/target.js';
import { assertProjectYamlFileSafe, assertYamlFileSize } from './yaml-file-security.js';

// ── File loading ───────────────────────────────────────────────────────────

const TARGET_FILE_EXTENSIONS = ['.yml', '.yaml'] as const;
const HANDLE_RE = /^[a-z][a-z0-9_]*$/;
const BareLoadBlockSchema = TargetFileSchema.pick({
  integration: true,
  overrides: true,
  defaults: true,
}).strict();

export async function loadTargetFile(filePath: string): Promise<TargetFile> {
  await assertYamlFileSize(filePath, 'Target file');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new CommandError(`Target file not found at ${filePath}`, 2);
    }
    throw err;
  }

  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new CommandError(
      `Failed to parse target YAML at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }

  if (
    doc &&
    typeof doc === 'object' &&
    !Array.isArray(doc) &&
    !('type' in doc) &&
    !('spec_version' in doc)
  ) {
    const parsed = BareLoadBlockSchema.safeParse(doc);
    if (!parsed.success) {
      throw new CommandError(
        formatSpecValidationMessage('load block', filePath, parsed.error, {
          schema: BareLoadBlockSchema,
        }),
        2
      );
    }
    return { spec_version: '1', type: 'target', name: 'inline_load', ...parsed.data };
  }

  // Auto-extract from a V2 resource YAML when `--load-file` points at a
  // resource (common in pipe-based CLI where the loader can't see the
  // resource YAML itself but the operator can point at it).
  // A V2 resource has `type: resource` with `extract:` + `load:` blocks at
  // the top level. We synthesize a TargetFile-shaped object from the `load:`
  // block so downstream plumbing stays unchanged.
  const asResource = doc as {
    type?: string;
    name?: string;
    extract?: unknown;
    load?: unknown;
  };
  if (asResource?.type === 'resource' && asResource.load !== undefined) {
    // Validate the load block strictly so typos like `integrationn` surface
    // with a clear error instead of silently falling through to the target path.
    const ALLOWED_LOAD_KEYS = new Set(['integration', 'overrides', 'defaults']);
    if (
      typeof asResource.load !== 'object' ||
      asResource.load === null ||
      Array.isArray(asResource.load)
    ) {
      throw new CommandError(
        `Invalid \`load:\` block in resource at ${filePath}: <root>: must be an object`,
        2
      );
    }
    const loadObj = asResource.load as Record<string, unknown>;
    const unknownKeys = Object.keys(loadObj).filter((k) => !ALLOWED_LOAD_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new CommandError(
        `Invalid \`load:\` block in resource at ${filePath}: <root>: unknown key(s): ${unknownKeys.join(', ')}`,
        2
      );
    }
    if (typeof loadObj['integration'] !== 'string' || loadObj['integration'].length === 0) {
      throw new CommandError(
        `Invalid \`load:\` block in resource at ${filePath}: integration: required and must be a non-empty string`,
        2
      );
    }
    const loadBlock = loadObj as { integration: string; overrides?: unknown; defaults?: unknown };
    const synthesized: unknown = {
      spec_version: '1',
      type: 'target',
      name: asResource.name ?? 'inline_load',
      integration: loadBlock.integration,
      overrides: loadBlock.overrides,
      defaults: loadBlock.defaults,
    };
    const parsed = TargetFileSchema.safeParse(synthesized);
    if (!parsed.success) {
      throw new CommandError(
        formatSpecValidationMessage('load block', filePath, parsed.error, {
          schema: TargetFileSchema,
        }),
        2
      );
    }
    return parsed.data;
  }

  // Otherwise parse as a classic target YAML (`type: target` / `name:` / ...).
  const parsed = TargetFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('target', filePath, parsed.error, {
        schema: TargetFileSchema,
        hint:
          'Expected either a V2 resource YAML with a top-level `load:` block, ' +
          'or a target YAML with `type: target` + `integration:` fields.',
      }),
      2
    );
  }
  return parsed.data;
}

export async function resolveTarget(projectDir: string, handle: string): Promise<TargetFile> {
  if (!HANDLE_RE.test(handle)) {
    throw new CommandError(
      `Invalid target handle "${handle}". Use lowercase letters, digits, and underscores only.`,
      2
    );
  }
  const targetsDir = path.join(projectDir, 'targets');
  for (const ext of TARGET_FILE_EXTENSIONS) {
    const candidate = path.join(targetsDir, `${handle}${ext}`);
    try {
      await fs.access(candidate);
      await assertProjectYamlFileSafe(projectDir, candidate, 'target file');
      return loadTargetFile(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw err;
    }
  }
  throw new CommandError(
    `Target "${handle}" not found in ${targetsDir} (looked for ${TARGET_FILE_EXTENSIONS.join(', ')}).`,
    2
  );
}

export async function loadIntegrationFile(filePath: string): Promise<IntegrationFile> {
  await assertYamlFileSize(filePath, 'Integration file');
  const raw = await fs.readFile(filePath, 'utf-8');
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new CommandError(
      `Failed to parse integration YAML at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }
  const parsed = IntegrationFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('integration', filePath, parsed.error, {
        schema: IntegrationFileSchema,
      }),
      2
    );
  }
  return parsed.data;
}

export async function resolveIntegration(
  projectDir: string,
  handle: string
): Promise<IntegrationFile> {
  if (!HANDLE_RE.test(handle)) {
    throw new CommandError(
      `Invalid integration handle "${handle}". Use lowercase letters, digits, and underscores only.`,
      2
    );
  }
  const integrationsDir = path.join(projectDir, 'integrations');
  for (const ext of TARGET_FILE_EXTENSIONS) {
    const candidate = path.join(integrationsDir, `${handle}${ext}`);
    try {
      await fs.access(candidate);
      await assertProjectYamlFileSafe(projectDir, candidate, 'integration file');
      return loadIntegrationFile(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw err;
    }
  }
  throw new CommandError(
    `Integration "${handle}" not found in ${integrationsDir} (looked for ${TARGET_FILE_EXTENSIONS.join(', ')}).`,
    2
  );
}

// ── Capability validation ─────────────────────────────────────────────────

export function validateTargetCapability(target: TargetFile, integration: IntegrationFile): void {
  const sourceType = integration.source_type;

  if (sourceType === API_SOURCE_TYPE) {
    throw new CommandError(
      `Target "${target.name}" references integration "${integration.name}" which is an API source and cannot be a load destination.`,
      2
    );
  }

  if (!TARGET_CAPABLE_SOURCE_TYPES.has(sourceType)) {
    throw new CommandError(
      `Target "${target.name}" references integration "${integration.name}" with source_type="${sourceType}", which is not supported as a load destination yet.`,
      2
    );
  }
}

// ── Env resolution ─────────────────────────────────────────────────────────

function readEnv(env: Record<string, string | undefined>, name: string, missing: string[]): string {
  const value = env[name];
  if (!value) {
    missing.push(name);
    return '';
  }
  return value;
}

function assertNoMissing(targetName: string, missing: string[]): void {
  if (missing.length > 0) {
    throw new CommandError(
      `Target "${targetName}" is missing required env vars: ${missing.join(', ')}`,
      2
    );
  }
}

// ── Dual-shape resolution helpers ─────────────────────────────────────────

const ENV_TEMPLATE_RE = /^\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

/**
 * Resolve a new-shape field value containing `${{ env.X }}` interpolation.
 * Returns the resolved env var value, or pushes to `missing` if the env var
 * is unset.
 */
function resolveInterpolatedField(
  value: string,
  env: Record<string, string | undefined>,
  missing: string[]
): string {
  const match = value.match(ENV_TEMPLATE_RE);
  if (match) {
    const envKey = match[1]!;
    return readEnv(env, envKey, missing);
  }
  // Literal value (no interpolation needed)
  return value;
}

function resolveOptionalInterpolatedField(
  value: string | undefined,
  env: Record<string, string | undefined>,
  missing: string[]
): string | undefined {
  return value === undefined ? undefined : resolveInterpolatedField(value, env, missing);
}

const _legacyWarned = new Set<string>();

function warnLegacyField(fieldName: string): void {
  if (_legacyWarned.has(fieldName)) return;
  _legacyWarned.add(fieldName);
  const newField = fieldName.replace(/_env$/, '');
  process.stderr.write(
    `[deprecation] Field "${fieldName}" is deprecated; use "${newField}" with $\{{ env.X }} interpolation instead.\n`
  );
}

/** Reset the legacy warning tracker. Intended only for tests. */
export function resetLegacyWarnings(): void {
  _legacyWarned.clear();
}

/**
 * Resolve a dual-shape field pair. Prefers new-shape (interpolated) over
 * legacy (`_env` suffix). Emits a deprecation warning for legacy usage.
 */
function resolveDualField(
  newVal: string | undefined,
  legacyVal: string | undefined,
  legacyFieldName: string,
  env: Record<string, string | undefined>,
  missing: string[]
): string {
  if (newVal !== undefined) {
    return resolveInterpolatedField(newVal, env, missing);
  }
  if (legacyVal !== undefined) {
    warnLegacyField(legacyFieldName);
    return readEnv(env, legacyVal, missing);
  }
  // Neither set — caller handles required vs optional
  return '';
}

function resolveDualFieldOptional(
  newVal: string | undefined,
  legacyVal: string | undefined,
  legacyFieldName: string,
  env: Record<string, string | undefined>,
  missing: string[]
): string | undefined {
  if (newVal !== undefined) {
    return resolveInterpolatedField(newVal, env, missing);
  }
  if (legacyVal !== undefined) {
    warnLegacyField(legacyFieldName);
    return readEnv(env, legacyVal, missing);
  }
  return undefined;
}

// ── Adapter: integration + target overrides → LoaderConfig ────────────────

function buildSnowflakeConfig(
  target: TargetFile,
  integration: SnowflakeIntegration,
  env: Record<string, string | undefined>
): SnowflakeDestConfig {
  const missing: string[] = [];
  const o: TargetOverrides = target.overrides ?? {};
  const d: TargetDefaults = target.defaults ?? {};
  const conn = integration.connection;

  const account = resolveDualField(
    conn.account_identifier,
    conn.account_identifier_env,
    'account_identifier_env',
    env,
    missing
  );
  const warehouse =
    o.warehouse === undefined
      ? resolveDualField(conn.warehouse, conn.warehouse_env, 'warehouse_env', env, missing)
      : resolveInterpolatedField(o.warehouse, env, missing);
  const database = resolveOptionalInterpolatedField(o.database ?? conn.database, env, missing);
  const schema = resolveOptionalInterpolatedField(o.schema ?? conn.schema, env, missing);
  const role = resolveOptionalInterpolatedField(o.role ?? conn.role, env, missing);

  // Snowflake loader requires a username for every connection, regardless of auth type.
  if (!conn.user && !conn.user_env) {
    throw new CommandError(
      `Target "${target.name}": integration "${integration.name}" must set connection.user or connection.user_env (the loader's Snowflake driver requires a username).`,
      2
    );
  }
  const username = resolveDualField(conn.user, conn.user_env, 'user_env', env, missing);

  let password: string | undefined;
  let privateKeyPath: string | undefined;
  let privateKeyPassphrase: string | undefined;
  let authenticator: 'OAUTH' | 'SNOWFLAKE_JWT' | undefined;
  let oauthClientId: string | undefined;
  let oauthClientSecret: string | undefined;
  let oauthTokenUrl: string | undefined;

  const auth = integration.auth;
  if (auth.type === 'pat') {
    password = resolveDualField(auth.token, auth.token_env, 'token_env', env, missing);
  } else if (auth.type === 'rsa_key') {
    // Tell snowflake-sdk to use key-pair (JWT) auth. Without this the driver
    // falls back to password auth and rejects the connection even when a
    // privateKey is supplied.
    authenticator = 'SNOWFLAKE_JWT';
    privateKeyPath = resolveDualField(
      auth.private_key_path,
      auth.private_key_path_env,
      'private_key_path_env',
      env,
      missing
    );
    privateKeyPassphrase = resolveDualFieldOptional(
      auth.private_key_passphrase,
      auth.private_key_passphrase_env,
      'private_key_passphrase_env',
      env,
      missing
    );
  } else {
    // oauth — loader fetches the access token at initialize() and passes it to
    // snowflake-sdk via authenticator: 'OAUTH' + token.
    authenticator = 'OAUTH';
    oauthClientId = resolveDualField(
      auth.client_id,
      auth.client_id_env,
      'client_id_env',
      env,
      missing
    );
    oauthClientSecret = resolveDualField(
      auth.client_secret,
      auth.client_secret_env,
      'client_secret_env',
      env,
      missing
    );
    oauthTokenUrl = auth.token_url;
  }

  if (!database) missing.push('connection.database (set on integration or target.overrides)');
  assertNoMissing(target.name, missing);

  return {
    dest: 'snowflake',
    account,
    username,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    authenticator,
    oauthClientId,
    oauthClientSecret,
    oauthTokenUrl,
    warehouse,
    database: database ?? '',
    targetSchema: schema ?? 'PUBLIC',
    role,
    loadStrategy: d.load_strategy,
    schemaBehavior: d.schema_behavior,
    bufferSize: d.buffer_size ?? 100_000,
    logFormat: 'json',
    maxConcurrentLoads: 1,
  };
}

function buildBigQueryConfig(
  target: TargetFile,
  integration: BigQueryIntegration,
  env: Record<string, string | undefined>
): BigQueryDestConfig {
  const missing: string[] = [];
  const o: TargetOverrides = target.overrides ?? {};
  const d: TargetDefaults = target.defaults ?? {};

  // dataset comes from integration.connection.dataset; overrides.schema can rename it.
  const projectId = resolveOptionalInterpolatedField(
    integration.connection.project_id ?? integration.connection.project_ids?.[0],
    env,
    missing
  );
  const datasetId = resolveOptionalInterpolatedField(
    o.schema ?? integration.connection.dataset,
    env,
    missing
  );
  const location = resolveOptionalInterpolatedField(
    integration.connection.location ?? integration.connection.default_location,
    env,
    missing
  );

  let keyFilename: string | undefined;
  let credentials: Record<string, unknown> | undefined;
  const auth = integration.auth;
  if (auth.type === 'service_account') {
    const credentialValue = resolveDualFieldOptional(
      auth.credentials,
      auth.credentials_env,
      'credentials_env',
      env,
      missing
    );
    // At least one of credentials/credentials_env must resolve to a value
    if (!credentialValue) {
      missing.push('auth.credentials (service account key file path or JSON payload)');
    } else if (credentialValue.trimStart().startsWith('{')) {
      // Value looks like a JSON payload (the service-account JSON blob itself) rather
      // than a file path. Parse it and pass as `credentials` to the BigQuery client.
      try {
        const parsed = JSON.parse(credentialValue) as Record<string, unknown>;
        if (parsed.type !== 'service_account') {
          throw new CommandError(
            `Target "${target.name}": BigQuery credentials JSON must have "type": "service_account" (got "${String(parsed.type)}").`,
            2
          );
        }
        credentials = parsed;
      } catch (err) {
        if (err instanceof CommandError) throw err;
        throw new CommandError(
          `Target "${target.name}": BigQuery credentials value looks like JSON but failed to parse: ${err instanceof Error ? err.message : String(err)}`,
          2
        );
      }
    } else {
      // Value is a file path — pass as keyFilename (backwards-compatible default).
      keyFilename = credentialValue;
    }
  } else if (auth.type === 'adc') {
    // ADC — rely on environment (GOOGLE_APPLICATION_CREDENTIALS or metadata server).
  } else if (auth.type === 'wif') {
    // WIF — loader currently has no direct WIF path; users fall back to ADC or SA JSON.
    throw new CommandError(
      `Target "${target.name}": BigQuery WIF auth is not yet supported for the loader; use service_account or ADC.`,
      2
    );
  }

  if (!projectId) missing.push('connection.project_id (set on integration)');
  if (!datasetId) missing.push('connection.dataset or overrides.schema');
  assertNoMissing(target.name, missing);

  return {
    dest: 'bigquery',
    projectId,
    datasetId: datasetId ?? '',
    location,
    keyFilename,
    credentials,
    loadStrategy: d.load_strategy,
    schemaBehavior: d.schema_behavior,
    bufferSize: d.buffer_size ?? 100_000,
    logFormat: 'json',
    targetFileSizeMb: 256,
    stagingFormat: 'parquet',
    maxConcurrentLoads: 4,
    maxLoadJobs: 9000,
  };
}

export function targetToLoaderConfig(
  target: TargetFile,
  integration: IntegrationFile,
  env: Record<string, string | undefined>
): LoaderConfig {
  validateTargetCapability(target, integration);
  assertDeclaredEnvironmentReferences([integration, target], integration.auth_env_vars);

  if (integration.source_type === 'snowflake') {
    return buildSnowflakeConfig(target, integration as SnowflakeIntegration, env);
  }
  if (integration.source_type === 'bigquery') {
    return buildBigQueryConfig(target, integration as BigQueryIntegration, env);
  }
  // Unreachable — capability check above rejects anything else.
  throw new CommandError(
    `Target "${target.name}": unsupported integration source_type "${integration.source_type}".`,
    2
  );
}

// ── CLI entry point ────────────────────────────────────────────────────────

export interface TargetCliOptions {
  target?: string;
  targetFile?: string;
  /**
   * CLI shortcut for `--load-file` when only the destination integration name
   * is needed. Resolves `<integration>.yml` from `integrations/` and applies
   * no overrides or defaults — equivalent to passing a load file containing
   * just `{ integration: <name> }`.
   */
  loadIntegration?: string;
}

export async function resolveTargetConfig(
  options: TargetCliOptions,
  env: Record<string, string | undefined>,
  cwd: string
): Promise<LoaderConfig | undefined> {
  const provided = [options.target, options.targetFile, options.loadIntegration].filter(Boolean);
  if (provided.length > 1) {
    throw new CommandError(
      'Cannot specify more than one of --target, --target-file, --load-integration; choose one.',
      2
    );
  }

  let target: TargetFile | undefined;
  if (options.targetFile) {
    target = await loadTargetFile(options.targetFile);
  } else if (options.target) {
    target = await resolveTarget(cwd, options.target);
  } else if (options.loadIntegration) {
    // Synthetic target name must satisfy TargetFileSchema's handle rules
    // (start with a letter, snake_case identifier). Sanitize the input and
    // prepend `load_` so it's always valid even if the integration name has
    // hyphens or other characters that the target schema would reject.
    const sanitized = options.loadIntegration.replace(/[^A-Za-z0-9_]/g, '_');
    target = {
      spec_version: '1' as const,
      type: 'target' as const,
      name: `load_${sanitized}`,
      integration: options.loadIntegration,
    };
  }
  if (!target) return undefined;

  const integration = await resolveIntegration(cwd, target.integration);
  return targetToLoaderConfig(target, integration, env);
}
