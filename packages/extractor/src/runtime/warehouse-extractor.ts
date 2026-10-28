import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
/**
 * Main DW/DB extraction orchestrator.
 *
 * The warehouse equivalent of the HTTP extraction pipeline in commands/extract.ts.
 * Handles full refresh, incremental, and change tracking extraction methods
 * across all supported warehouse dialects (Snowflake, BigQuery, PostgreSQL, MySQL, ClickHouse).
 */

import { CommandError, isPlainObject } from '@bobsled-inc/protocol';
import type { JsonObject, JsonValue } from '@bobsled-inc/protocol';

import type { ReplicationConfig, SourceConfig } from '../framework/core/index.js';
import {
  FileStorageSourceTypeValues,
  SqlTransportTypeValues,
  warnLegacyEnvField,
} from '../framework/core/index.js';
import type { WarehouseResourceSpec } from '../framework/extractor/index.js';
import type { WarehouseResourceV2Spec } from '../framework/extractor/resource.js';

import type { ControlLogger } from './control.js';
import type { Emitter } from './emitter.js';
import type { StateStore, StreamBookmark } from './state.js';
import { getStreamBookmark, mergeDurableBookmark } from './state.js';
import { compareCursors, resolveCursorKind, maxCursor } from './cursor.js';
import { createWarehouseClient } from './warehouse-client.js';
import type { WarehouseClient } from './warehouse-client.js';
import { buildExtractionQuery } from './warehouse-query-builder.js';
import type { Dialect, QueryBuilderConfig } from './warehouse-query-builder.js';
import { normalizeJsonObject, normalizeJsonValue } from './json-normalization.js';
import {
  PgoutputDecoder,
  type PostgresCdcChange,
  type PostgresCdcTransaction,
} from './postgres-cdc-decoder.js';

import { resolveAndValidateHost } from '../framework/core/ssrf.js';
import type { ExtractorState, IntegrationSpec } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WarehouseExtractOptions {
  integration: IntegrationSpec;
  resource: WarehouseResourceSpec;
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  advanceState?: boolean;
  fullRefresh?: boolean;
  limit?: number;
  /** Pipeline-scoped selector resolved against a Snowflake connection's named map. */
  warehouse?: string;
  /** Trusted execution-only tag passed to Snowflake's SQL API. */
  queryTag?: string;
}

export interface WarehouseExtractResult {
  recordCount: number;
  bookmark: StreamBookmark;
  durableBookmark?: StreamBookmark;
}

interface PostgresChangeTrackingConfig {
  plugin?: 'pgoutput';
  slot_name: string;
  publication_name: string;
}

interface PostgresLogicalReplicationClient extends WarehouseClient {
  queryRows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  advanceReplicationSlot(slotName: string, lsn: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// CDC metadata normalization
// ---------------------------------------------------------------------------

function normalizeCdcMetadata(
  row: Record<string, unknown>,
  dialect: Dialect
): Record<string, unknown> | null {
  if (dialect === 'snowflake') {
    const normalized = { ...row };

    if ('METADATA$ACTION' in normalized) {
      normalized['_change_type'] = normalized['METADATA$ACTION'];
      delete normalized['METADATA$ACTION'];
    }
    if ('METADATA$ISUPDATE' in normalized) {
      normalized['_is_update'] = normalized['METADATA$ISUPDATE'];
      delete normalized['METADATA$ISUPDATE'];
    }
    if ('METADATA$ROW_ID' in normalized) {
      normalized['_row_id'] = normalized['METADATA$ROW_ID'];
      delete normalized['METADATA$ROW_ID'];
    }

    return normalized;
  }

  // BigQuery APPENDS: rows are always inserts
  if (dialect === 'bigquery') {
    const normalized = { ...row };
    // BigQuery CHANGES TVF includes _CHANGE_TYPE column automatically
    // Map to normalized names if present
    if ('_CHANGE_TYPE' in normalized) {
      normalized['_change_type'] = normalized['_CHANGE_TYPE'];
      delete normalized['_CHANGE_TYPE'];
    }
    return normalized;
  }

  // Delta CDF: normalize _change_type values and skip update_preimage
  if (dialect === 'delta') {
    const changeType = row['_change_type'];
    if (changeType === 'update_preimage') {
      return null; // Skip pre-images — only post-images are meaningful
    }
    const normalized = { ...row };
    switch (changeType) {
      case 'insert':
        normalized['_change_type'] = 'INSERT';
        break;
      case 'update_postimage':
        normalized['_change_type'] = 'UPDATE';
        break;
      case 'delete':
        normalized['_change_type'] = 'DELETE';
        break;
    }
    // Remove Delta-specific metadata columns
    delete normalized['_commit_version'];
    delete normalized['_commit_timestamp'];
    return normalized;
  }

  return row;
}

function isPostgresChangeTrackingConfig(value: unknown): value is PostgresChangeTrackingConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'slot_name' in value &&
    'publication_name' in value
  );
}

function isPostgresChangeTrackingClient(
  client: WarehouseClient
): client is PostgresLogicalReplicationClient {
  return (
    typeof client.queryRows === 'function' && typeof client.advanceReplicationSlot === 'function'
  );
}

function isPostgresChangeTrackingResource(
  dialect: Dialect,
  resource: WarehouseResourceSpec
): resource is WarehouseResourceSpec & {
  replication: WarehouseResourceSpec['replication'] & {
    change_tracking: PostgresChangeTrackingConfig;
  };
} {
  return (
    dialect === 'postgres' &&
    resource.replication.method === 'change_tracking' &&
    isPostgresChangeTrackingConfig(resource.replication.change_tracking)
  );
}

function normalizeTimestampValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    // Invalid Date (e.g. `new Date(NaN)`) throws RangeError from toISOString()
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    // NaN, Infinity, and values outside ±8.64e15 ms produce invalid Dates
    if (!Number.isFinite(value)) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value && typeof value === 'object') {
    const candidate = value as { value?: unknown };
    if ('value' in candidate) {
      return normalizeTimestampValue(candidate.value);
    }
    if (typeof (value as { toISOString?: unknown }).toISOString === 'function') {
      try {
        return String((value as { toISOString: () => string }).toISOString());
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function coerceWarehouseValue(
  expectedType: WarehouseResourceSpec['output'][string]['type'],
  value: unknown
): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  switch (expectedType) {
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'timestamp': {
      // null on invalid input is consistent with the integer/number branches —
      // avoids emitting junk like "[object Object]" via String(value)
      return normalizeTimestampValue(value);
    }
    case 'integer': {
      const numericValue = typeof value === 'number' ? value : Number(value);
      return Number.isInteger(numericValue) ? numericValue : null;
    }
    case 'number': {
      const numericValue = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numericValue) ? numericValue : null;
    }
    case 'boolean':
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (
          normalized === 'true' ||
          normalized === '1' ||
          normalized === 'yes' ||
          normalized === 't'
        ) {
          return true;
        }
        if (
          normalized === 'false' ||
          normalized === '0' ||
          normalized === 'no' ||
          normalized === '' ||
          normalized === 'f'
        ) {
          return false;
        }
      }
      return Boolean(value);
    case 'array':
      if (Array.isArray(value)) {
        return value.map((entry) => normalizeJsonValue(entry));
      }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed)
            ? parsed.map((entry) => normalizeJsonValue(entry))
            : [normalizeJsonValue(value)];
        } catch {
          return [normalizeJsonValue(value)];
        }
      }
      return [normalizeJsonValue(value)];
    case 'object':
      if (isPlainObject(value)) {
        return normalizeJsonObject(value);
      }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return isPlainObject(parsed) ? normalizeJsonObject(parsed) : null;
        } catch {
          return null;
        }
      }
      return null;
  }
}

function mapPostgresCdcRecord(
  resource: WarehouseResourceSpec,
  change: PostgresCdcChange,
  transaction: PostgresCdcTransaction
): JsonObject {
  const record: JsonObject = Object.create(null) as JsonObject;

  for (const [name, field] of Object.entries(resource.output)) {
    let rawValue: unknown;

    switch (name) {
      case '_change_type':
        rawValue = change.type;
        break;
      case '_commit_lsn':
        rawValue = transaction.commitLsn;
        break;
      case '_transaction_id':
        rawValue = transaction.transactionId;
        break;
      case '_commit_timestamp':
        rawValue = transaction.commitTimestamp;
        break;
      default:
        rawValue = change.values[name];
        break;
    }

    const resolved = rawValue === undefined ? field.default : rawValue;
    const coerced = coerceWarehouseValue(field.type, resolved);
    if (coerced !== undefined) {
      record[name] = coerced;
    }
  }

  return record;
}

function mapWarehouseRecord(
  resource: WarehouseResourceSpec,
  rawRow: Record<string, unknown>
): JsonObject {
  const record: JsonObject = Object.create(null) as JsonObject;

  for (const [name, field] of Object.entries(resource.output)) {
    const rawValue = rawRow[name];
    const resolved = rawValue === undefined ? field.default : rawValue;
    const coerced = coerceWarehouseValue(field.type, resolved);
    if (coerced !== undefined) {
      record[name] = coerced;
    }
  }

  return record;
}

function coerceBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('pgoutput query returned a non-binary payload for column "data"');
}

// ---------------------------------------------------------------------------
// emitSchema adapter
// ---------------------------------------------------------------------------

/**
 * Build a minimal ResourceSpec-compatible object from a WarehouseResourceSpec so that
 * emitSchema can consume it without an unsafe cast.
 *
 * emitSchema reads: name, output, extract.table.primary_key, extract.table.load_strategy,
 * extract.table.partition_by, and extract.incremental.cursor_field.
 *
 * WarehouseResourceSpec stores primary key in replication.primary_key (falling back to
 * extract.table.primary_key) and cursor field in replication.cursor_field.
 */
function buildEmitSchemaArg(resource: WarehouseResourceSpec): Parameters<Emitter['emitSchema']>[0] {
  const primaryKey = resource.replication.primary_key ?? resource.extract?.table?.primary_key;
  const cursorField = resource.replication.cursor_field;
  const loadStrategy = resource.extract?.table?.load_strategy;
  const partitionBy = resource.extract?.table?.partition_by;

  const emitSchemaArg: Parameters<Emitter['emitSchema']>[0] = {
    name: resource.name,
    output: resource.output,
    ...(resource.load ? { load: resource.load } : {}),
    extract: {
      record_path: '',
      table: {
        ...(primaryKey !== undefined ? { primary_key: primaryKey } : {}),
        ...(loadStrategy !== undefined ? { load_strategy: loadStrategy } : {}),
        ...(partitionBy !== undefined ? { partition_by: partitionBy } : {}),
      },
      ...(cursorField !== undefined
        ? { incremental: { cursor_field: cursorField, cursor_param: '' } }
        : {}),
    },
  };
  return emitSchemaArg;
}

// ---------------------------------------------------------------------------
// Source type guard
// ---------------------------------------------------------------------------

/**
 * Check whether an integration spec is a warehouse/database source.
 *
 * V1 specs carry `source_type` at the top level. V2 specs describe SQL
 * sources as `transports[].type = sql_*` and nest connection/auth/storage
 * under that transport. Legacy V1 warehouse specs can still be identified by
 * a top-level `connection` block.
 */
export function isWarehouseSource(integration: IntegrationSpec): boolean {
  if ('source_type' in integration) {
    const sourceType = integration.source_type;
    if (
      sourceType === undefined ||
      sourceType === 'api' ||
      sourceType === 'custom_api' ||
      sourceType === 'custom_mcp'
    ) {
      return false;
    }
    return !(FileStorageSourceTypeValues as readonly string[]).includes(String(sourceType));
  }
  if ('transports' in integration && Array.isArray(integration.transports)) {
    return getV2SqlTransport(integration) !== undefined;
  }
  return 'connection' in integration;
}

function getV2SqlTransport(
  integration: IntegrationSpec,
  options: { strictDefaultTransport?: boolean } = {}
): { type: string; transport: Record<string, unknown> } | undefined {
  if (!('transports' in integration) || !Array.isArray(integration.transports)) {
    return undefined;
  }
  const transports = (integration.transports as unknown[]).filter(
    (transport): transport is Record<string, unknown> =>
      !!transport && typeof transport === 'object' && 'type' in transport
  );
  const defaultTransport =
    'default_transport' in integration && typeof integration.default_transport === 'string'
      ? integration.default_transport
      : undefined;
  const candidates = defaultTransport
    ? transports.filter((transport) => transport['id'] === defaultTransport)
    : transports;
  if (defaultTransport && candidates.length === 0) {
    throw new CommandError(
      `Integration default_transport "${defaultTransport}" does not match any transport.id`,
      2
    );
  }
  const sqlTransport = candidates.find((transport) =>
    (SqlTransportTypeValues as readonly string[]).includes(String(transport['type']))
  );
  if (!sqlTransport) {
    if (defaultTransport && options.strictDefaultTransport) {
      const transportType = String(candidates[0]?.['type'] ?? 'unknown');
      throw new CommandError(
        `Integration default_transport "${defaultTransport}" points to non-SQL transport type "${transportType}"; warehouse extraction requires a sql_* transport.`,
        2
      );
    }
    return undefined;
  }
  return { type: String(sqlTransport['type']), transport: sqlTransport };
}

/**
 * Check whether a resource spec is a warehouse/database resource.
 *
 * Returns true when the spec has a `source` block (DW/DB resources)
 * rather than an `api` block (API resources).
 *
 * V2 three-block resources are normalized to V1 shape at parse time via
 * ResourceSpecSchema.transform(), so by the time this function is called
 * the resource already has a top-level `source` block.
 */
export function isWarehouseResource(resource: {
  source?: unknown;
  api?: unknown;
}): resource is WarehouseResourceSpec {
  if (!('source' in resource) || resource.source === undefined) {
    return false;
  }
  if (resource.source && typeof resource.source === 'object' && 'path' in resource.source) {
    return false;
  }
  return true;
}

/**
 * Check whether a raw (unparsed) resource is a V2 three-block resource.
 * Used before parsing to detect the shape.
 */
export function isWarehouseResourceV2(resource: unknown): resource is WarehouseResourceV2Spec {
  if (!resource || typeof resource !== 'object') return false;
  const r = resource as Record<string, unknown>;
  return (
    r['schema'] !== undefined &&
    typeof r['schema'] === 'object' &&
    r['schema'] !== null &&
    'columns' in (r['schema'] as Record<string, unknown>) &&
    r['extract'] !== undefined &&
    typeof r['extract'] === 'object' &&
    r['extract'] !== null &&
    'integration' in (r['extract'] as Record<string, unknown>) &&
    'source' in (r['extract'] as Record<string, unknown>)
  );
}

// ---------------------------------------------------------------------------
// Config resolution helpers
// ---------------------------------------------------------------------------

function resolveDialect(integration: IntegrationSpec): Dialect {
  if ('source_type' in integration) {
    const st = integration.source_type;
    if (
      st === 'snowflake' ||
      st === 'bigquery' ||
      st === 'postgres' ||
      st === 'redshift' ||
      st === 'mysql' ||
      st === 'clickhouse' ||
      st === 'iceberg' ||
      st === 'delta'
    ) {
      return st;
    }
  }
  const v2 = getV2SqlTransport(integration);
  if (v2) {
    return v2.type.slice('sql_'.length) as Dialect;
  }
  throw new CommandError('Cannot determine dialect: integration is not a warehouse source');
}

/** True only for sources whose effective extraction transport is Snowflake SQL. */
export function isSnowflakeWarehouseSource(integration: IntegrationSpec): boolean {
  return isWarehouseSource(integration) && resolveDialect(integration) === 'snowflake';
}

function resolveSnowflakeWarehouseSelector(
  selector: string,
  connection: Record<string, unknown>
): string {
  const declared = connection['warehouses'];
  if (declared === undefined) {
    throw new CommandError(
      `Snowflake warehouse selector "${selector}" requires connection.warehouses to declare ` +
        'selector ids. Omit --warehouse to use the connection default.',
      2
    );
  }
  if (!isPlainObject(declared)) {
    throw new CommandError('Snowflake connection.warehouses must be an object.', 2);
  }
  const warehouse = declared[selector];
  if (typeof warehouse === 'string' && warehouse.length > 0) {
    const resolved = resolveEnvVars({ warehouse }, `connection.warehouses.${selector}`).warehouse;
    if (typeof resolved === 'string') return resolved;
  }
  const available = Object.keys(declared);
  throw new CommandError(
    `Snowflake warehouse selector "${selector}" must name a configured warehouses key. ` +
      `Available selectors: ${available.join(', ')}.`,
    2
  );
}

const ENV_TEMPLATE_RE = /^\s*\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

/**
 * Resolve environment variable references in an object.
 *
 * Handles two shapes:
 *   1. Legacy `_env` suffixed keys: `{ account_identifier_env: "SNOWFLAKE_ACCOUNT" }`
 *      Resolves to `{ account_identifier: "<value>" }` and emits a deprecation warning.
 *   2. New-shape `${{ env.X }}` interpolation: `{ account_identifier: "${{ env.SNOWFLAKE_ACCOUNT }}" }`
 *      Resolves the template in-place.
 *
 * Returns a new object with all env references resolved.
 */
function resolveEnvVars(obj: Record<string, unknown>, section: string): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...obj };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== 'string') continue;

    // Legacy _env suffix: strip suffix, read env by name
    if (key.endsWith('_env')) {
      const envValue = process.env[value];
      if (!envValue) {
        throw new Error(
          `Environment variable "${value}" (referenced by ${section}.${key}) is not set`
        );
      }
      const resolvedKey = key.slice(0, -4); // remove '_env' suffix
      // Only set the resolved key if the new-shape field isn't already present
      if (resolved[resolvedKey] === undefined) {
        resolved[resolvedKey] = envValue;
      }
      delete resolved[key];
      warnLegacyEnvField(key);
      continue;
    }

    // New-shape ${{ env.X }} interpolation
    const match = value.match(ENV_TEMPLATE_RE);
    if (match) {
      const envKey = match[1]!;
      // Pass env explicitly to bypass BLOCKED_ENV_KEYS in the interpolation framework
      const envValue = process.env[envKey];
      if (!envValue) {
        throw new Error(
          `Environment variable "${envKey}" (referenced by ${section}.${key}) is not set`
        );
      }
      resolved[key] = envValue;
    }
  }
  return resolved;
}

export function resolveConnectionConfig(integration: IntegrationSpec): Record<string, unknown> {
  assertDeclaredEnvironmentReferences(getConnectionRoot(integration), integration.auth_env_vars);
  const root = getConnectionRoot(integration);
  if (!('connection' in root) || root['connection'] === undefined) {
    throw new CommandError('Integration spec does not have a connection block');
  }

  const conn = root['connection'] as Record<string, unknown>;
  const config = resolveEnvVars(conn, 'connection');

  // Resolve auth env vars
  if ('auth' in root && root['auth'] !== undefined) {
    const auth = root['auth'] as Record<string, unknown>;
    config['auth'] = resolveEnvVars(auth, 'auth');
  }

  // Resolve storage env vars (Iceberg/Delta lakehouse formats)
  if ('storage' in root) {
    const storage = root['storage'] as Record<string, unknown> | undefined;
    if (storage) {
      config['storage'] = resolveEnvVars(storage, 'storage');
    }
  }

  // Resolve ssl env vars (PostgreSQL, Redshift, MySQL, ClickHouse)
  if ('ssl' in root) {
    const ssl = root['ssl'] as Record<string, unknown> | undefined;
    if (ssl) {
      config['ssl'] = resolveEnvVars(ssl, 'ssl');
    }
  }

  return config;
}

/**
 * Validate that database connection hosts are not private/internal addresses.
 * Applies to dialects with user-specified host fields (postgres, redshift, mysql, clickhouse)
 * and Iceberg REST catalog URLs. Snowflake uses account identifiers (already
 * validated), BigQuery uses SDK, Delta uses cloud storage paths.
 */
async function validateConnectionHostSsrf(
  config: Record<string, unknown>,
  dialect: Dialect
): Promise<void> {
  // Iceberg REST catalog: validate catalog_url host upfront (before lazy client creation)
  if (dialect === 'iceberg' && config['mode'] === 'rest_catalog') {
    const catalogUrl = config['catalog_url'];
    if (typeof catalogUrl === 'string' && catalogUrl.length > 0) {
      let hostname: string;
      try {
        hostname = new URL(catalogUrl).hostname;
      } catch {
        throw new Error(`Iceberg catalog URL is not a valid URL: ${catalogUrl}`);
      }
      await resolveAndValidateHost(hostname, 'Iceberg catalog URL');
    }
    return;
  }

  // Only postgres, redshift, mysql, and clickhouse have user-specified host fields.
  if (
    dialect !== 'postgres' &&
    dialect !== 'redshift' &&
    dialect !== 'mysql' &&
    dialect !== 'clickhouse'
  ) {
    return;
  }

  const host = config['host'];
  if (typeof host !== 'string' || host.length === 0) {
    return;
  }

  await resolveAndValidateHost(host, `${dialect} connection`);
}

interface BuildQueryConfigOptions {
  dialect: Dialect;
  resource: WarehouseResourceSpec;
  integration: IntegrationSpec;
  bookmark: StreamBookmark | undefined;
  fullRefresh: boolean;
  /** Pre-resolved TVF for lakehouse formats (iceberg/delta). */
  tvf?: string;
}

function buildQueryConfig(opts: BuildQueryConfigOptions): QueryBuilderConfig {
  const { dialect, resource, integration, bookmark, fullRefresh, tvf } = opts;
  const source: SourceConfig = resource.source;
  const replication: ReplicationConfig = resource.replication;

  // Resolve database/schema from resource source overrides or integration defaults
  const database = source.database ?? getIntegrationDefault(integration, 'database');
  const schema = source.schema ?? getIntegrationDefault(integration, 'schema');
  const dataset = source.dataset ?? getIntegrationDefault(integration, 'dataset');
  const project = getIntegrationDefault(integration, 'project');

  const method = fullRefresh ? ('full_refresh' as const) : replication.method;
  const cursorValue = fullRefresh ? undefined : bookmark?.cursor_value;

  return {
    dialect,
    table: source.table,
    sql: source.sql,
    database,
    schema,
    dataset,
    project,
    tvf,
    method,
    cursorField: replication.cursor_field,
    cursorValue,
    changeTracking: replication.change_tracking as QueryBuilderConfig['changeTracking'],
    lastSyncTimestamp: fullRefresh ? undefined : bookmark?.last_run_at,
  };
}

export function getIntegrationDefault(
  integration: IntegrationSpec,
  field: string
): string | undefined {
  assertDeclaredEnvironmentReferences(getConnectionRoot(integration), integration.auth_env_vars);
  const root = getConnectionRoot(integration);
  if ('connection' in root && isPlainObject(root['connection'])) {
    const conn = root['connection'];
    const picked: Record<string, unknown> = {};
    for (const key of [field, `${field}_env`]) if (key in conn) picked[key] = conn[key];
    const value = resolveEnvVars(picked, 'connection')[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function getConnectionRoot(integration: IntegrationSpec): Record<string, unknown> {
  return (
    getV2SqlTransport(integration, { strictDefaultTransport: true })?.transport ??
    (integration as unknown as Record<string, unknown>)
  );
}

async function validatePostgresChangeTrackingSetup(params: {
  client: PostgresLogicalReplicationClient;
  integration: IntegrationSpec;
  resource: WarehouseResourceSpec;
  config: PostgresChangeTrackingConfig;
}): Promise<void> {
  const { client, integration, resource, config } = params;
  const expectedDatabase = getIntegrationDefault(integration, 'database');
  const expectedSchema = resource.source.schema ?? getIntegrationDefault(integration, 'schema');
  const expectedTable = resource.source.table;

  if (!expectedDatabase || !expectedSchema || !expectedTable) {
    throw new Error(
      'PostgreSQL CDC requires integration.connection.database, a resolved schema, and source.table'
    );
  }

  const slotRows = await client.queryRows(
    'SELECT slot_name, plugin, database FROM pg_replication_slots WHERE slot_name = $1',
    [config.slot_name]
  );
  const slot = slotRows[0];

  if (!slot) {
    throw new Error(
      `Logical replication slot "${config.slot_name}" does not exist. Create it with pg_create_logical_replication_slot('${config.slot_name}', 'pgoutput').`
    );
  }

  if (slot['plugin'] !== 'pgoutput') {
    throw new Error(
      `Logical replication slot "${config.slot_name}" uses plugin "${String(slot['plugin'] ?? '')}", but Dogsled only supports "pgoutput".`
    );
  }

  if (slot['database'] !== expectedDatabase) {
    throw new Error(
      `Logical replication slot "${config.slot_name}" belongs to database "${String(slot['database'] ?? '')}", expected "${expectedDatabase}".`
    );
  }

  const publicationRows = await client.queryRows(
    'SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1',
    [config.publication_name]
  );

  if (publicationRows.length === 0) {
    const publication = await client.queryRows(
      'SELECT pubname FROM pg_publication WHERE pubname = $1',
      [config.publication_name]
    );
    if (publication.length === 0) {
      throw new Error(
        `Publication "${config.publication_name}" does not exist. Create it with CREATE PUBLICATION ${config.publication_name} FOR TABLE ${expectedSchema}.${expectedTable}.`
      );
    }
    throw new Error(
      `Publication "${config.publication_name}" does not expose any tables through pg_publication_tables.`
    );
  }

  const tableMatch = publicationRows.some(
    (row) => row['schemaname'] === expectedSchema && row['tablename'] === expectedTable
  );
  if (!tableMatch) {
    throw new Error(
      `Publication "${config.publication_name}" does not include table "${expectedSchema}.${expectedTable}".`
    );
  }
}

async function extractPostgresChangeTrackingResource(params: {
  client: PostgresLogicalReplicationClient;
  integration: IntegrationSpec;
  resource: WarehouseResourceSpec & {
    replication: WarehouseResourceSpec['replication'] & {
      change_tracking: PostgresChangeTrackingConfig;
    };
  };
  integrationName: string;
  emitter: Emitter;
  logger: ControlLogger;
  state: ExtractorState;
  stateStore: StateStore;
  bookmark: StreamBookmark | undefined;
  advanceState?: boolean;
  limit?: number;
}): Promise<WarehouseExtractResult> {
  const {
    client,
    integration,
    resource,
    integrationName,
    emitter,
    logger,
    state,
    stateStore,
    bookmark,
    advanceState,
    limit,
  } = params;

  await validatePostgresChangeTrackingSetup({
    client,
    integration,
    resource,
    config: resource.replication.change_tracking,
  });

  const queryConfig = buildQueryConfig({
    dialect: 'postgres',
    resource,
    integration,
    bookmark,
    fullRefresh: false,
  });
  const { sql, params: queryParams } = buildExtractionQuery(queryConfig);
  await logger.info(`Executing query: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`);

  await emitter.emitSchema(buildEmitSchemaArg(resource));

  const decoder = new PgoutputDecoder();
  const durableCursor = bookmark?.cursor_value;
  let recordCount = 0;
  let lastCommitLsn: string | undefined;

  outer: for await (const batch of client.execute(sql, queryParams)) {
    const pageTime = new Date().toISOString();

    for (const rawRow of batch) {
      const transaction = decoder.decodeMessage(coerceBuffer(rawRow['data']));
      if (!transaction) {
        continue;
      }

      if (durableCursor && compareCursors(transaction.commitLsn, durableCursor, 'lsn') <= 0) {
        continue;
      }

      for (const change of transaction.changes) {
        if (limit !== undefined && recordCount >= limit) {
          break outer;
        }

        const record = mapPostgresCdcRecord(resource, change, transaction);
        await emitter.emitRecord(resource.name, record, pageTime);
        recordCount += 1;
      }

      lastCommitLsn = transaction.commitLsn;
    }
  }

  await logger.info(`Extracted ${recordCount} records from ${resource.name}`);

  const runAt = new Date().toISOString();
  const bookmarkData: StreamBookmark = {
    cursor_field: '_commit_lsn',
    cursor_type: 'lsn',
    cursor_value: lastCommitLsn,
    last_run_at: runAt,
    record_count: recordCount,
  };
  await emitter.emitState(resource.name, bookmarkData);

  let durableBookmark: StreamBookmark | undefined;
  const shouldAdvanceState = advanceState ?? limit == null;

  if (shouldAdvanceState) {
    durableBookmark = mergeDurableBookmark(bookmark, bookmarkData, 'lsn', runAt);
    if (durableBookmark) {
      state.streams[`${integrationName}/${resource.name}`] = durableBookmark;
      await stateStore.save(state);
      if (durableBookmark.cursor_value) {
        await client.advanceReplicationSlot(
          resource.replication.change_tracking.slot_name,
          durableBookmark.cursor_value
        );
      }
    }
  } else {
    await logger.warn(
      limit != null
        ? `Limited run (${limit} records): PostgreSQL CDC is running in preview mode, so state and slot advancement were skipped for ${resource.name}`
        : `Skipping durable state and slot advancement for ${resource.name}`
    );
  }

  return {
    recordCount,
    bookmark: bookmarkData,
    durableBookmark,
  };
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export async function extractWarehouseResource(
  opts: WarehouseExtractOptions
): Promise<WarehouseExtractResult> {
  const {
    integration,
    resource,
    integrationName,
    emitter,
    logger,
    state,
    stateStore,
    advanceState,
    fullRefresh = false,
    limit,
    warehouse,
    queryTag,
  } = opts;

  const dialect = resolveDialect(integration);
  const connectionConfig = resolveConnectionConfig(integration);

  if (warehouse !== undefined) {
    if (dialect !== 'snowflake') {
      throw new CommandError('--warehouse is only supported for Snowflake sources.', 2);
    }
    connectionConfig['warehouse'] = resolveSnowflakeWarehouseSelector(warehouse, connectionConfig);
  }
  if (queryTag !== undefined && dialect === 'snowflake') {
    connectionConfig['queryTag'] = queryTag;
  }

  // SSRF: validate database host is not a private/internal address
  await validateConnectionHostSsrf(connectionConfig, dialect);

  let client: WarehouseClient | undefined;

  try {
    // 1. Create client
    await logger.info(`Creating ${dialect} client`);
    client = await createWarehouseClient(dialect, connectionConfig);

    // 2. Resolve bookmark state
    const existingBookmark = getStreamBookmark(state, integrationName, resource.name);
    const bookmark = fullRefresh ? undefined : existingBookmark;

    if (fullRefresh && isPostgresChangeTrackingResource(dialect, resource)) {
      throw new CommandError(
        `--full-refresh is not supported for PostgreSQL change_tracking resource "${resource.name}"`
      );
    }

    if (isPostgresChangeTrackingResource(dialect, resource)) {
      if (!isPostgresChangeTrackingClient(client)) {
        throw new Error(
          `Warehouse client for ${dialect} does not support logical replication helpers`
        );
      }
      return await extractPostgresChangeTrackingResource({
        client,
        integration,
        resource,
        integrationName,
        emitter,
        logger,
        state,
        stateStore,
        advanceState,
        bookmark,
        limit,
      });
    }

    // 3. Resolve TVF for lakehouse formats (iceberg/delta)
    let tvf: string | undefined;
    if (client.buildTvf && resource.source.table) {
      const database = resource.source.database ?? getIntegrationDefault(integration, 'database');
      const isCdfMode = !fullRefresh && resource.replication.method === 'change_tracking';

      if (isCdfMode && client.buildCdfTvf) {
        // Delta CDF: build a CDF-specific TVF with version tracking
        const parsed = bookmark?.cursor_value ? parseInt(bookmark.cursor_value, 10) : NaN;
        if (bookmark?.cursor_value && Number.isNaN(parsed)) {
          throw new CommandError(
            `Delta CDF cursor_value "${bookmark.cursor_value}" is not a valid integer version number`
          );
        }
        const sinceVersion = Number.isNaN(parsed) ? undefined : parsed;
        tvf = client.buildCdfTvf(database, resource.source.table, sinceVersion);
      } else {
        tvf = await client.buildTvf(database, resource.source.table);
      }
    }

    // 4. Build extraction query
    const queryConfig = buildQueryConfig({
      dialect,
      resource,
      integration,
      bookmark,
      fullRefresh,
      tvf,
    });
    const { sql, params } = buildExtractionQuery(queryConfig);
    await logger.info(`Executing query: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`);

    // 5. Emit SCHEMA message
    await emitter.emitSchema(buildEmitSchemaArg(resource));

    // 6. Execute query and emit records
    const isCdc = resource.replication.method === 'change_tracking';
    const cursorField = resource.replication.cursor_field;
    const resolvedCursorKind = resolveCursorKind({
      specCursorType: resource.replication.cursor_type ?? bookmark?.cursor_type,
      hintValue: bookmark?.cursor_value,
    });

    let recordCount = 0;
    let lastCursorValue: string | undefined;

    for await (const batch of client.execute(sql, params, limit ? { maxRows: limit } : undefined)) {
      const pageTime = new Date().toISOString();

      for (const rawRow of batch) {
        if (limit !== undefined && recordCount >= limit) {
          break;
        }

        // Normalize CDC metadata columns if applicable, then coerce through the output schema.
        const sourceRow = isCdc ? normalizeCdcMetadata(rawRow, dialect) : rawRow;

        // Skip rows that normalization filters out (e.g. Delta update_preimage)
        if (sourceRow === null) {
          continue;
        }

        const row = mapWarehouseRecord(resource, sourceRow);

        // Emit record
        await emitter.emitRecord(resource.name, row, pageTime);
        recordCount += 1;

        // Track cursor value for state
        if (cursorField) {
          const cursorValue = row[cursorField];
          if (cursorValue != null) {
            const cursorStr = String(cursorValue);
            lastCursorValue =
              !lastCursorValue || !resolvedCursorKind
                ? cursorStr
                : maxCursor(lastCursorValue, cursorStr, resolvedCursorKind);
          }
        }
      }

      if (limit !== undefined && recordCount >= limit) {
        break;
      }
    }

    await logger.info(`Extracted ${recordCount} records from ${resource.name}`);

    // 6. Emit STATE message
    const runAt = new Date().toISOString();
    const bookmarkData: StreamBookmark = {
      cursor_field: cursorField,
      cursor_type: resolvedCursorKind,
      cursor_value: lastCursorValue,
      last_run_at: runAt,
      record_count: recordCount,
    };
    await emitter.emitState(resource.name, bookmarkData);

    // 7. Persist durable bookmark
    let durableBookmark: StreamBookmark | undefined;
    const hasIncremental = resource.replication.method !== 'full_refresh';
    const shouldAdvanceState = advanceState ?? limit == null;

    if (hasIncremental && shouldAdvanceState) {
      durableBookmark = mergeDurableBookmark(
        existingBookmark,
        bookmarkData,
        resolvedCursorKind,
        runAt
      );
      if (durableBookmark) {
        state.streams[`${integrationName}/${resource.name}`] = durableBookmark;
        await stateStore.save(state);
      }
    } else if (hasIncremental && !shouldAdvanceState) {
      await logger.warn(
        limit != null
          ? `Limited run (${limit} records): skipping durable state advancement for ${resource.name}`
          : `Skipping durable state advancement for ${resource.name}`
      );
    }

    return {
      recordCount,
      bookmark: bookmarkData,
      durableBookmark,
    };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    const message =
      error instanceof Error ? error.message : 'Unknown error during warehouse extraction';
    throw new CommandError(`Extraction failed for ${resource.name} (${dialect}): ${message}`);
  } finally {
    if (client) {
      await client.close();
    }
  }
}
