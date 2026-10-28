import { describe, expect, it } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';

import {
  diffIntegration,
  diffQueryBindings,
  type CheckFinding,
} from '../../src/commands/check-diff.js';
import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntegration(overrides?: Partial<IntegrationSpec>): IntegrationSpec {
  return {
    auth_env_vars: ['TEST_TOKEN'],
    spec_version: '1',
    type: 'integration',
    name: 'test_api',
    transport: {
      base_url: 'https://api.example.com',
      auth: { type: 'bearer', token: '${{ env.TEST_TOKEN }}' },
      rate_limit: { requests_per_second: 10, burst: 20 },
    },
    ...overrides,
  } as IntegrationSpec;
}

function makeResource(overrides?: Record<string, unknown>): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'users',
    integration: 'test_api',
    description: 'List users',
    api: {
      endpoint: '/users',
      method: 'GET',
    },
    input: {},
    output: {
      id: { type: 'integer', path: '$.id' },
      name: { type: 'string', path: '$.name' },
    },
    extract: {
      record_path: '$.data',
    },
    ...overrides,
  } as unknown as ResourceSpec;
}

function makeDoc(
  paths: OpenAPIV3.PathsObject,
  extras?: Partial<OpenAPIV3.Document>
): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0' },
    paths,
    ...extras,
  };
}

function findByCode(findings: CheckFinding[], code: string): CheckFinding | undefined {
  return findings.find((f) => f.code === code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diffIntegration', () => {
  it('reports ENDPOINT_NOT_FOUND when path is missing from spec', () => {
    const doc = makeDoc({});
    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'ENDPOINT_NOT_FOUND');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.resource).toBe('users');
  });

  it('reports METHOD_MISMATCH when method does not exist on path', () => {
    const doc = makeDoc({
      '/users': {
        post: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'METHOD_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
  });

  it('reports FIELD_TYPE_MISMATCH when output field types differ', () => {
    const doc = makeDoc({
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' }, // API says string, YAML says integer
                            name: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'FIELD_TYPE_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.field).toBe('id');
  });

  it('reports MISSING_FIELD for API fields not in output', () => {
    const doc = makeDoc({
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            name: { type: 'string' },
                            email: { type: 'string' }, // Not in our output
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'MISSING_FIELD');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('info');
    expect(finding!.field).toBe('email');
  });

  it('reports PAGINATION_MISMATCH when API has pagination but resource does not', () => {
    const doc = makeDoc({
      '/users': {
        get: {
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: { type: 'object', properties: { id: { type: 'integer' } } },
                      },
                      next_cursor: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'PAGINATION_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.message).toContain('cursor');
  });

  it('reports PAGINATION_MISMATCH when pagination types differ', () => {
    const resource = makeResource({
      extract: {
        record_path: '$.data',
        pagination: {
          type: 'offset',
          offset_param: 'offset',
          limit_param: 'limit',
        },
      },
    });

    const doc = makeDoc({
      '/users': {
        get: {
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { type: 'object' } },
                      next_cursor: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [resource], doc);

    const finding = findByCode(findings, 'PAGINATION_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('offset');
    expect(finding!.message).toContain('cursor');
  });

  it('reports MISSING_BODY_FIELD for POST endpoints with required body fields', () => {
    const resource = makeResource({
      name: 'create_user',
      api: {
        endpoint: '/users',
        method: 'POST',
        request_body: { name: '${{ input.name }}' },
      },
      extract: { record_path: '$' },
    });

    const doc = makeDoc({
      '/users': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'email'],
                  properties: {
                    name: { type: 'string' },
                    email: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [resource], doc);

    const finding = findByCode(findings, 'MISSING_BODY_FIELD');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.field).toBe('email');
  });

  it('reports RATE_LIMIT_AGGRESSIVE when configured rps exceeds API limit', () => {
    const doc = makeDoc({
      '/users': {
        get: {
          'x-ratelimit-limit': 5,
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        } as unknown as OpenAPIV3.OperationObject,
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    const finding = findByCode(findings, 'RATE_LIMIT_AGGRESSIVE');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warn');
    expect(finding!.message).toContain('10');
    expect(finding!.message).toContain('5');
  });

  it('returns no findings when everything matches', () => {
    const doc = makeDoc({
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            name: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [makeResource()], doc);

    // No errors or warnings — only info if the API has exactly the same fields
    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warn');
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('converts template variables when matching endpoints', () => {
    const resource = makeResource({
      name: 'user_details',
      api: {
        endpoint: '/users/${{ input.user_id }}',
        method: 'GET',
      },
      extract: { record_path: '$' },
    });

    const doc = makeDoc({
      '/users/{user_id}': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [resource], doc);

    const endpointNotFound = findByCode(findings, 'ENDPOINT_NOT_FOUND');
    expect(endpointNotFound).toBeUndefined();
  });

  it('matches endpoints when path parameter names differ', () => {
    const resource = makeResource({
      name: 'call_details',
      api: {
        endpoint: '/calls/${{ input.call_id }}',
        method: 'GET',
      },
      extract: { record_path: '$' },
    });

    const doc = makeDoc({
      '/calls/{CallSid}': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [resource], doc);

    expect(findByCode(findings, 'ENDPOINT_NOT_FOUND')).toBeUndefined();
  });

  it('tries both stripped and unstripped base-path variants when matching endpoints', () => {
    const integration = makeIntegration({
      transport: {
        base_url: 'https://app.launchdarkly.com/api/v2',
        auth: { type: 'bearer', token: '${{ env.TEST_TOKEN }}' },
      },
    } as Partial<IntegrationSpec>);
    const resource = makeResource({
      name: 'projects',
      api: {
        endpoint: '/projects',
        method: 'GET',
      },
      extract: { record_path: '$.items' },
    });

    const doc = makeDoc(
      {
        '/api/v2/projects': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
      {
        servers: [{ url: 'https://app.launchdarkly.com' }],
      }
    );

    const findings = diffIntegration(integration, [resource], doc);

    expect(findByCode(findings, 'ENDPOINT_NOT_FOUND')).toBeUndefined();
  });

  it('matches deprecated operations during drift verification', () => {
    const resource = makeResource({
      name: 'search_users',
      api: {
        endpoint: '/users/search',
        method: 'GET',
      },
    });
    const doc = makeDoc({
      '/users/search': {
        get: {
          deprecated: true,
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffIntegration(makeIntegration(), [resource], doc);

    expect(findByCode(findings, 'ENDPOINT_NOT_FOUND')).toBeUndefined();
  });

  it('does not report RATE_LIMIT_AGGRESSIVE when configured rps is within limit', () => {
    const integration = makeIntegration({
      transport: {
        base_url: 'https://api.example.com',
        auth: { type: 'bearer', token: '${{ env.TEST_TOKEN }}' },
        rate_limit: { requests_per_second: 3, burst: 5 },
      },
    } as Partial<IntegrationSpec>);

    const doc = makeDoc({
      '/users': {
        get: {
          'x-ratelimit-limit': 5,
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        } as unknown as OpenAPIV3.OperationObject,
      },
    });

    const findings = diffIntegration(integration, [makeResource()], doc);

    const finding = findByCode(findings, 'RATE_LIMIT_AGGRESSIVE');
    expect(finding).toBeUndefined();
  });
});

describe('diffQueryBindings', () => {
  it('does not warn when a bound input is declared but not wired to api.query_params', () => {
    // The input may be wired through request_body, endpoint path, or another
    // non-query-param sink that this OpenAPI diff check does not inspect.
    const resource = makeResource({
      query: {
        filters: {
          state: {
            operators: ['eq'],
            bind: {
              eq: { input: 'state' },
            },
          },
        },
      },
      input: {
        state: { type: 'string' },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        state: { type: 'string', path: '$.state' },
      },
      api: {
        endpoint: '/users',
        method: 'GET',
      },
    });

    const doc = makeDoc({
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffQueryBindings(makeIntegration(), [resource], doc);

    expect(findByCode(findings, 'QUERY_BIND_INPUT_NOT_WIRED')).toBeUndefined();
  });

  it('warns when a query.search binding targets an input that is not declared on the resource', () => {
    const resource = makeResource({
      query: {
        search: {
          dialect: 'jira_jql',
          bind: { input: 'jql' },
        },
      },
      input: {
        start_at: { type: 'integer' },
      },
      api: {
        endpoint: '/users',
        method: 'GET',
      },
      output: {
        id: { type: 'integer', path: '$.id' },
      },
    });

    const doc = makeDoc({
      '/users': {
        get: {
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const findings = diffQueryBindings(makeIntegration(), [resource], doc);
    const finding = findByCode(findings, 'QUERY_BIND_INPUT_NOT_WIRED');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('query.search.bind.input');
  });

  it('warns when the bound OpenAPI query parameter is missing or mismatched', () => {
    const resource = makeResource({
      query: {
        filters: {
          updated_at: {
            operators: ['gte'],
            bind: {
              gte: { input: 'since' },
            },
          },
        },
      },
      api: {
        endpoint: '/users',
        method: 'GET',
        query_params: {
          since: '${{ input.since }}',
        },
      },
      input: {
        since: { type: 'string' },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        updated_at: { type: 'timestamp', path: '$.updated_at' },
      },
    });

    const missingParamDoc = makeDoc({
      '/users': {
        get: {
          parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const mismatchDoc = makeDoc({
      '/users': {
        get: {
          parameters: [{ name: 'since', in: 'query', schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    expect(
      findByCode(
        diffQueryBindings(makeIntegration(), [resource], missingParamDoc),
        'QUERY_PARAM_NOT_IN_OPENAPI'
      )
    ).toBeDefined();
    expect(
      findByCode(
        diffQueryBindings(makeIntegration(), [resource], mismatchDoc),
        'QUERY_PARAM_TYPE_MISMATCH'
      )
    ).toBeDefined();
  });

  it('warns when the bound OpenAPI query parameter enum is narrower than the query spec', () => {
    const resource = makeResource({
      query: {
        filters: {
          state: {
            operators: ['eq'],
            enum: ['open', 'closed'],
            bind: {
              eq: { input: 'state' },
            },
          },
        },
      },
      api: {
        endpoint: '/users',
        method: 'GET',
        query_params: {
          state: '${{ input.state }}',
        },
      },
      input: {
        state: { type: 'string' },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        state: { type: 'string', path: '$.state' },
      },
    });

    const doc = makeDoc({
      '/users': {
        get: {
          parameters: [{ name: 'state', in: 'query', schema: { type: 'string', enum: ['open'] } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    expect(
      findByCode(diffQueryBindings(makeIntegration(), [resource], doc), 'QUERY_PARAM_ENUM_MISMATCH')
    ).toBeDefined();
  });
});
