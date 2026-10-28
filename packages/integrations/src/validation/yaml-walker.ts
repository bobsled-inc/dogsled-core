/**
 * Build-only YAML walker for the validation catalog.
 *
 * Do not import this from the `./validation` runtime entry point. The walker
 * uses the filesystem-backed loader exclusively while generating the committed
 * snapshot and while checking that snapshot for drift in tests.
 */

import { join } from 'node:path';

import {
  getResourcePath,
  getSourceDir,
  listResourceFiles,
  listSourceDirs,
  readYamlFile,
} from '../loader.js';
import {
  INTEGRATION_VALIDATION_CATALOG_SCHEMA_VERSION,
  type IntegrationValidationAuthSetup,
  type IntegrationValidationCatalog,
  type IntegrationValidationForEach,
  type IntegrationValidationResource,
  type IntegrationValidationSource,
} from './types.js';

interface RawYamlObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is RawYamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value) : [];
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

function parseAuthSetup(value: unknown): IntegrationValidationAuthSetup[] {
  if (!Array.isArray(value)) return [];
  const entries: IntegrationValidationAuthSetup[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const env = asString(item['env']);
    const description = asString(item['description']);
    if (!env || !description) continue;
    const entry: IntegrationValidationAuthSetup = { env, description };
    const docsUrl = asString(item['docs_url']);
    if (docsUrl) entry.docs_url = docsUrl;
    entries.push(entry);
  }
  return entries;
}

function parseWarehouses(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const warehouses: Record<string, string> = {};
  for (const name of Object.keys(value)) {
    const warehouse = value[name];
    if (typeof warehouse === 'string') warehouses[name] = warehouse;
  }
  return Object.keys(warehouses).length > 0 ? warehouses : undefined;
}

function extractForEach(value: unknown): IntegrationValidationForEach | undefined {
  if (!isObject(value)) return undefined;
  const resource = asString(value['resource']);
  if (!resource) return undefined;

  const bindings = value['bindings'];
  if (Array.isArray(bindings)) {
    const boundInputs = bindings
      .map((binding) => (isObject(binding) ? asString(binding['input']) : undefined))
      .filter((input): input is string => input !== undefined);
    return boundInputs.length === bindings.length
      ? { resource, bound_inputs: boundInputs }
      : undefined;
  }

  // `as` is kept for old in-memory fixtures. Authored built-in specs use
  // `input`, but the snapshot must preserve either accepted spelling.
  const input = asString(value['input']) ?? asString(value['as']);
  return input ? { resource, bound_inputs: [input] } : undefined;
}

function buildResource(raw: unknown): IntegrationValidationResource | undefined {
  if (!isObject(raw)) return undefined;
  const name = asString(raw['name']);
  if (!name) return undefined;

  const output = resourceOutput(raw);

  const resource: IntegrationValidationResource = {
    name,
    entity: asString(raw['entity']) ?? name,
    input_names: stringKeys(raw['input']),
    output_fields: stringKeys(output),
    embedding_candidates: output
      ? Object.entries(output)
          .filter(([, field]) => isObject(field) && field['embedding_candidate'] === true)
          .map(([field]) => field)
      : [],
    incremental: isObject(raw['incremental']),
  };

  const via = asString(raw['via']);
  if (via) resource.via = via;
  const replication = raw['replication'];
  const replicationMethod = isObject(replication) ? asString(replication['method']) : undefined;
  if (replicationMethod) resource.replication_method = replicationMethod;
  const extract = isObject(raw['extract']) ? raw['extract'] : undefined;
  const forEach = extractForEach(isObject(extract) ? extract['for_each'] : undefined);
  if (forEach) resource.for_each = forEach;
  return resource;
}

function buildSource(name: string): IntegrationValidationSource | undefined {
  let sourceRaw: unknown;
  let metaRaw: unknown;
  try {
    const sourceDir = getSourceDir(name);
    sourceRaw = readYamlFile(join(sourceDir, 'source.yml'));
    metaRaw = readYamlFile(join(sourceDir, 'meta.yml'));
  } catch {
    return undefined;
  }
  if (!isObject(sourceRaw) || !isObject(metaRaw)) return undefined;

  const transports = Array.isArray(sourceRaw['transports'])
    ? sourceRaw['transports']
        .map((transport) => (isObject(transport) ? asString(transport['id']) : undefined))
        .filter((transport): transport is string => transport !== undefined)
    : [];
  const defaultTransport = asString(sourceRaw['default_transport']) ?? transports[0];
  if (!defaultTransport) return undefined;

  const resources: IntegrationValidationResource[] = [];
  for (const resourceName of listResourceFiles(name)) {
    try {
      const resource = buildResource(readYamlFile(getResourcePath(name, resourceName)));
      if (resource) resources.push(resource);
    } catch {
      // Malformed source YAML is rejected by the integration validation suite;
      // this build-only projection simply omits unreadable files.
    }
  }
  resources.sort((a, b) => a.name.localeCompare(b.name));

  const source: IntegrationValidationSource = {
    name,
    auth_setup: parseAuthSetup(metaRaw['auth_setup']),
    transports,
    default_transport: defaultTransport,
    resources,
  };
  const warehouses = parseWarehouses(
    isObject(sourceRaw['connection']) ? sourceRaw['connection']['warehouses'] : undefined
  );
  if (warehouses) source.warehouses = warehouses;
  return source;
}

/** Build the validation snapshot directly from every bundled source YAML. */
export function buildIntegrationValidationCatalogFromYaml(): IntegrationValidationCatalog {
  const sources: IntegrationValidationSource[] = [];
  for (const name of listSourceDirs()) {
    const source = buildSource(name);
    if (source) sources.push(source);
  }
  sources.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schema_version: INTEGRATION_VALIDATION_CATALOG_SCHEMA_VERSION,
    sources,
  };
}
