import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/runtime/mcp-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/mcp-transport.js')>();
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  return {
    ...actual,
    createStdioTransport: (
      transport: Parameters<typeof actual.createStdioTransport>[0],
      resolvedEnv: Parameters<typeof actual.createStdioTransport>[1]
    ) =>
      transport.command === 'node'
        ? new StdioClientTransport({
            command: transport.command,
            args: transport.args ?? [],
            env: resolvedEnv,
            stderr: 'pipe',
          })
        : actual.createStdioTransport(transport, resolvedEnv),
  };
});

import { ResourceSpecSchema } from '../../src/schemas/resource.js';
import {
  mergeResourceInputs,
  parseResourceInputsJson,
} from '../../src/commands/resource-inputs.js';
import { queryResource } from '../../src/runtime/query/index.js';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';
import { makeProvider, makeResource } from '../helpers/fixtures.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mcp/test-server.mjs', import.meta.url));

function makeQueryableResource(overrides: Record<string, unknown> = {}): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        state: '${{ input.state }}',
        since: '${{ input.since }}',
        per_page: '${{ input.per_page }}',
      },
    },
    input: {
      state: {
        type: 'string',
        default: 'open',
        enum: ['open', 'closed', 'all'],
      },
      since: {
        type: 'string',
      },
      per_page: {
        type: 'integer',
        default: 100,
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      state: { type: 'string', path: '$.state' },
      updated_at: { type: 'timestamp', path: '$.updated_at' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        state: {
          operators: ['eq'],
          enum: ['open', 'closed'],
          bind: {
            eq: { input: 'state' },
          },
        },
        updated_at: {
          operators: ['gte'],
          bind: {
            gte: { input: 'since' },
          },
        },
      },
    },
    ...overrides,
  });
}

function makeScalarOperatorResource(overrides: Record<string, unknown> = {}): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        status_ne: '${{ input.status_ne }}',
        rank_lt: '${{ input.rank_lt }}',
        score_gt: '${{ input.score_gt }}',
        archived_not: '${{ input.archived_not }}',
      },
    },
    input: {
      status_ne: {
        type: 'string',
      },
      rank_lt: {
        type: 'integer',
      },
      score_gt: {
        type: 'number',
      },
      archived_not: {
        type: 'boolean',
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      status: { type: 'string', path: '$.status' },
      rank: { type: 'integer', path: '$.rank' },
      score: { type: 'number', path: '$.score' },
      archived: { type: 'boolean', path: '$.archived' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        status: {
          operators: ['ne'],
          enum: ['open', 'closed'],
          bind: {
            ne: { input: 'status_ne' },
          },
        },
        rank: {
          operators: ['lt'],
          bind: {
            lt: { input: 'rank_lt' },
          },
        },
        score: {
          operators: ['gt'],
          bind: {
            gt: { input: 'score_gt' },
          },
        },
        archived: {
          operators: ['not'],
          bind: {
            not: { input: 'archived_not' },
          },
        },
      },
    },
    ...overrides,
  });
}

function makeInOperatorResource(overrides: Record<string, unknown> = {}): ResourceSpec {
  return makeResource({
    name: 'issues',
    api: {
      endpoint: '/issues',
      method: 'GET',
      query_params: {
        state_in: '${{ input.states }}',
      },
    },
    input: {
      states: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
        },
      },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      state: { type: 'string', path: '$.state' },
    },
    extract: {
      record_path: '$',
    },
    query: {
      filters: {
        state: {
          operators: ['in'],
          enum: ['open', 'closed', 'pending'],
          bind: {
            in: { input: 'states' },
          },
        },
      },
    },
    ...overrides,
  });
}

function makeJsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });
}

function firstRequestUrl(fetchSpy: ReturnType<typeof vi.spyOn>): URL {
  const requestUrl = fetchSpy.mock.calls[0]?.[0];
  if (requestUrl === undefined) {
    throw new Error('Expected fetch to have been called');
  }
  return new URL(String(requestUrl));
}

describe('query resource schema', () => {
  it('parses a valid query block', () => {
    const result = ResourceSpecSchema.safeParse(makeQueryableResource());
    expect(result.success).toBe(true);
  });

  it('accepts contains filters for provider substring search inputs', () => {
    const result = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        query: {
          filters: {
            state: {
              operators: ['contains'],
              bind: {
                contains: { input: 'state' },
              },
            },
          },
        },
      })
    );

    expect(result.success).toBe(true);
  });

  it('accepts ne, lt, gt, and not scalar filter operators', () => {
    const result = ResourceSpecSchema.safeParse(makeScalarOperatorResource());

    expect(result.success).toBe(true);
  });

  it('accepts in filters bound to scalar array inputs', () => {
    const result = ResourceSpecSchema.safeParse(makeInOperatorResource());

    expect(result.success).toBe(true);
  });

  it('rejects query filters that do not reference scalar output fields', () => {
    const result = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        output: {
          id: { type: 'integer', path: '$.id' },
          labels: { type: 'array', path: '$.labels' },
        },
        query: {
          filters: {
            labels: {
              operators: ['eq'],
              bind: {
                eq: { input: 'state' },
              },
            },
          },
        },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('scalar output field');
  });

  it('rejects operators without matching binds', () => {
    const result = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        query: {
          filters: {
            state: {
              operators: ['eq', 'gte'],
              bind: {
                eq: { input: 'state' },
              },
            },
          },
        },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('matching bind entry');
  });

  it.each(['ne', 'lt', 'gt', 'not', 'in'] as const)(
    'rejects %s operators without matching binds',
    (operator) => {
      const result = ResourceSpecSchema.safeParse(
        makeQueryableResource({
          query: {
            filters: {
              state: {
                operators: [operator],
                bind: {},
              },
            },
          },
        })
      );

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('matching bind entry');
    }
  );

  it.each([
    ['scalar input', { type: 'string' }],
    ['array input without item schema', { type: 'array' }],
    ['array input with non-scalar items', { type: 'array', items: { type: 'object' } }],
  ] as const)('rejects in filters bound to %s', (_label, states) => {
    const result = ResourceSpecSchema.safeParse(
      makeInOperatorResource({
        input: {
          states,
        },
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('is not compatible with output type');
  });

  it('rejects missing or required bind inputs', () => {
    const missingInput = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        query: {
          filters: {
            state: {
              operators: ['eq'],
              bind: {
                eq: { input: 'missing_state' },
              },
            },
          },
        },
      })
    );

    const requiredInput = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        input: {
          state: {
            type: 'string',
            required: true,
          },
        },
      })
    );

    expect(missingInput.success).toBe(false);
    expect(missingInput.error?.issues[0]?.message).toContain('must reference a resource input');
    expect(requiredInput.success).toBe(false);
    expect(requiredInput.error?.issues[0]?.message).toContain('must not be required');
  });

  it('rejects non-string search bind inputs and duplicate bind reuse', () => {
    const invalidSearch = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        input: {
          state: {
            type: 'string',
            default: 'open',
          },
          since: {
            type: 'integer',
          },
        },
        query: {
          search: {
            dialect: 'jira_jql',
            bind: {
              input: 'since',
            },
          },
        },
      })
    );

    const duplicateBind = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        query: {
          filters: {
            state: {
              operators: ['eq'],
              bind: {
                eq: { input: 'state' },
              },
            },
          },
          search: {
            dialect: 'jira_jql',
            bind: {
              input: 'state',
            },
          },
        },
      })
    );

    expect(invalidSearch.success).toBe(false);
    expect(invalidSearch.error?.issues[0]?.message).toContain('string input');
    expect(duplicateBind.success).toBe(false);
    expect(duplicateBind.error?.issues[0]?.message).toContain('already used');
  });

  it('rejects enum literals whose types do not match the output field type', () => {
    const booleanEnumOnString = ResourceSpecSchema.safeParse(
      makeQueryableResource({
        query: {
          filters: {
            state: {
              operators: ['eq'],
              enum: [true],
              bind: {
                eq: { input: 'state' },
              },
            },
          },
        },
      })
    );

    expect(booleanEnumOnString.success).toBe(false);
    expect(booleanEnumOnString.error?.issues[0]?.message).toContain(
      'does not match output type "string"'
    );
  });
});

describe('queryResource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists a bounded resource that has no provider-side query support', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));
    const resource = makeQueryableResource({ query: undefined });

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource,
      limit: 5,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.records).toEqual([{ id: 1, state: 'open', updated_at: '2026-04-01' }]);
  });

  it('routes POST pagination cursors into the declared request body', async () => {
    const requestBodies: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      expect(url.searchParams.has('start_cursor')).toBe(false);
      return requestBodies.length === 1
        ? makeJsonResponse({ results: [{ id: 1 }], next_cursor: 'cursor-2' })
        : makeJsonResponse({ results: [{ id: 2 }], next_cursor: null });
    });
    const resource = makeResource({
      name: 'search_results',
      api: {
        endpoint: '/search',
        method: 'POST',
        request_body: { page_size: 100 },
      },
      output: { id: { type: 'integer', path: '$.id' } },
      extract: {
        record_path: '$.results',
        pagination: {
          type: 'cursor',
          cursor_path: '$.next_cursor',
          cursor_param: 'start_cursor',
        },
      },
      query: { filters: {} },
    });

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource,
      limit: 10,
    });

    expect(result.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.requestCount).toBe(2);
    expect(requestBodies).toEqual([
      { page_size: 100 },
      { page_size: 100, start_cursor: 'cursor-2' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores return values from the synchronous HTTP mapped-record callback', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1 }, { id: 2 }]));
    const onMappedRecord = vi.fn(() => true);

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeResource({
        name: 'items',
        api: { endpoint: '/items', method: 'GET' },
        output: { id: { type: 'integer', path: '$.id' } },
        extract: { record_path: '$' },
        query: { filters: {} },
      }),
      onMappedRecord,
    });

    expect(result).toMatchObject({
      records: [{ id: 1 }, { id: 2 }],
      limitReached: false,
      requestCount: 1,
    });
    expect(onMappedRecord).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects filters and search for a resource with no query support', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resource = makeQueryableResource({ query: undefined });
    const integration = makeProvider('https://api.example.com');

    await expect(
      queryResource({ integration, resource, filter: { state: 'open' } })
    ).rejects.toThrow('does not declare query filter "state"');
    await expect(queryResource({ integration, resource, search: 'open' })).rejects.toThrow(
      'does not declare query.search support'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projects contextual output from an exact targeted parent binding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([{ id: 'event-1' }]));
    const resource = makeQueryableResource({
      api: { endpoint: '/projects/${{ input.project_id }}/events', method: 'GET' },
      input: { project_id: { type: 'integer', required: true } },
      output: {
        id: { type: 'string', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
    });

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource,
      input: { project_id: 42 },
    });

    expect(result.records).toEqual([{ id: 'event-1', project_id: 42 }]);
  });

  it('rejects contextual query output that cannot be proven from the direct binding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resource = makeQueryableResource({
      api: { endpoint: '/projects/${{ input.project_id }}/events', method: 'GET' },
      input: { project_id: { type: 'integer', required: true } },
      output: {
        id: { type: 'string', path: '$.id' },
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
    });

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource,
        input: { project_id: 42 },
      })
    ).rejects.toThrow(/cannot prove fan-out context.*co-schedule its fan-out ancestors/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes scalar and operator filters identically', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    const integration = makeProvider('https://api.example.com');
    const resource = makeQueryableResource();

    await queryResource({
      integration,
      resource,
      filter: { state: 'open' },
    });
    const scalarUrl = firstRequestUrl(fetchSpy).toString();

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(
      makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }])
    );

    await queryResource({
      integration,
      resource,
      filter: { state: { eq: 'open' } },
    });
    const operatorUrl = firstRequestUrl(fetchSpy).toString();

    expect(operatorUrl).toBe(scalarUrl);
    expect(operatorUrl).toContain('state=open');
  });

  it('binds new scalar operators to their declared optional inputs', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeJsonResponse([{ id: 1, status: 'open', rank: 4, score: 0.9, archived: false }])
      );

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeScalarOperatorResource(),
      filter: {
        status: { $ne: 'closed' },
        rank: { lt: 10 },
        score: { $gt: 0.75 },
        archived: { $not: false },
      },
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('status_ne')).toBe('closed');
    expect(url.searchParams.get('rank_lt')).toBe('10');
    expect(url.searchParams.get('score_gt')).toBe('0.75');
    expect(url.searchParams.get('archived_not')).toBe('false');
    expect(result.records).toEqual([
      { id: 1, status: 'open', rank: 4, score: 0.9, archived: false },
    ]);
  });

  it('binds in filters to their declared scalar array input', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open' }]));

    const result = await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeInOperatorResource(),
      filter: {
        state: { $in: ['open', 'closed'] },
      },
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('state_in')).toBe(JSON.stringify(['open', 'closed']));
    expect(result.records).toEqual([{ id: 1, state: 'open' }]);
  });

  it('preserves commas in targeted array overrides through the HTTP request path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));
    const targeted = parseResourceInputsJson(
      JSON.stringify({ issues: { labels: ['has,comma', 'chore'] } })
    );
    const resource = makeQueryableResource({
      api: {
        endpoint: '/issues',
        method: 'GET',
        query_params: {
          state: '${{ input.state }}',
          labels: '${{ input.labels }}',
        },
      },
      input: {
        state: {
          type: 'string',
          default: 'open',
          enum: ['open', 'closed', 'all'],
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });

    await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource,
      input: mergeResourceInputs({}, targeted, 'issues'),
    });

    expect(firstRequestUrl(fetchSpy).searchParams.get('labels')).toBe(
      JSON.stringify(['has,comma', 'chore'])
    );
  });

  it('strips bound defaults when the filter is omitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeQueryableResource(),
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('state')).toBeNull();
    expect(url.searchParams.get('per_page')).toBe('100');
  });

  it('preserves bound defaults when a query bind opts in', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeQueryableResource({
        input: {
          state: {
            type: 'string',
            default: 'ORDERBYupdated_at',
          },
          per_page: {
            type: 'integer',
            default: 100,
          },
        },
        query: {
          search: {
            dialect: 'servicenow_sysparm_query',
            bind: {
              input: 'state',
              preserve_default: true,
            },
          },
        },
      }),
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('state')).toBe('ORDERBYupdated_at');
    expect(url.searchParams.get('per_page')).toBe('100');
  });

  it('appends configured search suffixes before dispatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeQueryableResource({
        input: {
          state: {
            type: 'string',
            default: 'ORDERBYupdated_at',
          },
          per_page: {
            type: 'integer',
            default: 100,
          },
        },
        query: {
          search: {
            dialect: 'servicenow_sysparm_query',
            bind: {
              input: 'state',
              preserve_default: true,
            },
            append: '^ORDERBYupdated_at',
          },
        },
      }),
      search: 'active=true',
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('state')).toBe('active=true^ORDERBYupdated_at');
  });

  it('rejects filter and search together before making a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource({
          query: {
            filters: {
              state: {
                operators: ['eq'],
                bind: {
                  eq: { input: 'state' },
                },
              },
            },
            search: {
              dialect: 'jira_jql',
              bind: {
                input: 'state',
              },
            },
          },
        }),
        filter: { state: 'open' },
        search: 'project = FOO',
      })
    ).rejects.toThrow('either filter or search');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid filter fields, operators, enums, and value types before network', async () => {
    const integration = makeProvider('https://api.example.com');
    const resource = makeQueryableResource();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration,
        resource,
        filter: { status: 'open' },
      })
    ).rejects.toThrow('does not declare query filter "status"');

    await expect(
      queryResource({
        integration,
        resource,
        filter: { state: { lte: 'open' } },
      })
    ).rejects.toThrow('does not support operator "lte"');

    await expect(
      queryResource({
        integration,
        resource,
        filter: { state: 'all' },
      })
    ).rejects.toThrow('must use one of');

    await expect(
      queryResource({
        integration,
        resource,
        filter: { updated_at: { gte: 123 } },
      })
    ).rejects.toThrow('expects a timestamp value');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects in filters with invalid enum members or value types before network', async () => {
    const integration = makeProvider('https://api.example.com');
    const resource = makeInOperatorResource();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration,
        resource,
        filter: { state: { $in: ['open', 'all'] } },
      })
    ).rejects.toThrow('must use one of');

    await expect(
      queryResource({
        integration,
        resource: makeInOperatorResource({
          query: {
            filters: {
              state: {
                operators: ['in'],
                bind: {
                  in: { input: 'states' },
                },
              },
            },
          },
        }),
        filter: { state: { in: [123] } },
      })
    ).rejects.toThrow('expects an array of string values');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('executes MCP query resources through the resolved Source transport', async () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      name: 'fixture',
      default_transport: 'mcp',
      transports: [
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: [fixturePath],
          timeout_ms: 10_000,
        },
      ],
    } as unknown as IntegrationSpec;
    const resource = {
      type: 'resource',
      name: 'recent_items',
      via: 'mcp',
      description: 'Recent items from an MCP tool',
      tool: {
        tool_name: 'list_with_since',
        arguments: {
          since: '${{ input.since }}',
        },
      },
      input: {
        since: { type: 'string' },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      },
      extract: {
        record_path: '$.items',
      },
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
    } as ResourceSpec;

    const result = await queryResource({
      integration,
      resource,
      filter: {
        updated_at: { gte: '2026-03-26T00:00:00.000Z' },
      },
    });

    expect(result).toMatchObject({
      limitReached: false,
      requestCount: 1,
      records: [
        { id: '2', name: 'beta', updated_at: '2026-03-26T00:00:00.000Z' },
        { id: '3', name: 'gamma', updated_at: '2026-03-27T00:00:00.000Z' },
      ],
    });
  });

  it('does not await or propagate promises returned by the MCP mapped-record callback', async () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      name: 'fixture',
      default_transport: 'mcp',
      transports: [
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: [fixturePath],
          timeout_ms: 10_000,
        },
      ],
    } as unknown as IntegrationSpec;
    const resource = {
      type: 'resource',
      name: 'recent_items',
      via: 'mcp',
      description: 'Recent items from an MCP tool',
      tool: {
        tool_name: 'list_with_since',
        arguments: { since: '${{ input.since }}' },
      },
      input: { since: { type: 'string' } },
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
        updated_at: { type: 'timestamp', path: '$.updatedAt' },
      },
      extract: { record_path: '$.items' },
      query: {
        filters: {
          updated_at: {
            operators: ['gte'],
            bind: { gte: { input: 'since' } },
          },
        },
      },
    } as ResourceSpec;
    const callbackFailure = Promise.reject(new Error('ignored callback rejection'));
    void callbackFailure.catch(() => undefined);
    const onMappedRecord = vi.fn(() => callbackFailure);

    const result = await queryResource({
      integration,
      resource,
      filter: { updated_at: { gte: '2026-03-26T00:00:00.000Z' } },
      onMappedRecord,
    });

    expect(result.records).toHaveLength(2);
    expect(result.limitReached).toBe(false);
    expect(onMappedRecord).toHaveBeenCalledTimes(2);
  });

  it('does not leak direct bind inputs into MCP filter_dsl tool arguments', async () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      name: 'fixture',
      default_transport: 'mcp',
      transports: [
        {
          id: 'mcp',
          type: 'mcp_stdio',
          command: 'node',
          args: [fixturePath],
          timeout_ms: 10_000,
        },
      ],
    } as unknown as IntegrationSpec;
    const resource = {
      type: 'resource',
      name: 'search_items',
      via: 'mcp',
      description: 'Search items from an MCP tool',
      tool: {
        tool_name: 'search_with_filter_groups',
      },
      input: {
        since: { type: 'string' },
        filterGroups: {
          type: 'array',
          items: {
            type: 'object',
          },
        },
      },
      output: {
        updated_at: {
          type: 'timestamp',
          path: '$.filterGroups[0].filters[0].value',
        },
        property_name: {
          type: 'string',
          path: '$.filterGroups[0].filters[0].propertyName',
        },
        leaked_since: {
          type: 'string',
          path: '$.since',
        },
      },
      extract: {
        record_path: '$.received',
      },
      query: {
        filters: {
          updated_at: {
            operators: ['gte'],
            bind: {
              gte: { input: 'since' },
            },
          },
        },
        compile: {
          mode: 'filter_dsl',
          builder: 'hubspot/crm-search',
          field_map: {
            updated_at: 'hs_lastmodifieddate',
          },
        },
      },
    } as ResourceSpec;

    const result = await queryResource({
      integration,
      resource,
      filter: {
        updated_at: { gte: '2026-03-26T00:00:00.000Z' },
      },
    });

    expect(result.records).toEqual([
      {
        updated_at: '2026-03-26T00:00:00.000Z',
        property_name: 'hs_lastmodifieddate',
      },
    ]);
  });

  it('rejects integrations without an executable query transport', async () => {
    await expect(
      queryResource({
        integration: {
          spec_version: '1',
          type: 'integration',
          name: 'broken',
        } as unknown as IntegrationSpec,
        resource: makeQueryableResource(),
        filter: { state: 'open' },
      })
    ).rejects.toThrow('cannot resolve a transport');
  });

  it('rejects single-transport SQL integrations through the SQL query path', async () => {
    await expect(
      queryResource({
        integration: {
          spec_version: '1',
          type: 'integration',
          name: 'warehouse',
          transport: {
            type: 'sql_snowflake',
            connection: { account: 'account', warehouse: 'warehouse', database: 'database' },
            auth: { type: 'password', user: 'user', password: 'password' },
          },
        } as unknown as IntegrationSpec,
        resource: makeQueryableResource(),
        filter: { state: 'open' },
      })
    ).rejects.toThrow('does not execute SQL transports');
  });

  it('rejects billable and warehouse resources', async () => {
    const integration = makeProvider('https://api.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));
    const billableResource = makeQueryableResource({
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'credit',
        estimation: {
          model: 'per_input_row',
          amount: 1,
          currency: 'provider_credit',
        },
        authorization: {
          requires_plan: true,
        },
      },
    });

    const warehouseResource = {
      spec_version: '1',
      type: 'resource',
      name: 'warehouse_items',
      integration: 'warehouse',
      description: 'Warehouse resource',
      source: {
        type: 'warehouse',
        table: 'items',
        columns: ['id'],
      },
      replication: {
        method: 'full_refresh',
      },
      output: {
        id: {
          type: 'integer',
        },
      },
    } as unknown as ResourceSpec;

    await expect(queryResource({ integration, resource: billableResource })).rejects.toThrow(
      'billable'
    );
    await expect(queryResource({ integration, resource: warehouseResource })).rejects.toThrow(
      'warehouse resources'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries a billable resource after explicit approval', async () => {
    const integration = makeProvider('https://api.example.com');
    const resource = makeQueryableResource({
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'credit',
        estimation: {
          model: 'per_input_row',
          amount: 1,
          currency: 'provider_credit',
        },
        authorization: { requires_plan: true },
      },
    });
    const authorizeBillable = vi.fn().mockResolvedValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([{ id: 42 }]));

    const result = await queryResource({
      integration,
      resource,
      filter: { state: 'open' },
      limit: 1,
      authorizeBillable,
    });

    expect(authorizeBillable).toHaveBeenCalledWith({
      operation: 'query',
      resource,
      billing: resource.billing,
    });
    expect(result.records).toEqual([expect.objectContaining({ id: 42 })]);
  });
});

describe('queryResource search validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unimplemented search declarations before network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        search: 'project = FOO',
      })
    ).rejects.toThrow('does not declare query.search support');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('queryResource operator normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects conflicting prefixed and unprefixed operators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        filter: {
          state: {
            eq: 'open',
            $eq: 'closed',
          },
        },
      })
    ).rejects.toThrow('cannot mix');
  });

  it('rejects not filters that use compound objects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeScalarOperatorResource(),
        filter: {
          archived: {
            $not: { eq: false } as never,
          },
        },
      })
    ).rejects.toThrow('operator "$not" must use a scalar value');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects in filters that do not use non-empty scalar arrays', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeInOperatorResource(),
        filter: {
          state: ['open'] as never,
        },
      })
    ).rejects.toThrow('must be a scalar or an operator object');

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeInOperatorResource(),
        filter: {
          state: {
            $in: [],
          },
        },
      })
    ).rejects.toThrow('must use a non-empty scalar array value');

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeInOperatorResource(),
        filter: {
          state: {
            $in: ['open', { state: 'closed' }] as never,
          },
        },
      })
    ).rejects.toThrow('must use a non-empty scalar array value');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('queryResource limit validation', () => {
  it('rejects non-positive limits', async () => {
    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        limit: 0,
      })
    ).rejects.toThrow('positive integer');
  });

  it('rejects unsafe integer limits', async () => {
    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        limit: Number.MAX_SAFE_INTEGER + 1,
      })
    ).rejects.toThrow('positive integer');
  });

  it('rejects limits above the hard ceiling', async () => {
    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        limit: 10_001,
      })
    ).rejects.toThrow('must not exceed');
  });
});

describe('queryResource input shadowing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects caller input that shadows a bound filter input', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource: makeQueryableResource(),
        input: { state: 'closed' },
      })
    ).rejects.toThrow('cannot override bound query input "state"');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects caller input that shadows a bound search input', async () => {
    const resource = makeQueryableResource({
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
        search: {
          dialect: 'jira_jql',
          bind: {
            input: 'since',
          },
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse([]));

    await expect(
      queryResource({
        integration: makeProvider('https://api.example.com'),
        resource,
        input: { since: '2020-01-01T00:00:00Z' },
        search: 'project = FOO',
      })
    ).rejects.toThrow('cannot override bound query input "since"');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows caller input for non-bound inputs', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    await queryResource({
      integration: makeProvider('https://api.example.com'),
      resource: makeQueryableResource(),
      filter: { state: 'open' },
      input: { per_page: 25 },
    });

    const url = firstRequestUrl(fetchSpy);
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('per_page')).toBe('25');
  });
});

describe('queryResource injected secrets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('resolves transport auth from the injected secrets map instead of process.env', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    // Poison process.env so a fallback would produce the wrong token.
    vi.stubEnv('SERVICE_TOKEN', 'env-wrong-token');

    const integration = makeProvider('https://api.example.com', {
      auth_env_vars: ['SERVICE_TOKEN'],
      auth: { type: 'bearer', token: '${{ secrets.SERVICE_TOKEN }}' },
    });
    const resource = makeQueryableResource();

    await queryResource({
      integration,
      resource,
      filter: { state: 'open' },
      secrets: { SERVICE_TOKEN: 'injected-correct-token' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const headers = (requestInit as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer injected-correct-token');
  });

  it('falls back to process.env when no secrets map is supplied', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    vi.stubEnv('SERVICE_AUTH_TOKEN', 'env-default-token');

    await queryResource({
      integration: makeProvider('https://api.example.com', {
        auth_env_vars: ['SERVICE_AUTH_TOKEN'],
        auth: { type: 'bearer', token: '${{ secrets.SERVICE_AUTH_TOKEN }}' },
      }),
      resource: makeQueryableResource(),
      filter: { state: 'open' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const headers = (requestInit as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer env-default-token');
  });
});

describe('queryResource injected secrets satisfy env.* auth templates', () => {
  // Every catalog transport writes its auth as `${{ env.<NAME> }}` (the extract
  // convention). The source-query/live path injects credentials per request via
  // `secrets`, so those injected values must also satisfy `env.*` templates —
  // otherwise the credential lands in the `secrets.*` namespace the template
  // never reads, and auth fails with "Missing env.<NAME>".
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('resolves an ${{ env.<NAME> }} api-key template from the injected secrets map with no process.env set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    // No real process.env.LINEAR_API_KEY exists; the credential is only injected.
    vi.stubEnv('LINEAR_API_KEY', undefined as unknown as string);

    const integration = makeProvider('https://api.example.com', {
      auth_env_vars: ['LINEAR_API_KEY'],
      auth: { type: 'api-key', header: 'Authorization', key: '${{ env.LINEAR_API_KEY }}' },
    });

    await queryResource({
      integration,
      resource: makeQueryableResource(),
      filter: { state: 'open' },
      secrets: { LINEAR_API_KEY: 'injected-linear-key' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const headers = (requestInit as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('injected-linear-key');
    // The injected credential never leaks into the process environment.
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
  });

  it('rejects blocked env.* names even when a request injects that credential', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    vi.stubEnv('GH_TOKEN', 'env-wrong-token');

    const integration = makeProvider('https://api.example.com', {
      auth_env_vars: ['GH_TOKEN'],
      auth: { type: 'api-key', header: 'Authorization', key: '${{ env.GH_TOKEN }}' },
    });

    await expect(
      queryResource({
        integration,
        resource: makeQueryableResource(),
        filter: { state: 'open' },
        secrets: { GH_TOKEN: 'injected-correct-token' },
      })
    ).rejects.toThrow(/Bobsled Core could not validate the request/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still falls back to process.env for ${{ env.<NAME> }} when no secrets are injected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse([{ id: 1, state: 'open', updated_at: '2026-04-01' }]));

    vi.stubEnv('LINEAR_API_KEY', 'env-default-key');

    await queryResource({
      integration: makeProvider('https://api.example.com', {
        auth_env_vars: ['LINEAR_API_KEY'],
        auth: { type: 'api-key', header: 'Authorization', key: '${{ env.LINEAR_API_KEY }}' },
      }),
      resource: makeQueryableResource(),
      filter: { state: 'open' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchSpy.mock.calls[0]!;
    const headers = (requestInit as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('env-default-key');
  });
});

describe('query resource helper types', () => {
  it('keeps the integration fixture shape valid for query tests', () => {
    const integration = makeProvider('https://api.example.com') as IntegrationSpec;
    expect(integration.transport.type).toBe('http');
  });
});
