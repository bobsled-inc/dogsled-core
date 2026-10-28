/**
 * Shared test fixture factories for integration and resource specs.
 */

import { EventEmitter } from 'node:events';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';

type LegacyColumn = {
  name: string;
  type: ResourceSpec['output'][string]['type'];
  primary_key?: boolean;
  path?: string;
};

type LegacyLookup = {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  params?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  response?: {
    record_path?: string;
  };
  id_variable?: string;
};

type LegacyResourceOverrides = Partial<ResourceSpec> & {
  connection?: string;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string | number | boolean>;
  response?: {
    record_path?: string;
  };
  incremental?: ResourceSpec['extract']['incremental'];
  schema?: {
    columns: LegacyColumn[];
    semantic?: {
      trust_tier?: 'bronze' | 'silver' | 'gold';
    };
  };
  lookup?: LegacyLookup | ResourceSpec['lookup'];
  billing?: ResourceSpec extends { billing?: infer TBilling } ? TBilling : never;
};

export class FakeWritable extends EventEmitter {
  readonly chunks: string[] = [];
  private shouldBackpressure = false;

  blockNextWrite(): void {
    this.shouldBackpressure = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (!this.shouldBackpressure) {
      return true;
    }

    this.shouldBackpressure = false;
    setTimeout(() => this.emit('drain'), 0);
    return false;
  }

  end(callback?: () => void): this {
    callback?.();
    return this;
  }
}

function columnsToOutput(columns: LegacyColumn[]): ResourceSpec['output'] {
  const output: ResourceSpec['output'] = {};
  for (const column of columns) {
    output[column.name] = {
      type: column.type,
      path: column.path ?? `$.${column.name}`,
    };
  }
  return output;
}

function columnsToPrimaryKeys(columns: LegacyColumn[]): string[] {
  return columns.filter((column) => column.primary_key).map((column) => column.name);
}

function paramsToQueryParams(
  params: Record<string, string | number | boolean> | undefined
): Record<string, string> | undefined {
  if (!params) {
    return undefined;
  }

  const queryParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    queryParams[key] = String(value);
  }
  return queryParams;
}

function normalizeLookup(
  lookup: LegacyLookup | ResourceSpec['lookup'] | undefined
): ResourceSpec['lookup'] | undefined {
  if (!lookup) {
    return undefined;
  }

  if ('api' in lookup) {
    return lookup;
  }

  const idVariable = lookup.id_variable ?? 'id';
  return {
    description: 'Lookup resource',
    api: {
      endpoint: lookup.endpoint,
      method: lookup.method ?? 'GET',
      ...(lookup.headers ? { headers: lookup.headers } : {}),
      ...(lookup.body !== undefined ? { request_body: lookup.body } : {}),
      ...(lookup.params ? { query_params: paramsToQueryParams(lookup.params) } : {}),
    },
    input: {
      [idVariable]: {
        type: 'string',
        required: true,
      },
    },
    ...(lookup.response?.record_path
      ? {
          extract: {
            record_path: lookup.response.record_path,
          },
        }
      : {}),
  };
}

export function makeConnection(
  baseUrl = 'https://api.example.com',
  overrides: Partial<IntegrationSpec> & {
    auth?: IntegrationSpec['transport']['auth'];
    headers?: Record<string, string>;
    timeout_ms?: number;
    retry?: IntegrationSpec['transport']['retry'];
    rate_limit?: IntegrationSpec['transport']['rate_limit'];
    pagination?: ResourceSpec['extract']['pagination'];
  } = {}
): IntegrationSpec & { pagination?: ResourceSpec['extract']['pagination'] } {
  const { auth, headers, timeout_ms, retry, rate_limit, pagination, transport, ...rest } =
    overrides;

  return {
    spec_version: '1',
    name: 'test_api',
    type: 'integration',
    ...rest,
    transport: {
      type: 'http' as const,
      base_url: baseUrl,
      auth: auth ?? { type: 'none' },
      ...(headers ? { headers } : {}),
      ...(timeout_ms ? { timeout_ms } : {}),
      ...(retry ? { retry } : {}),
      ...(rate_limit ? { rate_limit } : {}),
      ...(transport ?? {}),
    },
    ...(pagination ? { pagination } : {}),
  };
}

export const makeProvider = makeConnection;
export const makeIntegration = makeConnection;

export function makeResource(overrides: LegacyResourceOverrides = {}): ResourceSpec {
  const baseColumns: LegacyColumn[] = [
    { name: 'id', type: 'integer', primary_key: true },
    { name: 'name', type: 'string' },
  ];

  const columns = overrides.schema?.columns ?? baseColumns;
  const output = overrides.output ?? columnsToOutput(columns);
  const primaryKeys = overrides.extract?.table?.primary_key ?? columnsToPrimaryKeys(columns);
  const trustTier = overrides.extract?.table?.trust_tier ?? overrides.schema?.semantic?.trust_tier;

  return {
    spec_version: '1',
    name: overrides.name ?? 'test_items',
    type: 'resource',
    integration: overrides.integration ?? overrides.connection ?? 'test_api',
    description: overrides.description ?? 'Test resource',
    api: {
      endpoint: overrides.api?.endpoint ?? overrides.endpoint ?? '/items',
      method: overrides.api?.method ?? overrides.method ?? 'GET',
      ...(overrides.api?.response_format ? { response_format: overrides.api.response_format } : {}),
      ...((overrides.api?.headers ?? overrides.headers)
        ? { headers: overrides.api?.headers ?? overrides.headers }
        : {}),
      ...((overrides.api?.request_body ?? overrides.body !== undefined)
        ? { request_body: overrides.api?.request_body ?? overrides.body }
        : {}),
      ...((overrides.api?.query_params ?? overrides.params)
        ? { query_params: overrides.api?.query_params ?? paramsToQueryParams(overrides.params) }
        : {}),
    },
    input: overrides.input ?? {},
    output,
    extract: {
      record_path: overrides.extract?.record_path ?? overrides.response?.record_path ?? '$',
      ...(overrides.extract?.pagination ? { pagination: overrides.extract.pagination } : {}),
      ...((overrides.extract?.incremental ?? overrides.incremental)
        ? { incremental: overrides.extract?.incremental ?? overrides.incremental }
        : {}),
      ...(overrides.extract?.record_filters
        ? { record_filters: overrides.extract.record_filters }
        : {}),
      ...(overrides.extract && 'for_each' in overrides.extract
        ? { for_each: overrides.extract.for_each }
        : {}),
      ...(overrides.extract && 'where' in overrides.extract
        ? { where: overrides.extract.where }
        : {}),
      ...(overrides.extract && 'stop_when' in overrides.extract
        ? { stop_when: overrides.extract.stop_when }
        : {}),
      table: {
        ...(primaryKeys.length > 0 ? { primary_key: primaryKeys } : {}),
        ...(trustTier ? { trust_tier: trustTier } : {}),
      },
    },
    ...(normalizeLookup(overrides.lookup) ? { lookup: normalizeLookup(overrides.lookup) } : {}),
    ...(overrides.query ? { query: overrides.query } : {}),
    ...(overrides.billing ? { billing: overrides.billing } : {}),
    ...(overrides.health_check ? { health_check: overrides.health_check } : {}),
    ...(overrides.test ? { test: overrides.test } : {}),
  };
}
