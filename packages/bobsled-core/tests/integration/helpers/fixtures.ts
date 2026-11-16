import type { ApiIntegrationSpec, HttpApiResourceSpec } from '@bobsled-inc/extractor/extractor';

export interface ProviderOverrides {
  name?: ApiIntegrationSpec['name'];
}

export interface ResourceOverrides {
  name?: HttpApiResourceSpec['name'];
  integration?: HttpApiResourceSpec['integration'];
  endpoint?: HttpApiResourceSpec['api']['endpoint'];
  response?: ResourceResponseOverrides;
}

export interface ResourceResponseOverrides {
  record_path?: NonNullable<HttpApiResourceSpec['extract']>['record_path'];
}

/** Builds the minimal integration manifest the pipeline smoke tests need. */
export function makeProvider(
  baseUrl: string,
  overrides: ProviderOverrides = {}
): ApiIntegrationSpec {
  return {
    spec_version: '1',
    name: overrides.name ?? 'test_api',
    type: 'integration',
    transport: {
      type: 'http',
      base_url: baseUrl,
      auth: { type: 'none' },
    },
  } satisfies ApiIntegrationSpec;
}

/** Builds a resource manifest that can be customized per smoke-test scenario. */
export function makeResource(overrides: ResourceOverrides = {}): HttpApiResourceSpec {
  return {
    spec_version: '1',
    name: overrides.name ?? 'test_items',
    type: 'resource',
    integration: overrides.integration ?? 'test_api',
    description: 'Test resource',
    api: {
      endpoint: overrides.endpoint ?? '/items',
      method: 'GET',
    },
    input: {},
    output: {
      id: {
        type: 'integer',
        path: '$.id',
      },
      name: {
        type: 'string',
        path: '$.name',
      },
    },
    extract: {
      record_path: overrides.response?.record_path ?? '$',
      table: {
        primary_key: ['id'],
      },
    },
  } satisfies HttpApiResourceSpec;
}
