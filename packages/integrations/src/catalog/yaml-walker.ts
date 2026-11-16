/**
 * Build-time YAML walker for the catalog manifest.
 *
 * Reads every source YAML under `packages/integrations/sources/` and
 * assembles a `CatalogManifest`. Called only by:
 *  - the generator script (`scripts/generate-catalog-manifest.ts`), which
 *    serializes the result into `src/catalog/generated-data.ts`
 *  - the drift-guard test (`tests/catalog-generated-data.test.ts`), which
 *    asserts the committed generated file matches what the walker produces
 *
 * Runtime consumers call `buildCatalogManifest()` from `./manifest.js`,
 * which just returns the baked-in constant — no filesystem I/O.
 *
 * This module intentionally does NOT import from `../validate.js`, which
 * pulls in `@bobsled-inc/extractor` -> DuckDB native binding. Source YAML
 * shape is already enforced by `validate-all.test.ts` at Bobsled Core build time,
 * so the walker can safely use hand-rolled type guards.
 */

import { listResourceFiles, listSourceDirs, readResourceYaml, readSourceYaml } from '../loader.js';

import {
  CATALOG_MANIFEST_SCHEMA_VERSION,
  type CatalogAuthSetupEntry,
  type CatalogColumn,
  type CatalogColumnType,
  type CatalogIncrementalStrategy,
  type CatalogManifest,
  type CatalogManifestSummary,
  type CatalogProbeApi,
  type CatalogProbeAuth,
  type CatalogProbeInputField,
  type CatalogProbeJsonValue,
  type CatalogResource,
  type CatalogResourceTransportVariant,
  type CatalogSource,
  type CatalogSourceType,
  type CatalogTransportConfig,
} from './types.js';

const COLUMN_TYPES = new Set<CatalogColumnType>([
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
  'array',
  'object',
]);

const INCREMENTAL_STRATEGIES = new Set<CatalogIncrementalStrategy>([
  'cursor',
  'server_filter',
  'full_refresh',
]);

interface RawYamlObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is RawYamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function copyJsonValue(value: unknown): CatalogProbeJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const result: CatalogProbeJsonValue[] = [];
    for (const item of value) {
      const copied = copyJsonValue(item);
      if (copied === undefined) return undefined;
      result.push(copied);
    }
    return result;
  }
  if (isObject(value)) {
    const result: Record<string, CatalogProbeJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const copied = copyJsonValue(item);
      if (copied === undefined) return undefined;
      result[key] = copied;
    }
    return result;
  }
  return undefined;
}

function copyStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    result[key] = item;
  }
  return result;
}

const PROBE_FIELD_TYPES = new Set<CatalogProbeInputField['type']>([
  'string',
  'number',
  'integer',
  'boolean',
  'timestamp',
  'array',
  'object',
]);

function rawInputFieldToProbe(raw: unknown): CatalogProbeInputField | undefined {
  if (!isObject(raw)) return undefined;
  const type = raw['type'];
  if (typeof type !== 'string' || !PROBE_FIELD_TYPES.has(type as CatalogProbeInputField['type'])) {
    return undefined;
  }

  const field: CatalogProbeInputField = { type: type as CatalogProbeInputField['type'] };
  if (typeof raw['required'] === 'boolean') field.required = raw['required'];
  const description = asString(raw['description']);
  if (description) field.description = description;
  const defaultValue = copyJsonValue(raw['default']);
  if (defaultValue !== undefined) field.default = defaultValue;
  const enumValues = asStringArray(raw['enum']);
  if (enumValues.length > 0) field.enum = enumValues;
  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ] as const) {
    const value = asNumber(raw[key]);
    if (value !== undefined) field[key] = value;
  }
  if (typeof raw['pattern'] === 'string') field.pattern = raw['pattern'];
  const items = rawInputFieldToProbe(raw['items']);
  if (items) field.items = items;
  if (isObject(raw['properties'])) {
    const properties: Record<string, CatalogProbeInputField> = {};
    for (const [key, value] of Object.entries(raw['properties'])) {
      const property = rawInputFieldToProbe(value);
      if (property) properties[key] = property;
    }
    field.properties = properties;
  }
  return field;
}

function rawInputToProbe(raw: unknown): Record<string, CatalogProbeInputField> {
  if (!isObject(raw)) return {};
  const result: Record<string, CatalogProbeInputField> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = rawInputFieldToProbe(value);
    if (field) result[key] = field;
  }
  return result;
}

const HTTP_METHODS = new Set<CatalogProbeApi['method']>(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function asHttpMethod(value: unknown): CatalogProbeApi['method'] | undefined {
  return typeof value === 'string' && HTTP_METHODS.has(value as CatalogProbeApi['method'])
    ? (value as CatalogProbeApi['method'])
    : undefined;
}

function rawApiToCatalog(raw: RawYamlObject): CatalogProbeApi | undefined {
  const apiRaw = raw['api'];
  if (!isObject(apiRaw)) return undefined;
  const endpoint = asString(apiRaw['endpoint']);
  const method = asHttpMethod(apiRaw['method']);
  if (!endpoint || !method) return undefined;

  const api: CatalogProbeApi = {
    endpoint,
    method: method as CatalogProbeApi['method'],
  };
  const timeout = asNumber(apiRaw['timeout_ms']);
  if (timeout !== undefined) api.timeout_ms = timeout;
  const headers = copyStringRecord(apiRaw['headers']);
  if (headers && Object.keys(headers).length > 0) api.headers = headers;
  const queryParams = copyStringRecord(apiRaw['query_params']);
  if (queryParams && Object.keys(queryParams).length > 0) api.query_params = queryParams;
  const requestBody = copyJsonValue(apiRaw['request_body']);
  if (requestBody !== undefined) api.request_body = requestBody;
  const auth = copyJsonValue(apiRaw['auth']);
  if (isObject(auth)) api.auth = auth as CatalogProbeAuth;

  return api;
}

/**
 * Return the declared output mapping from either supported resource shape.
 * Warehouse V2 resources keep their output contract under schema.columns;
 * API and legacy warehouse resources use top-level output.
 */
export function resourceOutput(raw: RawYamlObject): RawYamlObject | undefined {
  if (isObject(raw['output'])) return raw['output'];
  const schema = raw['schema'];
  return isObject(schema) && isObject(schema['columns']) ? schema['columns'] : undefined;
}

function normalizeColumnType(value: unknown): CatalogColumnType {
  if (typeof value === 'string' && COLUMN_TYPES.has(value as CatalogColumnType)) {
    return value as CatalogColumnType;
  }
  return 'string';
}

function normalizeIncrementalStrategy(value: unknown): CatalogIncrementalStrategy | undefined {
  if (
    typeof value === 'string' &&
    INCREMENTAL_STRATEGIES.has(value as CatalogIncrementalStrategy)
  ) {
    return value as CatalogIncrementalStrategy;
  }
  return undefined;
}

function extractColumns(output: unknown): CatalogColumn[] {
  if (!isObject(output)) return [];
  const columns: CatalogColumn[] = [];
  for (const [name, spec] of Object.entries(output)) {
    if (!isObject(spec)) continue;
    const column: CatalogColumn = {
      name,
      type: normalizeColumnType(spec['type']),
    };
    const description = asString(spec['description']);
    if (description) column.description = description;
    columns.push(column);
  }
  return columns;
}

function extractPrimaryKey(raw: RawYamlObject): string[] {
  const extract = raw['extract'];
  if (!isObject(extract)) return [];
  const table = extract['table'];
  if (!isObject(table)) return [];
  return asStringArray(table['primary_key']);
}

function extractIncremental(raw: RawYamlObject): CatalogResource['incremental'] {
  const incremental = raw['incremental'];
  if (!isObject(incremental)) return undefined;
  const strategy = normalizeIncrementalStrategy(incremental['strategy']);
  if (!strategy) return undefined;
  const cursorField = asString(incremental['cursor_field']);
  return cursorField ? { strategy, cursor_field: cursorField } : { strategy };
}

function extractInput(raw: RawYamlObject): CatalogResource['input'] {
  const input = raw['input'];
  if (!isObject(input)) return undefined;
  const fields = rawInputToProbe(input);
  return fields;
}

function omitSharedVariantInput(
  variants: CatalogResourceTransportVariant[],
  sharedInput: CatalogResource['input']
): CatalogResourceTransportVariant[] {
  if (!sharedInput) return variants;
  const serializedSharedInput = JSON.stringify(sharedInput);
  return variants.map((variant) => {
    if (JSON.stringify(variant.input) !== serializedSharedInput) return variant;
    const withoutInput = { ...variant };
    delete withoutInput.input;
    return withoutInput;
  });
}

function extractHealthCheck(raw: RawYamlObject): CatalogResource['health_check'] {
  const healthCheck = raw['health_check'];
  if (!isObject(healthCheck) || typeof healthCheck['preferred'] !== 'boolean') {
    return undefined;
  }
  return { preferred: healthCheck['preferred'] };
}

function extractStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    result[name] = item;
  }
  return result;
}

function extractTransportConfig(transport: ParsedSourceTransport): CatalogTransportConfig {
  const config: CatalogTransportConfig = { id: transport.id };
  const baseUrl = asString(transport.raw['base_url']);
  if (baseUrl) config.base_url = baseUrl;
  const headers = extractStringRecord(transport.raw['headers']);
  if (headers) config.headers = headers;
  const optionalHeaders = extractStringRecord(transport.raw['optional_headers']);
  if (optionalHeaders) config.optional_headers = optionalHeaders;
  const auth = transport.raw['auth'];
  if (isObject(auth) && typeof auth['type'] === 'string') {
    config.auth = auth as CatalogTransportConfig['auth'];
  }
  const timeout = asNumber(transport.raw['timeout_ms']);
  if (timeout !== undefined) config.timeout_ms = timeout;
  return config;
}

/**
 * Read `extract.for_each.resource` (the parent this resource fans out over) from
 * a raw resource YAML. Both the legacy `{ resource, field, input }` and the
 * multi-binding `{ resource, bindings: [...] }` for_each forms expose `resource`
 * at this path, so a single read covers both. Returns the parent's per-transport
 * spec `name:` (e.g. `pages_mcp`); callers resolve it to a canonical entity.
 */
function extractForEachParentSpecName(raw: RawYamlObject): string | undefined {
  const extract = raw['extract'];
  if (!isObject(extract)) return undefined;
  const forEach = extract['for_each'];
  if (!isObject(forEach)) return undefined;
  return asString(forEach['resource']);
}

function rawResourceToVariant(
  raw: RawYamlObject,
  fallbackVia: string
): CatalogResourceTransportVariant {
  const via = asString(raw['via']) ?? asString(raw['transport']) ?? fallbackVia;
  const output = resourceOutput(raw);

  const api = isObject(raw['api']) ? raw['api'] : undefined;
  const tool = isObject(raw['tool']) ? raw['tool'] : undefined;

  const variant: CatalogResourceTransportVariant = {
    via,
    columns: extractColumns(output),
  };

  if (api) {
    const catalogApi = rawApiToCatalog(raw);
    if (catalogApi) variant.api = catalogApi;
  }
  if (tool) {
    const toolName = asString(tool['tool_name']);
    if (toolName) {
      variant.tool = { tool_name: toolName };
    }
  }

  const input = extractInput(raw);
  if (input) variant.input = input;

  return variant;
}

interface LoadedResourceFile {
  raw: RawYamlObject;
  /** From `name:` field; per-transport for multi-transport resources. */
  spec_name: string;
  /** Canonical entity name: `entity:` field if present, else `name:`. */
  entity: string;
  /** Transport id, falling back to source default_transport if unset. */
  via: string;
}

interface ParsedMeta {
  display_name: string;
  category: string;
  tags: string[];
  auth_setup: CatalogAuthSetupEntry[];
  docs_url: string;
}

interface ParsedSourceTransport {
  id: string;
  /** Raw transport block so callers can read passthrough fields like `auth`. */
  raw: RawYamlObject;
}

interface ParsedSource {
  transports: ParsedSourceTransport[];
  default_transport: string | undefined;
  auth_env_vars: string[];
}

/** Extract the meta.yml fields we read into the catalog. Returns undefined
 * if any required field is missing or the wrong type. Replaces the previous
 * `MetaSpecSchema.safeParse()` call so this module doesn't import the
 * extractor (which would drag DuckDB into consumers' bundles). */
function parseMeta(raw: unknown): ParsedMeta | undefined {
  if (!isObject(raw)) return undefined;
  const display_name = asString(raw['display_name']);
  const category = asString(raw['category']);
  const docs_url = asString(raw['docs_url']);
  if (!display_name || !category || !docs_url) return undefined;
  const tags = asStringArray(raw['tags']);
  if (tags.length === 0) return undefined;
  // `auth_setup` is optional: self-describing `custom_api` sources document
  // their env vars inline via source.yml `auth_env_vars` and may omit it.
  const auth_setup = parseAuthSetup(raw['auth_setup']);
  return { display_name, category, tags, auth_setup, docs_url };
}

function parseAuthSetup(raw: unknown): CatalogAuthSetupEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: CatalogAuthSetupEntry[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const env = asString(item['env']);
    const description = asString(item['description']);
    if (!env || !description) continue;
    const entry: CatalogAuthSetupEntry = { env, description };
    const docs_url = asString(item['docs_url']);
    if (docs_url) entry.docs_url = docs_url;
    entries.push(entry);
  }
  return entries;
}

/** Extract the source.yml fields we read. Mirrors the legacy
 * `SourceSpecSchema.safeParse()` shape: a list of transports (each with
 * an `id` and the raw block for passthrough fields like `auth`), plus
 * the optional `default_transport`. */
function parseSource(raw: unknown): ParsedSource | undefined {
  if (!isObject(raw)) return undefined;
  const transportsRaw = raw['transports'];
  if (!Array.isArray(transportsRaw)) return undefined;
  const transports: ParsedSourceTransport[] = [];
  for (const transportRaw of transportsRaw) {
    if (!isObject(transportRaw)) continue;
    const id = asString(transportRaw['id']);
    if (!id) continue;
    transports.push({ id, raw: transportRaw });
  }
  if (transports.length === 0) return undefined;
  const default_transport = asString(raw['default_transport']);
  const auth_env_vars = asStringArray(raw['auth_env_vars']);
  return { transports, default_transport, auth_env_vars };
}

function loadResourceFile(
  sourceName: string,
  resourceName: string,
  fallbackVia: string
): LoadedResourceFile | undefined {
  let parsed: unknown;
  try {
    parsed = readResourceYaml(sourceName, resourceName);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;

  // We trust the YAML shape (see file header) — only check the fields we
  // actually read for type-correctness. Source authors committing malformed
  // YAML are caught by `validate-all.test.ts` at Bobsled Core build time.
  const specName = asString(parsed['name']);
  if (!specName) return undefined;
  const entity = asString(parsed['entity']) ?? specName;
  const via = asString(parsed['via']) ?? asString(parsed['transport']) ?? fallbackVia;

  return { raw: parsed, spec_name: specName, entity, via };
}

function inferSourceType(defaultTransport: string, transports: string[]): CatalogSourceType {
  // Heuristic; transport ids are user-defined. Cataloging is consumed for
  // agent-discovery hints, not for runtime dispatch — heuristic is fine.
  const all = [defaultTransport, ...transports];
  if (all.some((t) => /^mcp/i.test(t))) {
    return all.every((t) => /^mcp/i.test(t)) ? 'mcp' : 'api';
  }
  if (all.some((t) => /postgres|mysql|snowflake|bigquery|databricks|duckdb/i.test(t))) {
    return 'db';
  }
  return 'api';
}

function buildCatalogSource(sourceName: string): CatalogSource | undefined {
  let metaRaw: unknown;
  let sourceRaw: unknown;
  try {
    metaRaw = readSourceYaml(sourceName, 'meta.yml');
    sourceRaw = readSourceYaml(sourceName, 'source.yml');
  } catch {
    return undefined;
  }

  const meta = parseMeta(metaRaw);
  const source = parseSource(sourceRaw);
  if (!meta || !source) return undefined;

  const transports = source.transports.map((t) => t.id);
  const defaultTransport = source.default_transport ?? transports[0];
  if (!defaultTransport) return undefined;

  const defaultTransportSpec = source.transports.find((t) => t.id === defaultTransport);
  const authBlock =
    defaultTransportSpec && isObject(defaultTransportSpec.raw['auth'])
      ? defaultTransportSpec.raw['auth']
      : undefined;
  const authType = asString(authBlock?.['type']) ?? 'unknown';
  const baseUrl = asString(defaultTransportSpec?.raw['base_url']);

  const sourceType = inferSourceType(defaultTransport, transports);

  // Group resource files by canonical `entity` so multi-transport resources
  // (Linear's `issues/graphql.yml` + `issues/mcp.yml`) collapse into one
  // CatalogResource with two variants.
  const byEntity = new Map<string, LoadedResourceFile[]>();
  for (const resourceName of listResourceFiles(sourceName)) {
    const loaded = loadResourceFile(sourceName, resourceName, defaultTransport);
    if (!loaded) continue;
    const bucket = byEntity.get(loaded.entity) ?? [];
    bucket.push(loaded);
    byEntity.set(loaded.entity, bucket);
  }

  // Map each per-transport spec name (`name:`) to its canonical entity so a
  // for_each parent reference (which names a sibling by spec name) resolves to
  // the entity name catalog consumers actually reference.
  const specNameToEntity = new Map<string, string>();
  for (const files of byEntity.values()) {
    for (const file of files) specNameToEntity.set(file.spec_name, file.entity);
  }

  const resources: CatalogResource[] = [];
  for (const [entity, files] of byEntity.entries()) {
    if (files.length === 0) continue;
    const transportsForResource = files.map((f) => f.via);
    const defaultForResource = transportsForResource.includes(defaultTransport)
      ? defaultTransport
      : (transportsForResource[0] as string);
    const defaultFile =
      files.find((f) => f.via === defaultForResource) ?? (files[0] as LoadedResourceFile);

    const sharedInput = extractInput(defaultFile.raw);
    const variants = omitSharedVariantInput(
      files
        .map((f) => rawResourceToVariant(f.raw, f.via))
        .sort((a, b) => a.via.localeCompare(b.via)),
      sharedInput
    );

    const resource: CatalogResource = {
      name: entity,
      transports: transportsForResource.slice().sort((a, b) => a.localeCompare(b)),
      default_transport: defaultForResource,
      primary_key: extractPrimaryKey(defaultFile.raw),
      variants,
    };

    const description = asString(defaultFile.raw['description']);
    if (description) resource.description = description;
    const incremental = extractIncremental(defaultFile.raw);
    if (incremental) resource.incremental = incremental;
    const healthCheck = extractHealthCheck(defaultFile.raw);
    if (healthCheck) resource.health_check = healthCheck;
    if (sharedInput) resource.input = sharedInput;

    // for_each parent: take the first variant that declares one, mapping the
    // referenced spec name to its canonical entity. Over-inclusive across
    // transports is safe — grouping only co-schedules; the extractor reads the
    // actual resolved spec's for_each at runtime.
    let forEachParentSpec: string | undefined;
    for (const file of files) {
      forEachParentSpec = extractForEachParentSpecName(file.raw);
      if (forEachParentSpec) break;
    }
    if (forEachParentSpec) {
      const parentEntity = specNameToEntity.get(forEachParentSpec) ?? forEachParentSpec;
      if (parentEntity !== entity) resource.for_each_parent = parentEntity;
    }

    resources.push(resource);
  }

  resources.sort((a, b) => a.name.localeCompare(b.name));

  const out: CatalogSource = {
    name: sourceName,
    display_name: meta.display_name,
    category: meta.category,
    source_type: sourceType,
    tags: meta.tags.slice(),
    transports: transports.slice().sort((a, b) => a.localeCompare(b)),
    default_transport: defaultTransport,
    transport_configs: source.transports.map(extractTransportConfig),
    auth_type: authType,
    auth_setup: meta.auth_setup.map((entry): CatalogAuthSetupEntry => {
      const entryOut: CatalogAuthSetupEntry = {
        env: entry.env,
        description: entry.description,
      };
      if (entry.docs_url) entryOut.docs_url = entry.docs_url;
      return entryOut;
    }),
    docs_url: meta.docs_url,
    resource_count: resources.length,
    resources,
  };
  if (baseUrl) out.base_url = baseUrl;
  if (source.auth_env_vars.length > 0) out.auth_env_vars = source.auth_env_vars.slice();
  return out;
}

/**
 * Build the catalog manifest by walking the `sources/` directory.
 * See module-level docs for when to call this vs the runtime constant.
 */
export function buildCatalogManifestFromYaml(): CatalogManifest {
  const sources: CatalogSource[] = [];
  for (const name of listSourceDirs()) {
    const entry = buildCatalogSource(name);
    if (entry) sources.push(entry);
  }
  sources.sort((a, b) => a.name.localeCompare(b.name));

  const summary: CatalogManifestSummary = {
    source_count: sources.length,
    resource_count: sources.reduce((sum, s) => sum + s.resource_count, 0),
    api_source_count: sources.filter((s) => s.source_type === 'api').length,
    mcp_source_count: sources.filter((s) => s.source_type === 'mcp').length,
    db_source_count: sources.filter((s) => s.source_type === 'db').length,
  };

  return {
    schema_version: CATALOG_MANIFEST_SCHEMA_VERSION,
    summary,
    sources,
  };
}
