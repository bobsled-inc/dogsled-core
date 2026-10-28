import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  QueryFanOutError,
  planQueryFanOut,
  queryResourceFanOut,
} from '../../src/runtime/query/fan-out.js';
import { McpExtractorClient } from '../../src/runtime/mcp-client.js';
import { RateLimiter } from '../../src/runtime/rate-limiter.js';
import { makeProvider, makeResource } from '../helpers/fixtures.js';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';

const mcpFixturePath = fileURLToPath(new URL('../fixtures/mcp/test-server.mjs', import.meta.url));

function resources(): ResourceSpec[] {
  const organizations = makeResource({
    name: 'organizations',
    api: { endpoint: '/organizations', method: 'GET' },
    input: { organization_filter: { type: 'string' } },
    output: { organization_id: { type: 'string', path: '$.id' } },
    query: {
      filters: {
        organization_id: {
          operators: ['eq'],
          bind: { eq: { input: 'organization_filter' } },
        },
      },
    },
    extract: { record_path: '$' },
  });
  const projects = makeResource({
    name: 'projects',
    api: { endpoint: '/projects/${{ input.organization_id }}', method: 'GET' },
    input: {
      organization_id: { type: 'string', required: true },
      project_filter: { type: 'string' },
    },
    output: {
      project_id: { type: 'string', path: '$.id' },
      organization_id: {
        type: 'string',
        from: { resource: 'organizations', path: '$.organization_id' },
      },
    },
    query: {
      filters: {
        project_id: {
          operators: ['eq'],
          bind: { eq: { input: 'project_filter' } },
        },
      },
    },
    extract: {
      record_path: '$',
      for_each: {
        resource: 'organizations',
        field: 'organization_id',
        input: 'organization_id',
        where: [{ field: 'organization_id', neq: 'skip' }],
      },
    },
  });
  const events = makeResource({
    name: 'events',
    api: {
      endpoint: '/events/${{ input.organization_id }}/${{ input.project_id }}',
      method: 'GET',
    },
    input: {
      organization_id: { type: 'string', required: true },
      project_id: { type: 'string', required: true },
    },
    output: {
      event_id: { type: 'string', path: '$.id' },
      organization_id: {
        type: 'string',
        from: { resource: 'organizations', path: '$.organization_id' },
      },
      project_id: { type: 'string', from: { resource: 'projects', path: '$.project_id' } },
    },
    extract: {
      record_path: '$',
      for_each: {
        resource: 'projects',
        bindings: [
          { field: 'organization_id', input: 'organization_id', source: 'output' },
          { field: 'project_id', input: 'project_id' },
        ],
        concurrency: 2,
      },
    },
  });
  return [organizations, projects, events];
}

function patchResource(
  resource: ResourceSpec,
  patch: Record<string, unknown> & { extract?: Record<string, unknown> }
): ResourceSpec {
  const { extract, ...rest } = patch;
  return {
    ...resource,
    ...rest,
    ...(extract ? { extract: { ...resource.extract, ...extract } } : {}),
  } as ResourceSpec;
}

function simpleQuery(input: string, output = 'id') {
  return {
    filters: {
      [output]: {
        operators: ['eq'] as const,
        bind: { eq: { input } },
      },
    },
  };
}

function makeMcpIntegration(): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'fixture_mcp',
    transport: {
      type: 'mcp_stdio',
      command: 'node',
      args: [mcpFixturePath],
      retry: { max_retries: 0 },
    },
  } as IntegrationSpec;
}

function makeMcpListResource(): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'items',
    integration: 'fixture_mcp',
    description: 'MCP fixture list',
    tool: { tool_name: 'list_items' },
    input: {},
    output: {
      id: { type: 'string', path: '$.id' },
      name: { type: 'string', path: '$.name' },
    },
    extract: {
      record_path: '$.items',
      pagination: {
        type: 'mcp_cursor',
        cursor_path: '$.pageInfo.endCursor',
        cursor_argument: 'after',
      },
    },
  } as ResourceSpec;
}

describe('planQueryFanOut validation', () => {
  it('redacts non-enumerable native cause and stack details while preserving mutable cause identity', () => {
    const token = 'nested-provider-secret';
    const nested = new Error(`nested ${token}`);
    const providerCause = new Error(`outer ${token}`, { cause: nested });
    const error = new QueryFanOutError({
      code: 'QUERY_FAN_OUT_PROVIDER_FAILURE',
      kind: 'provider',
      phase: 'child',
      target: 'items',
      resource: 'items',
      message: 'Safe provider failure.',
      counts: {
        parentWorkItems: 0,
        targetRows: 0,
        providerAttempts: 1,
        requestCount: 1,
        resultCount: 0,
        mappedBytes: 0,
        maxConcurrency: 1,
        durationMs: 1,
      },
      cause: providerCause,
    });

    expect(error.cause).toBe(providerCause);
    expect(providerCause.message).toBe('Safe provider failure.');
    expect(providerCause.stack).not.toContain(token);
    expect((providerCause.cause as Error).message).toBe('[redacted provider cause]');
    expect((providerCause.cause as Error).stack).not.toContain(token);
  });

  it('bounds cyclic native provider cause chains', () => {
    const providerCause = new Error('unsafe cycle');
    Object.defineProperty(providerCause, 'cause', {
      value: providerCause,
      configurable: true,
      writable: true,
    });

    const error = new QueryFanOutError({
      code: 'QUERY_FAN_OUT_PROVIDER_FAILURE',
      kind: 'provider',
      phase: 'child',
      target: 'items',
      message: 'Safe provider failure.',
      counts: {
        parentWorkItems: 0,
        targetRows: 0,
        providerAttempts: 1,
        requestCount: 1,
        resultCount: 0,
        mappedBytes: 0,
        maxConcurrency: 1,
        durationMs: 1,
      },
      cause: providerCause,
    });

    expect(error.cause).toBe(providerCause);
    expect(providerCause.cause).toBeInstanceOf(Error);
    expect(providerCause.cause).not.toBe(providerCause);
  });

  it('rejects missing and ambiguous Resources before execution', () => {
    expect(() => planQueryFanOut({ resources: [], target: 'missing' })).toThrow('was not supplied');

    const root = makeResource({ name: 'root', query: simpleQuery('id_filter') });
    expect(() =>
      planQueryFanOut({ resources: [root, patchResource(root, {})], target: 'root' })
    ).toThrow('is ambiguous');
  });

  it('ignores unrelated non-API Resources while planning the target chain', () => {
    const target = makeResource({ name: 'target', query: simpleQuery('id_filter') });
    const unrelated = {
      spec_version: '1',
      type: 'resource',
      name: 'warehouse_table',
      input: {},
      output: {},
    } as unknown as ResourceSpec;

    expect(
      planQueryFanOut({ resources: [unrelated, target], target: 'target' }).topologicalOrder
    ).toEqual(['target']);
  });

  it('rejects missing parents, cycles, and excessive graph depth', () => {
    const missingParent = patchResource(resources()[1]!, {
      extract: {
        for_each: {
          resource: 'does_not_exist',
          field: 'organization_id',
          input: 'organization_id',
        },
      },
    });
    expect(() =>
      planQueryFanOut({ resources: [resources()[0]!, missingParent], target: 'projects' })
    ).toThrow('references missing parent');

    const a = makeResource({
      name: 'a',
      input: { parent_id: { type: 'string' } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('parent_id'),
      extract: {
        record_path: '$',
        for_each: { resource: 'b', field: 'id', input: 'parent_id' },
      },
    });
    const b = makeResource({
      name: 'b',
      input: { parent_id: { type: 'string' } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('parent_id'),
      extract: {
        record_path: '$',
        for_each: { resource: 'a', field: 'id', input: 'parent_id' },
      },
    });
    expect(() => planQueryFanOut({ resources: [a, b], target: 'a' })).toThrow('cycle');
    expect(() =>
      planQueryFanOut({ resources: resources(), target: 'events', maxDepth: 1 })
    ).toThrow('depth exceeds');
  });

  it('rejects duplicate bindings for the same child input', () => {
    const [parent, child] = resources();
    expect(() =>
      planQueryFanOut({
        resources: [
          parent,
          patchResource(child, {
            extract: {
              for_each: {
                resource: 'organizations',
                bindings: [
                  { field: 'organization_id', input: 'organization_id', source: 'output' },
                  { field: 'organization_id', input: 'organization_id', source: 'output' },
                ],
              },
            },
          }),
        ],
        target: 'projects',
      })
    ).toThrow('multiple for_each bindings');
  });

  it('validates for_each.where against the shared predicate contract', () => {
    const [baseParent, baseChild] = resources();
    const parent = patchResource(baseParent, {
      output: {
        ...baseParent.output,
        metadata: {
          type: 'object',
          path: '$.metadata',
          properties: { label: { type: 'string', path: '$.label' } },
        },
        observed_at: { type: 'timestamp', path: '$.observed_at' },
      },
    });

    const withWhere = (where: readonly Record<string, unknown>[]) =>
      patchResource(baseChild, {
        extract: {
          for_each: {
            resource: 'organizations',
            field: 'organization_id',
            input: 'organization_id',
            where,
          },
        },
      });

    expect(() =>
      planQueryFanOut({
        resources: [parent, withWhere([{ field: 'metadata', contains: 'active' }])],
        target: 'projects',
      })
    ).toThrow('must reference a scalar output field');
    expect(() =>
      planQueryFanOut({
        resources: [parent, withWhere([{ field: 'observed_at', eq: '-1d' }])],
        target: 'projects',
      })
    ).toThrow('only allowed with comparison operators');
  });

  it('reports root inputs and rejects incomplete bindings, type mismatches, and invalid paths', () => {
    const requiredRoot = makeResource({
      name: 'required_root',
      input: {
        tenant: { type: 'string', required: true },
        root_filter: { type: 'string' },
      },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('tenant'),
    });
    expect(
      planQueryFanOut({ resources: [requiredRoot], target: 'required_root' }).requiredRootInputs
    ).toEqual(['tenant']);

    const parent = resources()[0]!;
    const child = resources()[1]!;
    expect(() =>
      planQueryFanOut({
        resources: [
          parent,
          patchResource(child, {
            extract: {
              for_each: {
                resource: 'organizations',
                field: 'not_an_output',
                input: 'organization_id',
              },
            },
          }),
        ],
        target: 'projects',
      })
    ).toThrow('Incomplete binding');

    expect(() =>
      planQueryFanOut({
        resources: [
          parent,
          patchResource(child, {
            input: { organization_id: { type: 'integer', required: true } },
          }),
        ],
        target: 'projects',
      })
    ).toThrow('Incompatible binding');

    expect(() =>
      planQueryFanOut({
        resources: [
          parent,
          patchResource(child, {
            output: {
              project_id: { type: 'string', path: '$.id' },
              organization_id: {
                type: 'string',
                from: { resource: 'organizations', path: '$.does_not_exist' },
              },
            },
          }),
        ],
        target: 'projects',
      })
    ).toThrow('invalid ancestor path');

    expect(() =>
      planQueryFanOut({
        resources: [
          patchResource(parent, {
            output: { organization_id: { type: 'integer', path: '$.id' } },
          }),
          patchResource(child, {
            input: { organization_id: { type: 'integer', required: true } },
            output: {
              project_id: { type: 'string', path: '$.id' },
              organization_id: {
                type: 'number',
                from: { resource: 'organizations', path: '$.organization_id' },
              },
            },
          }),
        ],
        target: 'projects',
      })
    ).toThrow('type "number" is not compatible');
  });

  it('rejects queryless ancestors and unsupported SQL transports', () => {
    expect(() =>
      planQueryFanOut({
        resources: [patchResource(resources()[0]!, { query: undefined }), resources()[1]!],
        target: 'projects',
      })
    ).toThrow('does not declare query support');

    const sqlIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'warehouse',
      transport: { type: 'sql_postgres' },
    } as unknown as IntegrationSpec;
    expect(() =>
      planQueryFanOut({
        resources: [makeResource({ name: 'items', query: simpleQuery('id_filter') })],
        target: 'items',
        integration: sqlIntegration,
      })
    ).toThrow('unsupported SQL transport');
  });
});

describe('queryResourceFanOut', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not reintroduce defaults for query-bound inputs without preserve_default', async () => {
    const target = makeResource({
      name: 'pages',
      api: {
        endpoint: '/pages',
        method: 'POST',
        request_body: {
          query: '${{ input.search }}',
        },
      },
      input: {
        search: { type: 'string', default: 'must-not-be-sent' },
      },
      output: { id: { type: 'string', path: '$.id' } },
      query: {
        search: {
          dialect: 'provider_search',
          bind: { input: 'search' },
        },
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([{ id: 'page-1' }]));

    await queryResourceFanOut({
      integration: makeProvider(),
      resources: [target],
      target: 'pages',
      mode: 'fan_out',
      limit: 1,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({});
  });

  it('retains an opted-in default for query-bound inputs with preserve_default', async () => {
    const target = makeResource({
      name: 'pages',
      api: {
        endpoint: '/pages',
        method: 'POST',
        request_body: {
          query: '${{ input.search }}',
        },
      },
      input: {
        search: { type: 'string', default: 'default-search' },
      },
      output: { id: { type: 'string', path: '$.id' } },
      query: {
        search: {
          dialect: 'provider_search',
          bind: { input: 'search', preserve_default: true },
        },
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([{ id: 'page-1' }]));

    await queryResourceFanOut({
      integration: makeProvider(),
      resources: [target],
      target: 'pages',
      mode: 'fan_out',
      limit: 1,
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'default-search',
    });
  });

  it('preserves correlated tuples when bindings mix parent input and output', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents/${{ input.tenant }}', method: 'GET' },
      input: {
        tenant: { type: 'string', required: true },
        root_filter: { type: 'string' },
      },
      output: {
        parent_id: { type: 'string', path: '$.parent_id' },
        tenant: { type: 'string', path: '$.tenant' },
      },
      query: simpleQuery('root_filter', 'tenant'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'children',
      api: {
        endpoint: '/children/${{ input.child_tenant }}/${{ input.parent_key }}',
        method: 'GET',
      },
      input: {
        child_tenant: { type: 'string', required: true },
        parent_key: { type: 'string', required: true },
      },
      output: {
        child_id: { type: 'string', path: '$.child_id' },
        tenant: {
          type: 'string',
          from: { resource: 'parents', path: '$.tenant' },
        },
        parent_id: {
          type: 'string',
          from: { resource: 'parents', path: '$.parent_id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: {
          resource: 'parents',
          bindings: [
            { field: 'tenant', input: 'child_tenant', source: 'input' },
            { field: 'parent_id', input: 'parent_key', source: 'output' },
          ],
        },
      },
    });
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/parents/acme') {
        return Response.json([
          { parent_id: 'p1', tenant: 'acme' },
          { parent_id: 'p2', tenant: 'acme' },
        ]);
      }
      if (path === '/children/acme/p1') return Response.json([{ child_id: 'c1' }]);
      if (path === '/children/acme/p2') return Response.json([{ child_id: 'c2' }]);
      throw new Error(`unexpected path ${path}`);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'children',
      mode: 'fan_out',
      input: { tenant: 'acme' },
    });

    expect(paths).toEqual(['/parents/acme', '/children/acme/p1', '/children/acme/p2']);
    expect(result.records).toEqual([
      { child_id: 'c1', tenant: 'acme', parent_id: 'p1' },
      { child_id: 'c2', tenant: 'acme', parent_id: 'p2' },
    ]);
    expect(result.counts).toMatchObject({
      parentWorkItems: 2,
      targetRows: 2,
      resultCount: 2,
      providerAttempts: 3,
      requestCount: 3,
      durationMs: expect.any(Number),
    });
  });

  it('does not issue child requests for empty parents and coalesces duplicate contexts', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(Response.json([]));

    const empty = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });
    expect(empty.records).toEqual([]);
    expect(empty.counts.providerAttempts).toBe(1);

    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(Response.json([{ id: 'org-a' }, { id: 'org-a' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'project-a' }]));
    const duplicate = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(duplicate.records).toEqual([{ project_id: 'project-a', organization_id: 'org-a' }]);
    expect(duplicate.counts.parentWorkItems).toBe(1);
  });

  it('fails closed when for_each.where neq sees a missing parent field', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json([{}]));

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });

    expect(result.records).toEqual([]);
    expect(result.counts.parentWorkItems).toBe(0);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('keeps output ordering deterministic when child responses complete out of order', async () => {
    const [parent, unboundedChild] = resources();
    const child = patchResource(unboundedChild, {
      extract: {
        for_each: {
          resource: 'organizations',
          field: 'organization_id',
          input: 'organization_id',
          concurrency: 3,
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/organizations') {
        return Response.json([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      }
      const id = path.split('/').at(-1);
      await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 20 : id === 'b' ? 1 : 10));
      return Response.json([{ id: `project-${id}` }]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });
    expect(result.records.map((record) => record.project_id)).toEqual([
      'project-a',
      'project-b',
      'project-c',
    ]);
  });

  it('counts every parent and child pagination page in one aggregate request budget', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents', method: 'GET' },
      input: { root_filter: { type: 'string' } },
      output: { parent_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('root_filter', 'parent_id'),
      extract: {
        record_path: '$',
        pagination: { type: 'link_header' },
      },
    });
    const child = makeResource({
      name: 'children',
      api: { endpoint: '/children/${{ input.parent_id }}', method: 'GET' },
      input: { parent_id: { type: 'string', required: true } },
      output: {
        child_id: { type: 'string', path: '$.id' },
        parent_id: { type: 'string', from: { resource: 'parents', path: '$.parent_id' } },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'parents', field: 'parent_id', input: 'parent_id' },
        pagination: { type: 'link_header' },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const requestUrl = new URL(String(url));
      const path = requestUrl.pathname;
      const page = requestUrl.searchParams.get('page');
      if (path === '/parents' && !page) {
        return new Response(JSON.stringify([{ id: 'a' }]), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://api.example.com/parents?page=2>; rel="next"',
          },
        });
      }
      if (path === '/parents' && page === '2') return Response.json([{ id: 'b' }]);
      const parentId = path.split('/').at(-1);
      if (!page) {
        return new Response(JSON.stringify([{ id: `${parentId}-1` }]), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: `<https://api.example.com/children/${parentId}?page=2>; rel="next"`,
          },
        });
      }
      return Response.json([{ id: `${parentId}-2` }]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'children',
      mode: 'fan_out',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(result.counts.providerAttempts).toBe(6);
    expect(result.records).toEqual([
      { child_id: 'a-1', parent_id: 'a' },
      { child_id: 'a-2', parent_id: 'a' },
      { child_id: 'b-1', parent_id: 'b' },
      { child_id: 'b-2', parent_id: 'b' },
    ]);
  });

  it('stops flat target pagination at the requested row limit', async () => {
    const target = makeResource({
      name: 'items',
      api: { endpoint: '/items', method: 'GET' },
      output: { id: { type: 'string', path: '$.id' } },
      extract: { record_path: '$', pagination: { type: 'link_header' } },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ id: 'one' }, { id: 'two' }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://api.example.com/items?page=2>; rel="next"',
        },
      })
    );

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [target],
      target: 'items',
      mode: 'fan_out',
      limit: 1,
    });

    expect(result.records).toEqual([{ id: 'one' }]);
    expect(result.limitReached).toBe(true);
    expect(result.counts.providerAttempts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('short-circuits target fan-out once the requested target rows are returned', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents', method: 'GET' },
      input: { root_filter: { type: 'string' } },
      output: { parent_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('root_filter', 'parent_id'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'children',
      api: { endpoint: '/children/${{ input.parent_id }}', method: 'GET' },
      input: { parent_id: { type: 'string', required: true } },
      output: { child_id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: { resource: 'parents', field: 'parent_id', input: 'parent_id' },
      },
    });
    const parents = Array.from({ length: 150 }, (_, index) => ({ id: `parent-${index}` }));
    const childIds: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/parents') return Response.json(parents);
      const parentId = path.split('/').at(-1)!;
      childIds.push(parentId);
      return Response.json([{ id: `child-${parentId}` }]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'children',
      mode: 'fan_out',
      limit: 10,
    });

    expect(result.records).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ child_id: `child-parent-${index}` }))
    );
    expect(result.limitReached).toBe(true);
    expect(childIds).toEqual(Array.from({ length: 10 }, (_, index) => `parent-${index}`));
    expect(result.counts).toMatchObject({
      parentWorkItems: 10,
      targetRows: 10,
      providerAttempts: 11,
      requestCount: 11,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(11);
  });

  it('uses aggregate budgets instead of the flat 50-page cap for limited ancestors', async () => {
    const [unpagedParent, child] = resources();
    const parent = patchResource(unpagedParent, {
      extract: { pagination: { type: 'link_header' } },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/organizations') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return new Response(JSON.stringify([{ id: page === 51 ? 'full' : `empty-${page}` }]), {
          headers: {
            'content-type': 'application/json',
            ...(page < 51
              ? {
                  link: `<https://api.example.com/organizations?page=${page + 1}>; rel="next"`,
                }
              : {}),
          },
        });
      }
      return url.pathname === '/projects/full'
        ? Response.json([{ id: 'target' }])
        : Response.json([]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
      limit: 1,
      limits: { maxProviderAttempts: 200 },
    });

    expect(result.records).toEqual([{ project_id: 'target', organization_id: 'full' }]);
    expect(result.counts).toMatchObject({
      providerAttempts: 102,
      requestCount: 102,
      parentWorkItems: 51,
      targetRows: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(102);
  });

  it('fails explicitly when the target limit is unsatisfied at the parent-work boundary', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents', method: 'GET' },
      input: { root_filter: { type: 'string' } },
      output: { parent_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('root_filter', 'parent_id'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'children',
      api: { endpoint: '/children/${{ input.parent_id }}', method: 'GET' },
      input: { parent_id: { type: 'string', required: true } },
      output: { child_id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: { resource: 'parents', field: 'parent_id', input: 'parent_id' },
      },
    });
    const parents = Array.from({ length: 101 }, (_, index) => ({ id: `parent-${index}` }));
    const childIds: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/parents') return Response.json(parents);
      childIds.push(path.split('/').at(-1)!);
      return Response.json([]);
    });

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'children',
        mode: 'fan_out',
        limit: 1,
        limits: { maxProviderAttempts: 200 },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_PARENT_LIMIT',
      phase: 'limit',
      resource: 'children',
      parentResource: 'parents',
      counts: { parentWorkItems: 101 },
    });
    expect(childIds).toHaveLength(100);
    expect(childIds).not.toContain('parent-100');
    expect(fetchSpy).toHaveBeenCalledTimes(101);
  });

  it('allows an exactly exhausted parent budget when the graph has no more work', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents', method: 'GET' },
      input: { root_filter: { type: 'string' } },
      output: { parent_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('root_filter', 'parent_id'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'children',
      api: { endpoint: '/children/${{ input.parent_id }}', method: 'GET' },
      input: { parent_id: { type: 'string', required: true } },
      output: { child_id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: { resource: 'parents', field: 'parent_id', input: 'parent_id' },
      },
    });
    const parents = Array.from({ length: 100 }, (_, index) => ({ id: `parent-${index}` }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/parents') return Response.json(parents);
      return Response.json([]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'children',
      mode: 'fan_out',
      limit: 1,
      limits: { maxProviderAttempts: 200 },
    });

    expect(result.records).toEqual([]);
    expect(result.counts.parentWorkItems).toBe(100);
    expect(fetchSpy).toHaveBeenCalledTimes(101);
  });

  it('short-circuits a multi-hop target fan-out before enumerating later ancestors', async () => {
    const root = makeResource({
      name: 'roots',
      api: { endpoint: '/roots', method: 'GET' },
      input: { root_filter: { type: 'string' } },
      output: { intermediate_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('root_filter', 'intermediate_id'),
      extract: { record_path: '$' },
    });
    const intermediate = makeResource({
      name: 'intermediates',
      api: { endpoint: '/intermediates/${{ input.intermediate_id }}', method: 'GET' },
      input: { intermediate_id: { type: 'string', required: true } },
      output: { intermediate_id: { type: 'string', path: '$.id' } },
      query: simpleQuery('intermediate_filter', 'intermediate_id'),
      extract: {
        record_path: '$',
        for_each: {
          resource: 'roots',
          field: 'intermediate_id',
          input: 'intermediate_id',
        },
      },
    });
    const target = makeResource({
      name: 'targets',
      api: { endpoint: '/targets/${{ input.intermediate_id }}', method: 'GET' },
      input: { intermediate_id: { type: 'string', required: true } },
      output: { target_id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: {
          resource: 'intermediates',
          field: 'intermediate_id',
          input: 'intermediate_id',
        },
      },
    });
    const paths: string[] = [];
    const roots = Array.from({ length: 150 }, (_, index) => ({ id: `root-${index}` }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/roots') return Response.json(roots);
      if (path === '/intermediates/root-0') return Response.json([{ id: 'intermediate-0' }]);
      if (path === '/targets/intermediate-0') return Response.json([{ id: 'target-0' }]);
      throw new Error(`unexpected path ${path}`);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [root, intermediate, target],
      target: 'targets',
      mode: 'fan_out',
      limit: 1,
    });

    expect(result.records).toEqual([{ target_id: 'target-0' }]);
    expect(result.limitReached).toBe(true);
    expect(paths).toEqual(['/roots', '/intermediates/root-0', '/targets/intermediate-0']);
    expect(result.counts).toMatchObject({
      parentWorkItems: 2,
      targetRows: 1,
      providerAttempts: 3,
      requestCount: 3,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('streams intermediate pages and stops their pagination when target demand is met', async () => {
    const [root, intermediate, target] = resources();
    const paginatedIntermediate = patchResource(intermediate, {
      extract: { pagination: { type: 'link_header' } },
    });
    const paths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/organizations') return Response.json([{ id: 'org-a' }]);
      if (url.pathname === '/projects/org-a' && !url.search) {
        return new Response(JSON.stringify([{ id: 'empty' }]), {
          headers: {
            'content-type': 'application/json',
            link: '<https://api.example.com/projects/org-a?page=2>; rel="next"',
          },
        });
      }
      if (url.pathname === '/projects/org-a' && url.search === '?page=2') {
        return new Response(JSON.stringify([{ id: 'full' }, { id: 'unused' }]), {
          headers: {
            'content-type': 'application/json',
            link: '<https://api.example.com/projects/org-a?page=3>; rel="next"',
          },
        });
      }
      if (url.pathname === '/events/org-a/empty') return Response.json([]);
      if (url.pathname === '/events/org-a/full') {
        return Response.json(Array.from({ length: 10 }, (_, index) => ({ id: `target-${index}` })));
      }
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [root, paginatedIntermediate, target],
      target: 'events',
      mode: 'fan_out',
      limit: 10,
    });

    expect(result.records).toHaveLength(10);
    expect(result.limitReached).toBe(true);
    expect(paths).toEqual([
      '/organizations',
      '/projects/org-a',
      '/events/org-a/empty',
      '/projects/org-a?page=2',
      '/events/org-a/full',
    ]);
    expect(paths).not.toContain('/projects/org-a?page=3');
    expect(paths).not.toContain('/events/org-a/unused');
    expect(result.counts).toMatchObject({
      providerAttempts: 5,
      requestCount: 5,
      targetRows: 10,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('rejects stale plans when a target Resource definition changes', async () => {
    const target = makeResource({
      name: 'items',
      api: { endpoint: '/items', method: 'GET' },
      extract: { record_path: '$' },
    });
    const plan = planQueryFanOut({ resources: [target], target: 'items' });
    const changed = patchResource(target, {
      api: { endpoint: '/different-items', method: 'GET' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [changed],
        target: 'items',
        mode: 'fan_out',
        plan,
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_PLAN_MISMATCH', phase: 'plan' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts retries together with parent and child requests', async () => {
    const [parent, child] = resources().slice(0, 2);
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      requests += 1;
      const path = new URL(String(url)).pathname;
      if (path === '/organizations' && requests === 1) {
        return new Response('{"message":"temporary"}', {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      if (path === '/organizations') return Response.json([{ id: 'org-a' }]);
      return Response.json([{ id: 'project-a' }]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider('https://api.example.com', {
        retry: {
          retry_on: [503],
          max_retries: 1,
          backoff: 'fixed',
          retry_after_header: true,
        },
      }),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });

    expect(result.records).toEqual([{ project_id: 'project-a', organization_id: 'org-a' }]);
    expect(requests).toBe(3);
    expect(result.counts.providerAttempts).toBe(3);
  });

  it('fails closed when the aggregate parent-work budget is exceeded', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([{ id: 'a' }, { id: 'b' }]));

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
        limits: { maxParentWorkItems: 1 },
        correlationId: 'budget-parent-limit',
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_PARENT_LIMIT',
      phase: 'limit',
      correlationId: 'budget-parent-limit',
      counts: { parentWorkItems: 2 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails closed when target rows or mapped bytes exceed aggregate budgets', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'a' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'one' }, { id: 'two' }]));

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limits: { maxTargetRows: 1 },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_RESULT_LIMIT',
      phase: 'limit',
      counts: { targetRows: 2 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(Response.json([{ id: 'a' }]));
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limits: { maxMappedBytes: 1 },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_RESULT_LIMIT',
      phase: 'limit',
      counts: { mappedBytes: expect.any(Number) },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('counts provider attempts before making a request and enforces concurrency', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([{ id: 'a' }]));
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
        limits: { maxProviderAttempts: 1 },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_REQUEST_LIMIT',
      phase: 'limit',
      counts: { providerAttempts: 2 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const concurrentChild = patchResource(child, {
      extract: {
        for_each: {
          resource: 'organizations',
          field: 'organization_id',
          input: 'organization_id',
          concurrency: 64,
        },
      },
    });
    let active = 0;
    let peak = 0;
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/organizations') return Response.json([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json([{ id: `project-${path.split('/').at(-1)}` }]);
    });
    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, concurrentChild],
      target: 'projects',
      mode: 'fan_out',
      limits: { maxConcurrency: 2 },
    });
    expect(peak).toBe(2);
    expect(result.counts.maxConcurrency).toBe(2);
    expect(result.records).toHaveLength(3);
  });

  it('counts authentication-provider requests in the aggregate attempt budget', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ access_token: 'short-lived-token' }));
    const integration = makeProvider('https://api.example.com', {
      auth: {
        type: 'custom-token',
        token_url: 'https://auth.example.com/token',
        token_ttl_seconds: 0,
      },
      retry: { retry_on: [], max_retries: 0 },
    });

    await expect(
      queryResourceFanOut({
        integration,
        resources: [resources()[0]!],
        target: 'organizations',
        mode: 'targeted',
        limits: { maxProviderAttempts: 1 },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_REQUEST_LIMIT',
      phase: 'limit',
      counts: { providerAttempts: 2 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares one transport rate limiter across sibling work items', async () => {
    const [parent, child] = resources();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      return path === '/organizations'
        ? Response.json([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
        : Response.json([{ id: `project-${path.split('/').at(-1)}` }]);
    });
    const acquireSpy = vi.spyOn(RateLimiter.prototype, 'acquire');

    await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });

    expect(acquireSpy).toHaveBeenCalledTimes(4);
    expect(new Set(acquireSpy.mock.instances).size).toBe(1);
  });

  it('returns typed deadline and caller-cancellation failures without partial success', async () => {
    const [parent, child] = resources();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json([{ id: 'late' }])), 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    });

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
        limits: { deadlineMs: 20 },
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_DEADLINE', phase: 'limit', kind: 'timeout' });
    // The deadline starts before planning and preflight. Under full-suite
    // scheduler load it may expire before the first provider attempt, which
    // is still the same typed deadline failure and must not become a partial
    // success. If the request starts first, the in-flight fetch is aborted.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);

    fetchSpy.mockClear();
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_CANCELLED', phase: 'cancelled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancels an in-flight parent page during bounded traversal without later requests', async () => {
    const [unpagedParent, child] = resources();
    const parent = patchResource(unpagedParent, {
      extract: { pagination: { type: 'link_header' } },
    });
    const controller = new AbortController();
    const paths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/organizations' && !url.search) {
        return new Response(JSON.stringify([{ id: 'empty' }]), {
          headers: {
            'content-type': 'application/json',
            link: '<https://api.example.com/organizations?page=2>; rel="next"',
          },
        });
      }
      if (url.pathname === '/projects/empty') return Response.json([]);
      if (url.pathname === '/organizations' && url.search === '?page=2') {
        controller.abort(new Error('cancel paginated parent'));
        throw init?.signal?.reason;
      }
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_CANCELLED', phase: 'cancelled' });
    expect(paths).toEqual(['/organizations', '/projects/empty', '/organizations?page=2']);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('cancels an in-flight child during bounded traversal without visiting later parents', async () => {
    const [parent, child] = resources();
    const controller = new AbortController();
    const paths: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/organizations') {
        return Response.json([{ id: 'first' }, { id: 'unused' }]);
      }
      if (path === '/projects/first') {
        controller.abort(new Error('cancel child'));
        throw init?.signal?.reason;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_CANCELLED', phase: 'cancelled' });
    expect(paths).toEqual(['/organizations', '/projects/first']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('redacts bounded diagnostics when the streamed parent request fails', async () => {
    const [parent, child] = resources();
    const token = 'streamed-parent-secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: `${token} useful parent detail` }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    );

    const error = await queryResourceFanOut({
      integration: makeProvider('https://api.example.com', {
        auth: { type: 'bearer', token },
        retry: { retry_on: [], max_retries: 0 },
      }),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
      limit: 10,
    }).catch((value: unknown) => value as QueryFanOutError);

    expect(error).toMatchObject({
      code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
      kind: 'provider',
      phase: 'parent',
      resource: 'organizations',
      counts: { providerAttempts: 1 },
    });
    expect(error.providerMessage).toContain('useful parent detail');
    expect(error.providerMessage).not.toContain(token);
    expect(error.providerMessage?.length).toBeLessThan(900);
  });

  it.each([400, 404, 429, 503])(
    'fails closed for child HTTP %s with bounded provider diagnostics',
    async (status) => {
      const [parent, child] = resources();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json([{ id: 'org-a' }]))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              message: `secret-token ${'provider detail '.repeat(100)}`,
            }),
            {
              status,
              headers: { 'content-type': 'application/json' },
            }
          )
        );

      const error = await queryResourceFanOut({
        integration: makeProvider('https://api.example.com', {
          auth: { type: 'bearer', token: 'secret-token' },
          retry: { retry_on: [], max_retries: 0 },
        }),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        limit: 10,
      }).catch((value: unknown) => value as QueryFanOutError);

      expect(error).toMatchObject({
        code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
        kind: 'provider',
        phase: 'child',
        target: 'projects',
        resource: 'projects',
        parentResource: 'organizations',
        parentOrdinal: 0,
        providerStatus: status,
        counts: { parentWorkItems: 1, providerAttempts: 2 },
      });
      expect(error.retryable).toBe(status === 429 || status >= 500);
      expect(error.providerMessage).toContain('provider detail');
      expect(error.providerMessage).not.toContain('secret-token');
      expect(error.providerMessage?.length).toBeLessThan(900);
      expect(error.providerCause?.cause?.status).toBe(status);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it('pre-authorizes every billable graph Resource before making any request', async () => {
    const [parent, child] = resources();
    const billing = {
      mode: 'billable' as const,
      ownership: 'third_party' as const,
      unit: 'request' as const,
      estimation: {
        model: 'per_request' as const,
        amount: 1,
        currency: 'provider_credit',
      },
      authorization: { requires_plan: true as const },
    };
    const billableParent = patchResource(parent, { billing });
    const billableChild = patchResource(child, { billing });
    const authorizeBillable = vi.fn().mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [billableParent, billableChild],
        target: 'projects',
        mode: 'fan_out',
        authorizeBillable,
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_BILLING_DENIED',
      phase: 'plan',
      resource: 'organizations',
    });
    expect(authorizeBillable).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    authorizeBillable.mockReset();
    authorizeBillable.mockResolvedValue(true);
    fetchSpy
      .mockResolvedValueOnce(Response.json([{ id: 'org-a' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'project-a' }]));
    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [billableParent, billableChild],
      target: 'projects',
      mode: 'fan_out',
      authorizeBillable,
    });
    expect(authorizeBillable).toHaveBeenCalledTimes(2);
    expect(result.records).toEqual([{ project_id: 'project-a', organization_id: 'org-a' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('applies cancellation and deadlines to billable authorization', async () => {
    const target = patchResource(resources()[0]!, {
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'request',
        estimation: { model: 'per_request', amount: 1, currency: 'provider_credit' },
        authorization: { requires_plan: true },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [target],
        target: 'organizations',
        mode: 'targeted',
        limits: { deadlineMs: 20 },
        authorizeBillable: async () => await new Promise<boolean>(() => undefined),
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_DEADLINE', kind: 'timeout', phase: 'limit' });
    expect(fetchSpy).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = queryResourceFanOut({
      integration: makeProvider(),
      resources: [target],
      target: 'organizations',
      mode: 'targeted',
      signal: controller.signal,
      authorizeBillable: async () => await new Promise<boolean>(() => undefined),
    });
    controller.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(cancelled).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_CANCELLED',
      kind: 'cancellation',
      phase: 'cancelled',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('executes a supported MCP Resource through the same bounded query API', async () => {
    const connectSpy = vi
      .spyOn(McpExtractorClient.prototype, 'connect')
      .mockResolvedValue(undefined);
    const pages = [
      { items: [{ id: '1', name: 'alpha' }], pageInfo: { endCursor: '1' } },
      { items: [{ id: '2', name: 'beta' }], pageInfo: { endCursor: '2' } },
      { items: [{ id: '3', name: 'gamma' }], pageInfo: { endCursor: null } },
    ];
    const callToolSpy = vi
      .spyOn(McpExtractorClient.prototype, 'callTool')
      .mockImplementation(async (options) => {
        options.beforeRequestAttempt?.();
        return pages.shift() ?? { items: [], pageInfo: { endCursor: null } };
      });
    const result = await queryResourceFanOut({
      integration: makeMcpIntegration(),
      resources: [makeMcpListResource()],
      target: 'items',
      mode: 'targeted',
    });

    expect(result.records).toEqual([
      { id: '1', name: 'alpha' },
      { id: '2', name: 'beta' },
      { id: '3', name: 'gamma' },
    ]);
    expect(result.counts.providerAttempts).toBe(3);
    expect(result.plan.topologicalOrder).toEqual(['items']);
    expect(connectSpy).toHaveBeenCalledOnce();
    expect(callToolSpy).toHaveBeenCalledTimes(3);
  });

  it('does not speculatively prefetch an MCP cursor page past a target limit', async () => {
    vi.spyOn(McpExtractorClient.prototype, 'connect').mockResolvedValue(undefined);
    const callToolSpy = vi
      .spyOn(McpExtractorClient.prototype, 'callTool')
      .mockImplementation(async (options) => {
        options.beforeRequestAttempt?.();
        return { items: [{ id: '1', name: 'alpha' }], pageInfo: { endCursor: 'next' } };
      });

    const result = await queryResourceFanOut({
      integration: makeMcpIntegration(),
      resources: [makeMcpListResource()],
      target: 'items',
      mode: 'targeted',
      limit: 1,
    });

    expect(result.limitReached).toBe(true);
    expect(result.counts.providerAttempts).toBe(1);
    expect(callToolSpy).toHaveBeenCalledOnce();
  });

  it('redacts environment-backed MCP credentials from public errors', async () => {
    const token = 'fanout-environment-secret';
    process.env['FANOUT_MCP_TOKEN'] = token;
    const integration = {
      ...makeMcpIntegration(),
      transport: {
        type: 'mcp_http',
        url: 'https://mcp.example.com/${{ env.FANOUT_MCP_TOKEN }}',
        retry: { max_retries: 0 },
      },
    } as IntegrationSpec;
    vi.spyOn(McpExtractorClient.prototype, 'connect').mockResolvedValue(undefined);
    const providerCause = new Error(`Authorization: Bearer ${token} ${'detail '.repeat(500)}`);
    vi.spyOn(McpExtractorClient.prototype, 'callTool').mockRejectedValue(providerCause);

    try {
      const error = await queryResourceFanOut({
        integration,
        resources: [makeMcpListResource()],
        target: 'items',
        mode: 'targeted',
      }).catch((value: unknown) => value as QueryFanOutError);

      expect(error.providerMessage).toContain('[REDACTED]');
      expect(error.providerMessage).not.toContain(token);
      expect(error.providerMessage?.length).toBeLessThanOrEqual(2_048);
      expect(error.cause).toBe(providerCause);
      expect((error.cause as Error | undefined)?.message).not.toContain(token);
    } finally {
      delete process.env['FANOUT_MCP_TOKEN'];
    }
  });

  it('redacts resolved MCP tool argument secrets from public errors', async () => {
    const token = 'fanout-tool-argument-secret';
    process.env['FANOUT_TOOL_ARGUMENT_SECRET'] = token;
    const resource = {
      ...makeMcpListResource(),
      tool: {
        tool_name: 'list_items',
        arguments: { credential: '${{ env.FANOUT_TOOL_ARGUMENT_SECRET }}' },
      },
    } as ResourceSpec;
    const providerCause = new Error(`provider echoed ${token}`);
    vi.spyOn(McpExtractorClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'callTool').mockRejectedValue(providerCause);

    try {
      const error = await queryResourceFanOut({
        integration: { ...makeMcpIntegration(), auth_env_vars: ['FANOUT_TOOL_ARGUMENT_SECRET'] },
        resources: [resource],
        target: 'items',
        mode: 'targeted',
      }).catch((value: unknown) => value as QueryFanOutError);

      expect(error.providerMessage).toContain('[REDACTED]');
      expect(error.providerMessage).not.toContain(token);
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).not.toContain(token);
    } finally {
      delete process.env['FANOUT_TOOL_ARGUMENT_SECRET'];
    }
  });

  it('plans and executes a deterministic three-level correlated fan-out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/organizations') {
        return Response.json([{ id: 'org-a' }, { id: 'skip' }, { id: 'org-b' }]);
      }
      if (path === '/projects/org-a') return Response.json([{ id: 'project-a' }]);
      if (path === '/projects/org-b') return Response.json([{ id: 'project-b' }]);
      if (path === '/events/org-a/project-a') return Response.json([{ id: 'event-a' }]);
      if (path === '/events/org-b/project-b') return Response.json([{ id: 'event-b' }]);
      throw new Error(`unexpected path ${path}`);
    });
    const plan = planQueryFanOut({ resources: resources(), target: 'events' });
    expect(plan).toMatchObject({
      contractVersion: 1,
      topologicalOrder: ['organizations', 'projects', 'events'],
    });
    expect(plan.edges[1]?.bindings).toEqual([
      { field: 'organization_id', input: 'organization_id', source: 'output' },
      { field: 'project_id', input: 'project_id', source: 'output' },
    ]);

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: resources(),
      target: 'events',
      mode: 'fan_out',
    });
    expect(result.records).toEqual([
      { event_id: 'event-a', organization_id: 'org-a', project_id: 'project-a' },
      { event_id: 'event-b', organization_id: 'org-b', project_id: 'project-b' },
    ]);
    expect(result.counts.providerAttempts).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('retains distinct deep ancestor contexts when an intermediate binding matches', async () => {
    const root = makeResource({
      name: 'roots',
      api: { endpoint: '/roots', method: 'GET' },
      output: {
        intermediate_id: { type: 'string', path: '$.intermediate_id' },
        root_context: { type: 'string', path: '$.root_context' },
      },
      query: simpleQuery('root_filter', 'root_context'),
      extract: { record_path: '$' },
    });
    const intermediate = makeResource({
      name: 'intermediates',
      api: { endpoint: '/intermediates/${{ input.intermediate_id }}', method: 'GET' },
      input: { intermediate_id: { type: 'string', required: true } },
      output: { intermediate_id: { type: 'string', path: '$.intermediate_id' } },
      query: simpleQuery('intermediate_filter', 'intermediate_id'),
      extract: {
        record_path: '$',
        for_each: {
          resource: 'roots',
          field: 'intermediate_id',
          input: 'intermediate_id',
        },
      },
    });
    const target = makeResource({
      name: 'targets',
      api: { endpoint: '/targets/${{ input.intermediate_id }}', method: 'GET' },
      input: { intermediate_id: { type: 'string', required: true } },
      output: {
        target_id: { type: 'string', path: '$.target_id' },
        root_context: { type: 'string', from: { resource: 'roots', path: '$.root_context' } },
        intermediate_id: {
          type: 'string',
          from: { resource: 'intermediates', path: '$.intermediate_id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: {
          resource: 'intermediates',
          field: 'intermediate_id',
          input: 'intermediate_id',
        },
      },
    });
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/roots') {
        return Response.json([
          { intermediate_id: 'same', root_context: 'ctx-a' },
          { intermediate_id: 'same', root_context: 'ctx-b' },
        ]);
      }
      if (path === '/intermediates/same') {
        return Response.json([{ intermediate_id: 'same' }]);
      }
      if (path === '/targets/same') return Response.json([{ target_id: 'target' }]);
      throw new Error(`unexpected path ${path}`);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [root, intermediate, target],
      target: 'targets',
      mode: 'fan_out',
      limit: 2,
    });

    expect(paths).toEqual([
      '/roots',
      '/intermediates/same',
      '/targets/same',
      '/intermediates/same',
      '/targets/same',
    ]);
    expect(result.records).toEqual([
      { target_id: 'target', root_context: 'ctx-a', intermediate_id: 'same' },
      { target_id: 'target', root_context: 'ctx-b', intermediate_id: 'same' },
    ]);
  });

  it('targets a direct child without calling any ancestors', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([{ id: 'event-a' }]));
    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: resources(),
      target: 'projects',
      mode: 'targeted',
      input: { organization_id: 'org-a' },
    });
    expect(result.records).toEqual([{ project_id: 'event-a', organization_id: 'org-a' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('targets a single root with a required query-bound input', async () => {
    const root = makeResource({
      name: 'tenant_items',
      api: { endpoint: '/tenants/${{ input.tenant }}/items', method: 'GET' },
      input: { tenant: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('tenant'),
      extract: { record_path: '$' },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'item-a' }]));

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [root],
      target: 'tenant_items',
      mode: 'targeted',
      input: { tenant: 'tenant-a' },
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe('/tenants/tenant-a/items');
    expect(result.records).toEqual([{ id: 'item-a' }]);
  });

  it('preserves correlation IDs on execution-time planning failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [],
        target: 'missing',
        mode: 'targeted',
        correlationId: 'corr-plan',
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_INVALID_PLAN',
      phase: 'plan',
      correlationId: 'corr-plan',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects missing targeted inputs before provider access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: resources(),
        target: 'projects',
        mode: 'targeted',
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_MISSING_INPUT', phase: 'plan' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects missing root inputs before fan-out provider access', async () => {
    const root = makeResource({
      name: 'required_root',
      api: { endpoint: '/roots/${{ input.tenant }}', method: 'GET' },
      input: { tenant: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('tenant'),
      extract: { record_path: '$' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [root],
        target: 'required_root',
        mode: 'fan_out',
      })
    ).rejects.toMatchObject({ code: 'QUERY_FAN_OUT_MISSING_INPUT', phase: 'plan' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('admits required root inputs that are also bound by the root query', async () => {
    const root = makeResource({
      name: 'required_root',
      api: { endpoint: '/roots/${{ input.tenant }}', method: 'GET' },
      input: { tenant: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('tenant'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'root_children',
      api: { endpoint: '/children/${{ input.root_id }}', method: 'GET' },
      input: { root_id: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: { resource: 'required_root', field: 'id', input: 'root_id' },
      },
    });
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path.startsWith('/roots/')
        ? Response.json([{ id: 'root-a' }])
        : Response.json([{ id: 'child-a' }]);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [root, child],
      target: 'root_children',
      mode: 'fan_out',
      input: { tenant: 'tenant-a' },
    });

    expect(paths).toEqual(['/roots/tenant-a', '/children/root-a']);
    expect(result.records).toEqual([{ id: 'child-a' }]);
  });

  it('rejects an unavailable parent-input binding before provider access', async () => {
    const parent = makeResource({
      name: 'parents',
      api: { endpoint: '/parents', method: 'GET' },
      input: { tenant: { type: 'string' } },
      output: { id: { type: 'string', path: '$.id' } },
      query: simpleQuery('tenant'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'children',
      api: { endpoint: '/children/${{ input.tenant }}', method: 'GET' },
      input: { tenant: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$',
        for_each: {
          resource: 'parents',
          bindings: [{ field: 'tenant', input: 'tenant', source: 'input' }],
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'children',
        mode: 'fan_out',
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_MISSING_INPUT',
      phase: 'plan',
      parentResource: 'parents',
      binding: { field: 'tenant', input: 'tenant', source: 'input' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves host inputs declared only by a child Resource', async () => {
    const [parent, baseChild] = resources();
    const child = patchResource(baseChild, {
      api: {
        endpoint: '/projects/${{ input.organization_id }}/${{ input.region }}',
        method: 'GET',
      },
      input: {
        ...baseChild.input,
        region: { type: 'string', required: true },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/organizations') return Response.json([{ id: 'org-a' }]);
      if (path === '/projects/org-a/eu') return Response.json([{ id: 'project-a' }]);
      throw new Error(`unexpected path ${path}`);
    });

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
      input: { region: 'eu' },
    });

    expect(result.records).toEqual([{ project_id: 'project-a', organization_id: 'org-a' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects filters that would overwrite a correlated target binding', async () => {
    const [parent, baseChild] = resources();
    const child = patchResource(baseChild, {
      query: {
        filters: {
          organization_id: {
            operators: ['eq'],
            bind: { eq: { input: 'organization_id' } },
          },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [parent, child],
        target: 'projects',
        mode: 'fan_out',
        filter: { organization_id: 'different-org' },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_BINDING_OVERRIDE',
      phase: 'plan',
      binding: { field: 'organization_id', input: 'organization_id', source: 'output' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows an edge destination that is also declared as a child query binding', async () => {
    const [parent, baseChild] = resources();
    const child = patchResource(baseChild, {
      query: simpleQuery('organization_id', 'organization_id'),
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'org-a' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'project-a' }]));

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
    });

    expect(result.records).toEqual([{ project_id: 'project-a', organization_id: 'org-a' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('executes a supplied plan with its explicit planner concurrency policy', async () => {
    const [parent, child] = resources();
    const plan = planQueryFanOut({
      resources: [parent, child],
      target: 'projects',
      maxConcurrency: 1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'org-a' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'project-a' }]));

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'projects',
      mode: 'fan_out',
      plan,
    });

    expect(result.plan).toEqual(plan);
    expect(result.counts.maxConcurrency).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects limits above the public safety caps before provider access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: [resources()[0]!],
        target: 'organizations',
        mode: 'fan_out',
        limits: { maxConcurrency: 65 },
      })
    ).rejects.toMatchObject({ kind: 'validation', phase: 'plan' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a structured plan failure for a malformed transport object', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const integration = { ...makeProvider(), transport: {} } as unknown as IntegrationSpec;

    await expect(
      queryResourceFanOut({
        integration,
        resources: [resources()[0]!],
        target: 'organizations',
        mode: 'targeted',
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_UNSUPPORTED_TRANSPORT',
      phase: 'plan',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unprovable nested targeted context before provider access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: resources(),
        target: 'events',
        mode: 'targeted',
        input: { organization_id: 'org-a', project_id: 'project-a' },
      })
    ).rejects.toMatchObject({
      code: 'QUERY_FAN_OUT_CONFIG_FAILURE',
      kind: 'validation',
      phase: 'child',
      resource: 'events',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reconstructs provable nested targeted context from a bound parent output', async () => {
    const parent = makeResource({
      name: 'accounts',
      output: {
        owner: {
          type: 'object',
          path: '$.owner',
          properties: { id: { type: 'string', path: '$.id' } },
        },
      },
      query: simpleQuery('account_filter'),
      extract: { record_path: '$' },
    });
    const child = makeResource({
      name: 'items',
      api: { endpoint: '/items', method: 'GET' },
      input: {
        owner: {
          type: 'object',
          required: true,
          properties: { id: { type: 'string', required: true } },
        },
      },
      output: {
        item_id: { type: 'string', path: '$.id' },
        owner_id: { type: 'string', from: { resource: 'accounts', path: '$.owner.id' } },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'accounts', field: 'owner', input: 'owner' },
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json([{ id: 'item-a' }]));

    const result = await queryResourceFanOut({
      integration: makeProvider(),
      resources: [parent, child],
      target: 'items',
      mode: 'targeted',
      input: { owner: { id: 'owner-a' } },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.records).toEqual([{ item_id: 'item-a', owner_id: 'owner-a' }]);
  });

  it('fails closed for a null parent binding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([{ id: null }]));
    await expect(
      queryResourceFanOut({
        integration: makeProvider(),
        resources: resources(),
        target: 'events',
        mode: 'fan_out',
      })
    ).rejects.toBeInstanceOf(QueryFanOutError);
  });
});
