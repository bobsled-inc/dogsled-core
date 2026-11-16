import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetDnsLookupForTests, setDnsLookupForTests } from '../../../src/framework/core/index.js';
import { buildOperationRequest, parseInputFlags } from '../../../src/framework/runtime/index.js';

describe('parseInputFlags', () => {
  it('parses repeated key=value flags into an input map', () => {
    expect(parseInputFlags(['repo=dogsled', 'limit=10'])).toEqual({
      repo: 'dogsled',
      limit: '10',
    });
  });
});

describe('buildOperationRequest', () => {
  afterEach(() => {
    resetDnsLookupForTests();
    vi.restoreAllMocks();
  });

  it('coerces input values, applies defaults, and interpolates endpoint/query/body values', async () => {
    const request = await buildOperationRequest({
      api: {
        base_url: 'https://api.example.com',
        endpoint: '/repos/${{ input.repo }}/issues/${{ input.id }}',
        method: 'POST',
        timeout_ms: 30_000,
        headers: {
          'X-Repo': '${{ input.repo }}',
        },
        query_params: {
          limit: '${{ input.limit }}',
        },
        request_body: {
          filter: '${{ input.repo }}',
          payload: '${{ input.payload }}',
        },
        auth: {
          type: 'none',
        },
      },
      inputSchema: {
        repo: { type: 'string', required: true },
        id: { type: 'integer', required: true },
        limit: { type: 'integer', default: 100 },
        payload: {
          type: 'object',
          required: true,
          properties: {
            active: { type: 'boolean', required: true },
          },
        },
      },
      providedInput: {
        repo: 'spec repo',
        id: '42',
        payload: '{"active": true}',
      },
    });

    expect(request.input).toEqual({
      repo: 'spec repo',
      id: 42,
      limit: 100,
      payload: {
        active: true,
      },
    });
    expect(request.url).toBe('https://api.example.com/repos/spec%20repo/issues/42?limit=100');
    expect(request.headers).toEqual({
      'X-Repo': 'spec repo',
      'Content-Type': 'application/json',
    });
    expect(request.body).toEqual({
      filter: 'spec repo',
      payload: {
        active: true,
      },
    });
  });

  it('interpolates mapped values into request bodies', async () => {
    const request = await buildOperationRequest({
      api: {
        base_url: 'https://api.example.com',
        endpoint: '/contacts',
        method: 'POST',
        headers: {},
        query_params: {},
        request_body: {
          FirstName: '${{ mapped.first_name }}',
          Profile: '${{ mapped.profile }}',
        },
        auth: {
          type: 'none',
        },
      },
      inputSchema: {
        email: { type: 'string', required: true },
      },
      providedInput: {
        email: 'alice@example.com',
      },
      context: {
        declaredEnvVars: new Set(['SUBDOMAIN']),
        mapped: {
          first_name: 'Alice',
          profile: {
            region: 'NA',
          },
        },
      },
    });

    expect(request.body).toEqual({
      FirstName: 'Alice',
      Profile: {
        region: 'NA',
      },
    });
  });

  it('omits absent optional input fields from request body objects', async () => {
    const request = await buildOperationRequest({
      api: {
        base_url: 'https://api.example.com',
        endpoint: '/metrics',
        method: 'POST',
        headers: {},
        query_params: {},
        request_body: {
          metric: '${{ input.metric }}',
          scope: '${{ input.scope }}',
          filter: '${{ input.filter }}',
          groupBy: '${{ input.group_by }}',
        },
        auth: {
          type: 'none',
        },
      },
      inputSchema: {
        metric: { type: 'string', required: true },
        scope: { type: 'object', required: true },
        filter: { type: 'string' },
        group_by: { type: 'array', items: { type: 'string' } },
      },
      providedInput: {
        metric: 'function_invocations',
        scope: { projectId: 'prj_123' },
      },
    });

    expect(request.body).toEqual({
      metric: 'function_invocations',
      scope: { projectId: 'prj_123' },
    });
  });

  it('still rejects unknown request body input references', async () => {
    await expect(
      buildOperationRequest({
        api: {
          base_url: 'https://api.example.com',
          endpoint: '/metrics',
          method: 'POST',
          headers: {},
          query_params: {},
          request_body: { metric: '${{ input.metric }}' },
          auth: { type: 'none' },
        },
        inputSchema: {},
      })
    ).rejects.toThrow('Missing input.metric');
  });

  it('throws for unknown input keys', async () => {
    await expect(
      buildOperationRequest({
        api: {
          base_url: 'https://api.example.com',
          endpoint: '/items',
          method: 'GET',
          timeout_ms: 30_000,
          headers: {},
          query_params: {},
          auth: {
            type: 'none',
          },
        },
        inputSchema: {},
        providedInput: {
          unexpected: 'value',
        },
      })
    ).rejects.toThrow('Unknown input "unexpected"');
  });

  it('resolves env-templated base URLs before applying the endpoint', async () => {
    const request = await buildOperationRequest({
      api: {
        base_url: 'https://${{ env.SUBDOMAIN }}.example.com/api/v2',
        endpoint: '/items/${{ input.id }}',
        method: 'GET',
        timeout_ms: 30_000,
        headers: {},
        query_params: {},
        auth: {
          type: 'none',
        },
      },
      inputSchema: {
        id: { type: 'integer', required: true },
      },
      providedInput: {
        id: 42,
      },
      context: {
        declaredEnvVars: new Set(['SUBDOMAIN']),
        env: {
          SUBDOMAIN: 'tenant-1',
        },
      },
    });

    expect(request.url).toBe('https://tenant-1.example.com/api/v2/items/42');
  });

  it('rejects public hostnames that resolve to private addresses', async () => {
    const originalAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    setDnsLookupForTests(async () => ({ address: '127.0.0.1', family: 4 }));
    try {
      await expect(
        buildOperationRequest({
          api: {
            base_url: 'https://api.example.com',
            endpoint: '/items',
            method: 'GET',
            timeout_ms: 30_000,
            headers: {},
            query_params: {},
            auth: {
              type: 'none',
            },
          },
          inputSchema: {},
        })
      ).rejects.toThrow('resolves to private address');
    } finally {
      if (originalAllowPrivateHosts !== undefined) {
        process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalAllowPrivateHosts;
      }
    }
  });

  it('skips DNS resolution when explicitly requested by dry-run callers', async () => {
    setDnsLookupForTests(async () => {
      throw new Error('dns lookup should be skipped');
    });

    const request = await buildOperationRequest({
      api: {
        base_url: 'https://api.example.com',
        endpoint: '/items',
        method: 'GET',
        timeout_ms: 30_000,
        headers: {},
        query_params: {},
        auth: {
          type: 'none',
        },
      },
      inputSchema: {},
      skipDnsValidation: true,
    });

    expect(request.url).toBe('https://api.example.com/items');
  });
});
