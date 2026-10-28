import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import { IntegrationSpecSchema, ResourceSpecSchema } from '../../src/framework/extractor/index.js';

import {
  generateFromOpenApi,
  inferIntegrationName,
  mapIntegrationSpec,
  mapAuth,
  detectPagination,
  inferRecordPath,
  detectLookupPairs,
  parseOpenApiSpec,
} from '../../src/runtime/openapi-mapper.js';

import type { OpenAPIV3 } from 'openapi-types';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../fixtures/openapi');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseOpenApiSpec security', () => {
  it('rejects redirects when fetching a remote document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openapi: '3.0.0',
          info: { title: 'Remote API', version: '1.0.0' },
          paths: {},
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseOpenApiSpec('https://specs.example.com/openapi.json')).resolves.toMatchObject(
      {
        openapi: '3.0.0',
      }
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://specs.example.com/openapi.json',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('does not resolve external HTTP references from a remote document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openapi: '3.0.0',
          info: { title: 'Remote API', version: '1.0.0' },
          paths: {
            '/items': {
              get: {
                responses: {
                  '200': {
                    description: 'ok',
                    content: {
                      'application/json': {
                        schema: { $ref: 'https://refs.example.com/item.json' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseOpenApiSpec('https://specs.example.com/openapi.json')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// inferIntegrationName
// ---------------------------------------------------------------------------

describe('inferIntegrationName', () => {
  const baseDoc = {
    openapi: '3.0.0',
    info: { title: '', version: '1.0' },
    paths: {},
  } satisfies OpenAPIV3.Document;

  it('uses explicit name when provided', () => {
    expect(inferIntegrationName(baseDoc, 'my_provider')).toBe('my_provider');
  });

  it('slugifies info.title', () => {
    const doc = { ...baseDoc, info: { title: 'Stripe API v2', version: '1' } };
    expect(inferIntegrationName(doc)).toBe('stripe_api_v2');
  });

  it('falls back to server hostname', () => {
    const doc = {
      ...baseDoc,
      info: { title: '', version: '1' },
      servers: [{ url: 'https://api.acme.com/v1' }],
    };
    expect(inferIntegrationName(doc)).toBe('acme');
  });

  it('returns "api" as ultimate fallback', () => {
    const doc = { ...baseDoc, info: { title: '', version: '1' } };
    expect(inferIntegrationName(doc)).toBe('api');
  });
});

// ---------------------------------------------------------------------------
// mapAuth
// ---------------------------------------------------------------------------

describe('mapAuth', () => {
  it('maps bearer auth', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http' as const, scheme: 'bearer' },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'stripe');
    expect(auth).toEqual({
      type: 'bearer',
      token: '${{ env.STRIPE_TOKEN }}',
    });
  });

  it('maps basic auth', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          basicAuth: { type: 'http' as const, scheme: 'basic' },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'myapi');
    expect(auth).toEqual({
      type: 'basic',
      username: '${{ env.MYAPI_USERNAME }}',
      password: '${{ env.MYAPI_PASSWORD }}',
    });
  });

  it('maps apiKey in header', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey' as const,
            in: 'header' as const,
            name: 'X-API-Key',
          },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'example');
    expect(auth).toEqual({
      type: 'api-key',
      key: '${{ env.EXAMPLE_API_KEY }}',
      header: 'X-API-Key',
    });
  });

  it('maps apiKey in query', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey' as const,
            in: 'query' as const,
            name: 'api_key',
          },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'geo');
    expect(auth).toEqual({
      type: 'api-key',
      key: '${{ env.GEO_API_KEY }}',
      query_param: 'api_key',
    });
  });

  it('maps oauth2 client_credentials', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          oauth: {
            type: 'oauth2' as const,
            flows: {
              clientCredentials: {
                tokenUrl: 'https://auth.example.com/token',
                scopes: {},
              },
            },
          },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'myapi');
    expect(auth).toEqual({
      type: 'oauth2',
      grant_type: 'client_credentials',
      token_url: 'https://auth.example.com/token',
      client_id: '${{ env.MYAPI_CLIENT_ID }}',
      client_secret: '${{ env.MYAPI_CLIENT_SECRET }}',
    });
  });

  it('maps oauth2 authorization_code to refresh-token auth', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
      components: {
        securitySchemes: {
          oauth: {
            type: 'oauth2' as const,
            flows: {
              authorizationCode: {
                authorizationUrl: 'https://auth.example.com/authorize',
                tokenUrl: 'https://auth.example.com/token',
                scopes: {
                  ads: 'Read ads data',
                  offline_access: 'Refresh token scope',
                },
              },
            },
          },
        },
      },
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'google_ads');
    expect(auth).toEqual({
      type: 'oauth2',
      grant_type: 'authorization_code',
      token_url: 'https://auth.example.com/token',
      client_id: '${{ env.GOOGLE_ADS_CLIENT_ID }}',
      client_secret: '${{ env.GOOGLE_ADS_CLIENT_SECRET }}',
      refresh_token: '${{ env.GOOGLE_ADS_REFRESH_TOKEN }}',
      scopes: ['ads', 'offline_access'],
    });
  });

  it('defaults to bearer when no schemes defined', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '', version: '1' },
      paths: {},
    } satisfies OpenAPIV3.Document;

    const auth = mapAuth(doc, 'unknown');
    expect(auth).toEqual({
      type: 'bearer',
      token: '${{ env.UNKNOWN_TOKEN }}',
    });
  });
});

// ---------------------------------------------------------------------------
// mapIntegrationSpec
// ---------------------------------------------------------------------------

describe('mapIntegrationSpec', () => {
  it('generates a valid integration spec', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Test API', description: 'A test API for testing.', version: '1.0' },
      paths: {},
      servers: [{ url: 'https://api.test.com' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http' as const, scheme: 'bearer' },
        },
      },
    } satisfies OpenAPIV3.Document;

    const spec = mapIntegrationSpec(doc, 'test');
    expect(spec['spec_version']).toBe('1');
    expect(spec['type']).toBe('integration');
    expect(spec['name']).toBe('test');
    expect(spec['auth_env_vars']).toEqual(['TEST_TOKEN']);
    expect(spec['description']).toBe('A test API for testing.');

    const transport = spec['transport'] as Record<string, unknown>;
    expect(transport['base_url']).toBe('https://api.test.com');

    // Validate against Zod schema
    const result = IntegrationSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
  });

  it('upgrades HTTP to HTTPS', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1' },
      paths: {},
      servers: [{ url: 'http://api.insecure.com' }],
    } satisfies OpenAPIV3.Document;

    const spec = mapIntegrationSpec(doc, 'insecure');
    const transport = spec['transport'] as Record<string, unknown>;
    expect(transport['base_url']).toBe('https://api.insecure.com');
  });

  it('resolves server variables', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1' },
      paths: {},
      servers: [
        {
          url: 'https://{environment}.api.com/{version}',
          variables: {
            environment: { default: 'production' },
            version: { default: 'v2' },
          },
        },
      ],
    } satisfies OpenAPIV3.Document;

    const spec = mapIntegrationSpec(doc, 'test');
    const transport = spec['transport'] as Record<string, unknown>;
    expect(transport['base_url']).toBe('https://production.api.com/v2');
  });
});

// ---------------------------------------------------------------------------
// detectPagination
// ---------------------------------------------------------------------------

describe('detectPagination', () => {
  it('detects cursor pagination from query + response', () => {
    const params: OpenAPIV3.ParameterObject[] = [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ];
    const response: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        data: { type: 'array', items: {} },
        next_cursor: { type: 'string' },
      },
    };
    const result = detectPagination(params, response);
    expect(result).toEqual({
      type: 'cursor',
      cursor_param: 'cursor',
      cursor_path: '$.next_cursor',
    });
  });

  it('detects offset pagination', () => {
    const params: OpenAPIV3.ParameterObject[] = [
      { name: 'offset', in: 'query', schema: { type: 'integer' } },
      { name: 'limit', in: 'query', schema: { type: 'integer' } },
    ];
    const result = detectPagination(params, null);
    expect(result).toEqual({
      type: 'offset',
      offset_param: 'offset',
      limit_param: 'limit',
    });
  });

  it('detects page number pagination', () => {
    const params: OpenAPIV3.ParameterObject[] = [
      { name: 'page', in: 'query', schema: { type: 'integer' } },
      { name: 'per_page', in: 'query', schema: { type: 'integer' } },
    ];
    const result = detectPagination(params, null);
    expect(result).toEqual({
      type: 'page_number',
      page_param: 'page',
      per_page_param: 'per_page',
    });
  });

  it('detects next_url pagination from response', () => {
    const response: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        items: { type: 'array', items: {} },
        next: { type: 'string' },
      },
    };
    const result = detectPagination([], response);
    expect(result).toEqual({
      type: 'next_url',
      next_url_path: '$.next',
    });
  });

  it('returns null when no pagination detected', () => {
    const result = detectPagination([], null);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferRecordPath
// ---------------------------------------------------------------------------

describe('inferRecordPath', () => {
  it('handles top-level array', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } } },
    };
    const { recordPath } = inferRecordPath(schema);
    expect(recordPath).toBe('$');
  });

  it('detects single array property', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' },
      },
    };
    const { recordPath } = inferRecordPath(schema);
    expect(recordPath).toBe('$.items');
  });

  it('prefers well-known data property', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        included: { type: 'array', items: { type: 'object' } },
      },
    };
    const { recordPath } = inferRecordPath(schema);
    expect(recordPath).toBe('$.data');
  });

  it('skips pagination metadata arrays', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        results: { type: 'array', items: { type: 'object' } },
        links: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' },
      },
    };
    const { recordPath } = inferRecordPath(schema);
    expect(recordPath).toBe('$.results');
  });

  it('handles single-object endpoint', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    };
    const { recordPath } = inferRecordPath(schema);
    expect(recordPath).toBe('$');
  });
});

// ---------------------------------------------------------------------------
// detectLookupPairs
// ---------------------------------------------------------------------------

describe('detectLookupPairs', () => {
  it('pairs list + detail endpoints', () => {
    const ops = [
      {
        path: '/pets',
        method: 'GET',
        operation: { responses: {} } as OpenAPIV3.OperationObject,
        pathItem: {} as OpenAPIV3.PathItemObject,
      },
      {
        path: '/pets/{petId}',
        method: 'GET',
        operation: { responses: {} } as OpenAPIV3.OperationObject,
        pathItem: {} as OpenAPIV3.PathItemObject,
      },
    ];

    const pairs = detectLookupPairs(ops);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.list.path).toBe('/pets');
    expect(pairs[0]!.detail.path).toBe('/pets/{petId}');
  });

  it('does not pair unrelated endpoints', () => {
    const ops = [
      {
        path: '/pets',
        method: 'GET',
        operation: { responses: {} } as OpenAPIV3.OperationObject,
        pathItem: {} as OpenAPIV3.PathItemObject,
      },
      {
        path: '/stores/{storeId}',
        method: 'GET',
        operation: { responses: {} } as OpenAPIV3.OperationObject,
        pathItem: {} as OpenAPIV3.PathItemObject,
      },
    ];

    const pairs = detectLookupPairs(ops);
    expect(pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full integration: petstore
// ---------------------------------------------------------------------------

describe('generateFromOpenApi (petstore)', () => {
  it('generates valid specs from petstore fixture', async () => {
    const source = path.join(FIXTURES_DIR, 'petstore.json');
    const result = await generateFromOpenApi(source, {});

    // Integration should be valid
    const parseResult = IntegrationSpecSchema.safeParse(result.integration.spec);
    expect(parseResult.success).toBe(true);

    // Should have multiple resources
    expect(result.resources.length).toBeGreaterThan(0);

    // Integration name should be inferred
    expect(result.integration.spec['name']).toBe('petstore_api');
  });

  it('filters by tags', async () => {
    const source = path.join(FIXTURES_DIR, 'petstore.json');
    const result = await generateFromOpenApi(source, { tags: ['stores'] });

    // Should only have store resources
    const resourceNames = result.resources.map((r) => r.spec['name']);
    expect(resourceNames.some((n) => String(n).includes('store'))).toBe(true);
    expect(resourceNames.some((n) => String(n).includes('pet'))).toBe(false);
  });

  it('links lookup endpoints', async () => {
    const source = path.join(FIXTURES_DIR, 'petstore.json');
    const result = await generateFromOpenApi(source, { tags: ['pets'] });

    // The listPets resource should have a lookup section
    const listPets = result.resources.find((r) => r.spec['name'] === 'list_pets');
    expect(listPets).toBeDefined();
    expect(listPets!.spec['lookup']).toBeDefined();
  });

  it('detects cursor pagination on pets', async () => {
    const source = path.join(FIXTURES_DIR, 'petstore.json');
    const result = await generateFromOpenApi(source, { tags: ['pets'] });

    const listPets = result.resources.find((r) => r.spec['name'] === 'list_pets');
    expect(listPets).toBeDefined();

    const extract = listPets!.spec['extract'] as Record<string, unknown>;
    const pagination = extract['pagination'] as Record<string, unknown>;
    expect(pagination['type']).toBe('cursor');
  });

  it('overrides integration name', async () => {
    const source = path.join(FIXTURES_DIR, 'petstore.json');
    const result = await generateFromOpenApi(source, { integrationName: 'my_pet_api' });

    expect(result.integration.spec['name']).toBe('my_pet_api');
  });
});

// ---------------------------------------------------------------------------
// Full integration: stripe subset
// ---------------------------------------------------------------------------

describe('generateFromOpenApi (stripe-subset)', () => {
  it('generates valid specs from stripe fixture', async () => {
    const source = path.join(FIXTURES_DIR, 'stripe-subset.json');
    const result = await generateFromOpenApi(source, {});

    // Integration
    const integrationResult = IntegrationSpecSchema.safeParse(result.integration.spec);
    expect(integrationResult.success).toBe(true);
    expect(result.integration.spec['name']).toBe('stripe_api');

    // Should have customer and invoice resources (detail endpoints are lookups)
    expect(result.resources.length).toBe(2);
  });

  it('skips cursor pagination when only boolean flags exist in response', async () => {
    // Stripe uses has_more (boolean) + starting_after (query param).
    // has_more is a continuation flag, not a cursor value — using it as cursor_path
    // would yield a boolean instead of a pagination token. No pagination should be emitted.
    const source = path.join(FIXTURES_DIR, 'stripe-subset.json');
    const result = await generateFromOpenApi(source, {});

    const customers = result.resources.find((r) => r.spec['name'] === 'list_customers');
    expect(customers).toBeDefined();

    const extract = customers!.spec['extract'] as Record<string, unknown>;
    expect(extract['pagination']).toBeUndefined();
  });

  it('links customer detail as lookup', async () => {
    const source = path.join(FIXTURES_DIR, 'stripe-subset.json');
    const result = await generateFromOpenApi(source, {});

    const customers = result.resources.find((r) => r.spec['name'] === 'list_customers');
    expect(customers).toBeDefined();
    expect(customers!.spec['lookup']).toBeDefined();
  });

  it('filters by customers tag', async () => {
    const source = path.join(FIXTURES_DIR, 'stripe-subset.json');
    const result = await generateFromOpenApi(source, { tags: ['customers'] });

    expect(result.resources.length).toBe(1);
    expect(result.resources[0]!.spec['name']).toBe('list_customers');
  });
});

// ---------------------------------------------------------------------------
// Full integration: github subset
// ---------------------------------------------------------------------------

describe('generateFromOpenApi (github-subset)', () => {
  it('generates valid specs from github YAML fixture', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, {});

    const providerResult = IntegrationSpecSchema.safeParse(result.integration.spec);
    expect(providerResult.success).toBe(true);
    expect(result.integration.spec['name']).toBe('git_hub_rest_api');
  });

  it('detects page number pagination', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, {});

    // Issues should have page number pagination (page + per_page)
    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();

    const extract = issues!.spec['extract'] as Record<string, unknown>;
    const pagination = extract['pagination'] as Record<string, unknown>;
    expect(pagination['type']).toBe('page_number');
  });

  it('flattens nested user object', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, { tags: ['issues'] });

    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();

    const output = issues!.spec['output'] as Record<string, unknown>;
    // User object should be flattened: user_login, user_id
    expect(output['user_login']).toBeDefined();
    expect(output['user_id']).toBeDefined();
  });

  it('infers primary key from id field', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, { tags: ['issues'] });

    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();

    const extract = issues!.spec['extract'] as Record<string, unknown>;
    const table = extract['table'] as Record<string, unknown>;
    expect(table['primary_key']).toEqual(['id']);
  });

  it('infers incremental cursor from updated_at', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, { tags: ['issues'] });

    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();

    const extract = issues!.spec['extract'] as Record<string, unknown>;
    const incremental = extract['incremental'] as Record<string, unknown>;
    expect(incremental).toBeDefined();
    expect(incremental['cursor_field']).toBe('updated_at');
    expect(incremental['cursor_param']).toBe('since');
  });

  it('generates test fixtures from parameter examples', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, { tags: ['issues'] });

    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();

    const test = issues!.spec['test'] as Record<string, unknown>;
    expect(test).toBeDefined();
    expect(test['fixtures']).toBeDefined();

    const fixtures = test['fixtures'] as Array<Record<string, unknown>>;
    expect(fixtures.length).toBeGreaterThan(0);
    const input = fixtures[0]!['input'] as Record<string, unknown>;
    expect(input['owner']).toBe('octocat');
    expect(input['repo']).toBe('hello-world');
  });

  it('links issue detail as lookup', async () => {
    const source = path.join(FIXTURES_DIR, 'github-subset.yaml');
    const result = await generateFromOpenApi(source, { tags: ['issues'] });

    const issues = result.resources.find((r) => r.spec['name'] === 'list_issues');
    expect(issues).toBeDefined();
    expect(issues!.spec['lookup']).toBeDefined();

    const lookup = issues!.spec['lookup'] as Record<string, unknown>;
    const api = lookup['api'] as Record<string, unknown>;
    expect(api['endpoint']).toContain('${{ input.');
  });
});

// ---------------------------------------------------------------------------
// Zod validation on all fixtures
// ---------------------------------------------------------------------------

describe('all generated specs pass Zod validation', () => {
  for (const fixture of ['petstore.json', 'stripe-subset.json', 'github-subset.yaml']) {
    it(`${fixture}: all resource specs are valid`, async () => {
      const source = path.join(FIXTURES_DIR, fixture);
      const result = await generateFromOpenApi(source, {});

      for (const res of result.resources) {
        const validation = ResourceSpecSchema.safeParse(res.spec);
        if (!validation.success) {
          const errors = validation.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('\n');
          throw new Error(`Resource ${res.fileName} failed validation:\n${errors}`);
        }
      }
    });
  }
});
