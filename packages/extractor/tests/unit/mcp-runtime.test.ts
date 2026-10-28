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
    ) => {
      // Runtime behavior tests use the checked-in Node fixture server. Bypass
      // the production registry only inside this mocked module; command-shape
      // enforcement is covered directly by security/mcp-sandbox.test.ts.
      if (transport.command === 'node') {
        return new StdioClientTransport({
          command: transport.command,
          args: transport.args ?? [],
          env: resolvedEnv,
          stderr: 'pipe',
        });
      }
      return actual.createStdioTransport(transport, resolvedEnv);
    },
  };
});

import { setNestedValue } from '../../src/commands/extract-utils.js';
import { ExtractorTransientError } from '../../src/runtime/errors.js';
import { lookupResource } from '../../src/runtime/lookup.js';
import { McpExtractorClient } from '../../src/runtime/mcp-client.js';
import { paginateMcpTool } from '../../src/runtime/mcp-pagination.js';
import { extractRecords } from '../../src/runtime/response-mapper.js';
import { DogsledRuntimeError } from '@bobsled-inc/protocol';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mcp/test-server.mjs', import.meta.url));

describe('MCP SSRF protection', () => {
  it('rejects private IPs via isPrivateHost', async () => {
    delete process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    const { isPrivateHost } = await import('../../src/framework/core/index.js');
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('metadata.google.internal')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  it('constructor accepts mcp_http but connect rejects private hosts', async () => {
    const client = new McpExtractorClient({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'ssrf_test',
        transport: { type: 'mcp_http', url: 'https://192.168.1.1/mcp' },
      } as IntegrationSpec,
    });
    expect(client).toBeDefined();
    // The actual SSRF rejection happens at connect() time, not construction
    await expect(client.connect()).rejects.toThrow('private or internal host');
  });
});

function createIntegration(overrides?: Partial<IntegrationSpec>): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'fixture_mcp',
    transport: {
      type: 'mcp_stdio',
      command: 'node',
      args: [fixturePath],
      timeout_ms: 10_000,
    },
    ...overrides,
  } as IntegrationSpec;
}

function createListResource(): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'items',
    integration: 'fixture_mcp',
    description: 'Fixture items',
    tool: {
      tool_name: 'list_items',
      arguments: {
        status: '${{ input.status }}',
      },
    },
    input: {
      status: { type: 'string', required: false, default: 'open' },
    },
    output: {
      id: { type: 'string', path: '$.id' },
      name: { type: 'string', path: '$.name' },
      updated_at: { type: 'timestamp', path: '$.updatedAt' },
    },
    extract: {
      record_path: '$.items',
      pagination: {
        type: 'mcp_cursor',
        cursor_path: '$.pageInfo.endCursor',
        cursor_argument: 'after',
      },
      incremental: {
        cursor_field: 'updated_at',
        cursor_param: 'after',
        cursor_type: 'timestamp',
      },
      table: {
        primary_key: ['id'],
      },
    },
    lookup: {
      description: 'Lookup fixture item',
      tool: {
        tool_name: 'lookup_item',
      },
      input: {
        id: { type: 'string', required: true },
      },
      output: {
        id: { type: 'string', path: '$.item.id' },
        name: { type: 'string', path: '$.item.name' },
      },
      extract: {
        record_path: '$',
      },
    },
  } as ResourceSpec;
}

describe('MCP runtime', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it('lets one caller abort without cancelling shared connection establishment', async () => {
    const client = new McpExtractorClient({ integration: createIntegration() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const internals = client as unknown as {
      doConnect(): Promise<void>;
      transport: object | null;
    };
    const doConnect = vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
      await gate;
      internals.transport = {};
    });
    const first = new AbortController();

    const cancelledWaiter = client.connect(first.signal);
    const survivingWaiter = client.connect();
    first.abort();

    await expect(cancelledWaiter).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await expect(survivingWaiter).resolves.toBeUndefined();
    expect(doConnect).toHaveBeenCalledOnce();
  });

  it('preserves a custom abort reason at the public callTool boundary', async () => {
    const reason = new Error('caller stopped this request');
    const client = new McpExtractorClient({ integration: createIntegration() });
    const error = await client
      .callTool({
        operation: { input: {}, tool: { tool_name: 'list_items' } },
        signal: AbortSignal.abort(reason),
      })
      .catch((value) => value as DogsledRuntimeError);

    expect(error).toMatchObject({ kind: 'cancellation', code: 'EXTRACTOR_MCP_CANCELLED' });
    expect(error.cause).toBe(reason);
  });

  it('lists tools and parses text-only JSON tool responses', async () => {
    const client = new McpExtractorClient({ integration: createIntegration() });
    clients.push(client);

    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_items', 'lookup_item', 'text_only_items'])
    );

    const result = await client.callTool({
      operation: {
        input: {
          status: { type: 'string', required: false, default: 'open' },
        },
        tool: {
          tool_name: 'text_only_items',
          arguments: {
            status: '${{ input.status }}',
          },
        },
      },
    });

    expect(result).toEqual({
      items: [{ id: '1', name: 'alpha', status: 'open', updatedAt: '2026-03-25T00:00:00.000Z' }],
      pageInfo: {
        endCursor: '1',
      },
    });
  });

  it('paginates MCP tools with cursor arguments', async () => {
    const integration = createIntegration();
    const resource = createListResource();
    const client = new McpExtractorClient({ integration });
    clients.push(client);

    await client.connect();
    const pages: unknown[] = [];
    for await (const page of paginateMcpTool(
      resource,
      async (argumentOverrides) =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
          argumentOverrides,
        }),
      async () => undefined
    )) {
      pages.push(page.data);
    }

    expect(pages).toHaveLength(2);
    expect(pages).toEqual([
      {
        items: [{ id: '1', name: 'alpha', status: 'open', updatedAt: '2026-03-25T00:00:00.000Z' }],
        pageInfo: { endCursor: '1' },
      },
      {
        items: [{ id: '2', name: 'beta', status: 'open', updatedAt: '2026-03-26T00:00:00.000Z' }],
        pageInfo: { endCursor: null },
      },
    ]);
  });

  it('sends an empty object for tools without configured arguments', async () => {
    const client = new McpExtractorClient({ integration: createIntegration() });
    clients.push(client);

    await client.connect();
    await expect(
      client.callTool({
        operation: {
          input: {},
          tool: {
            tool_name: 'get_requires_empty_object',
          },
        },
      })
    ).resolves.toEqual({ ok: true });
  });

  it('runs lookupResource through MCP tools', async () => {
    const records = await lookupResource({
      integration: createIntegration(),
      resource: createListResource(),
      input: { id: '2' },
    });

    expect(records).toEqual([{ id: '2', name: 'beta' }]);
  });

  it('rejects HTTP transport in McpExtractorClient', () => {
    expect(
      () =>
        new McpExtractorClient({
          integration: {
            spec_version: '1',
            type: 'integration',
            name: 'http_only',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
            },
          } as IntegrationSpec,
        })
    ).toThrow('Use ExtractorClient instead');
  });

  it('rejects stdio commands with path separators', async () => {
    expect(
      () =>
        new McpExtractorClient({
          integration: {
            spec_version: '1',
            type: 'integration',
            name: 'evil',
            transport: {
              type: 'mcp_stdio',
              command: '../node',
              args: [],
            },
          } as IntegrationSpec,
        })
    ).not.toThrow();

    const client = new McpExtractorClient({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'evil',
        transport: {
          type: 'mcp_stdio',
          command: '../node',
          args: [],
        },
      } as IntegrationSpec,
    });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow('must not contain path separators');
  });

  it('rejects disallowed stdio commands', async () => {
    const client = new McpExtractorClient({
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'evil',
        transport: {
          type: 'mcp_stdio',
          command: 'bash',
          args: ['-c', 'echo pwned'],
        },
      } as IntegrationSpec,
    });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow('is not allowed');
  });

  it('is idempotent on connect and close', async () => {
    const client = new McpExtractorClient({ integration: createIntegration() });
    clients.push(client);

    await client.connect();
    await client.connect();
    await client.close();
    await client.close();
  });

  it('paginates with no pagination config (single page)', async () => {
    const resource: ResourceSpec = {
      ...createListResource(),
      extract: {
        ...createListResource().extract,
        pagination: { type: 'none' },
      },
    } as ResourceSpec;
    const client = new McpExtractorClient({ integration: createIntegration() });
    clients.push(client);

    await client.connect();
    const pages: unknown[] = [];
    for await (const page of paginateMcpTool(
      resource,
      async () =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
        }),
      async () => undefined
    )) {
      pages.push(page.data);
    }

    expect(pages).toHaveLength(1);
  });
});

// --- MCP offset/page_number pagination tests ---

function createOffsetResource(): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'offset_items',
    integration: 'fixture_mcp',
    description: 'Offset paginated items',
    tool: {
      tool_name: 'offset_items',
      arguments: {},
    },
    input: {},
    output: {
      id: { type: 'integer', path: '$.id' },
      name: { type: 'string', path: '$.name' },
    },
    extract: {
      record_path: '$.items',
      pagination: {
        type: 'mcp_offset',
        offset_argument: 'offset',
        limit_argument: 'limit',
        limit_value: 10,
        total_path: '$.meta.total',
      },
      table: {
        primary_key: ['id'],
      },
    },
  } as ResourceSpec;
}

function createPagedResource(): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'paged_items',
    integration: 'fixture_mcp',
    description: 'Page-number paginated items',
    tool: {
      tool_name: 'paged_items',
      arguments: {},
    },
    input: {},
    output: {
      id: { type: 'integer', path: '$.id' },
      name: { type: 'string', path: '$.name' },
    },
    extract: {
      record_path: '$.items',
      pagination: {
        type: 'mcp_page_number',
        page_argument: 'page',
        per_page_argument: 'per_page',
        per_page_value: 10,
        total_pages_path: '$.meta.pages',
        start_page: 1,
      },
      table: {
        primary_key: ['id'],
      },
    },
  } as ResourceSpec;
}

describe('MCP offset pagination', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it('retrieves all 35 items across pages using offset pagination', async () => {
    const integration = createIntegration();
    const resource = createOffsetResource();
    const client = new McpExtractorClient({ integration });
    clients.push(client);

    await client.connect();
    const allRecords: unknown[] = [];
    for await (const page of paginateMcpTool(
      resource,
      async (argumentOverrides) =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
          argumentOverrides,
        }),
      async () => undefined
    )) {
      const records = extractRecords(page.data, resource);
      allRecords.push(...records);
    }

    expect(allRecords).toHaveLength(35);
    expect(allRecords[0]).toEqual({ id: 1, name: 'item_1' });
    expect(allRecords[34]).toEqual({ id: 35, name: 'item_35' });
  });
});

describe('MCP page number pagination', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it('retrieves all 35 items across pages using page number pagination', async () => {
    const integration = createIntegration();
    const resource = createPagedResource();
    const client = new McpExtractorClient({ integration });
    clients.push(client);

    await client.connect();
    const allRecords: unknown[] = [];
    for await (const page of paginateMcpTool(
      resource,
      async (argumentOverrides) =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
          argumentOverrides,
        }),
      async () => undefined
    )) {
      const records = extractRecords(page.data, resource);
      allRecords.push(...records);
    }

    expect(allRecords).toHaveLength(35);
    expect(allRecords[0]).toEqual({ id: 1, name: 'item_1' });
    expect(allRecords[34]).toEqual({ id: 35, name: 'item_35' });
  });
});

describe('MCP cursor pagination with prefetch', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it('returns the same results with prefetch as without', async () => {
    const integration = createIntegration();
    const resource = createListResource();
    const client = new McpExtractorClient({ integration });
    clients.push(client);

    await client.connect();

    const pages: unknown[] = [];
    for await (const page of paginateMcpTool(
      resource,
      async (argumentOverrides) =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
          argumentOverrides,
        }),
      async () => undefined
    )) {
      pages.push(page.data);
    }

    expect(pages).toHaveLength(2);
    expect(pages).toEqual([
      {
        items: [{ id: '1', name: 'alpha', status: 'open', updatedAt: '2026-03-25T00:00:00.000Z' }],
        pageInfo: { endCursor: '1' },
      },
      {
        items: [{ id: '2', name: 'beta', status: 'open', updatedAt: '2026-03-26T00:00:00.000Z' }],
        pageInfo: { endCursor: null },
      },
    ]);
  });
});

describe('MCP error classification via fixture server', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it.each(['error_tool', 'auth_error_tool'] as const)(
    'returns a structural runtime error for %s after retries finish',
    async (toolName) => {
      const client = new McpExtractorClient({
        integration: createIntegration({
          transport: {
            type: 'mcp_stdio',
            command: 'node',
            args: [fixturePath],
            retry: { max_retries: 0 },
          },
        } as Partial<IntegrationSpec>),
      });
      clients.push(client);
      await client.connect();

      const error = await client
        .callTool({ operation: { input: {}, tool: { tool_name: toolName } } })
        .catch((value) => value);

      expect(error).toMatchObject({
        kind: 'provider',
        code: 'EXTRACTOR_MCP_TOOL_ERROR',
        operation: 'extractor.mcp.call_tool',
        retryable: false,
        message: 'The provider could not complete the operation.',
      });
      expect((error as DogsledRuntimeError).cause).toBeInstanceOf(Error);
      expect((error as DogsledRuntimeError).cause).not.toBeInstanceOf(ExtractorTransientError);
    }
  );
});

describe('MCP security', () => {
  const clients: McpExtractorClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it('throws on MCP tool isError response', async () => {
    const client = new McpExtractorClient({
      integration: createIntegration({
        transport: {
          type: 'mcp_stdio',
          command: 'node',
          args: [fixturePath],
          retry: { max_retries: 1 },
        },
      } as Partial<IntegrationSpec>),
    });
    clients.push(client);

    await client.connect();
    let attempts = 0;
    const error = await client
      .callTool({
        operation: {
          input: {},
          tool: {
            tool_name: 'error_tool',
            arguments: { _unused: 'dummy' },
          },
        },
        beforeRequestAttempt: () => {
          attempts += 1;
        },
      })
      .catch((value) => value);

    expect(error).toMatchObject({
      kind: 'provider',
      code: 'EXTRACTOR_MCP_TOOL_ERROR',
      retryable: false,
      message: 'The provider could not complete the operation.',
    });
    expect(attempts).toBe(1);
    expect((error as DogsledRuntimeError).cause).toEqual(
      new Error('Something went wrong in the tool')
    );
    expect((error as DogsledRuntimeError).cause).not.toBeInstanceOf(ExtractorTransientError);
  });

  it('throws on unsupported MCP pagination type', async () => {
    const resource: ResourceSpec = {
      ...createListResource(),
      extract: {
        ...createListResource().extract,
        pagination: {
          type: 'offset' as 'mcp_cursor',
          cursor_path: '$.next',
          cursor_argument: 'offset',
        },
      },
    } as ResourceSpec;

    const client = new McpExtractorClient({ integration: createIntegration() });
    clients.push(client);
    await client.connect();

    const gen = paginateMcpTool(
      resource,
      async () =>
        await client.callTool({
          operation: resource as {
            input: ResourceSpec['input'];
            tool: NonNullable<ResourceSpec['tool']>;
          },
        }),
      async () => undefined
    );

    await expect(gen.next()).rejects.toThrow('not supported for MCP resources');
  });

  it('times out on slow MCP tool calls', async () => {
    const integration = createIntegration({
      transport: {
        type: 'mcp_stdio',
        command: 'node',
        args: [fixturePath],
        timeout_ms: 500,
      },
    } as Partial<IntegrationSpec>);

    const client = new McpExtractorClient({ integration });
    clients.push(client);

    await client.connect();
    await expect(
      client.callTool({
        operation: {
          input: {},
          tool: {
            tool_name: 'slow_tool',
            arguments: { delay_ms: 5000 },
          },
        },
      })
    ).rejects.toThrow('timed out');
  });
});

describe('setNestedValue (shared)', () => {
  it('sets a top-level key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'foo', 'bar');
    expect(obj).toEqual({ foo: 'bar' });
  });

  it('sets a nested key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c', 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });

  it('blocks __proto__ key at any depth', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, '__proto__.polluted', true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(obj).toEqual({});
  });

  it('blocks constructor key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'constructor.prototype.polluted', true);
    expect(obj).toEqual({});
  });

  it('blocks prototype key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'foo.prototype.bar', true);
    expect(obj).toEqual({});
  });
});
