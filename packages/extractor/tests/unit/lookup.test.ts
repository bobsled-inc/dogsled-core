import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupResource } from '../../src/runtime/lookup.js';
import { ResourceSpecSchema } from '../../src/schemas/resource.js';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';
import { makeProvider, makeResource } from '../helpers/fixtures.js';

const mockRequest = vi.fn();
const mockClose = vi.fn();
const mockClient = vi.fn();
const mockMcpConnect = vi.fn();
const mockMcpCallTool = vi.fn();
const mockMcpClose = vi.fn();
const mockMcpClient = vi.fn();

vi.mock('../../src/runtime/client.js', () => ({
  ExtractorClient: vi.fn().mockImplementation(function (options) {
    mockClient(options);
    return { request: mockRequest, close: mockClose };
  }),
}));

vi.mock('../../src/runtime/mcp-client.js', () => ({
  McpExtractorClient: vi.fn().mockImplementation(function (options) {
    mockMcpClient(options);
    return {
      connect: mockMcpConnect,
      callTool: mockMcpCallTool,
      close: mockMcpClose,
    };
  }),
}));

const baseIntegration: IntegrationSpec = makeProvider('https://api.github.com', {
  name: 'github',
});

const baseResource: ResourceSpec = makeResource({
  name: 'issues',
  integration: 'github',
  output: {
    id: { type: 'integer', path: '$.id' },
    title: { type: 'string', path: '$.title' },
    state: { type: 'string', path: '$.state' },
  },
  lookup: {
    description: 'Fetch a single issue',
    api: {
      endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues/${{ input.id }}',
      method: 'GET',
    },
    input: {
      owner: { type: 'string', default: 'bobsled-inc' },
      repo: { type: 'string', default: 'demo-repo' },
      id: { type: 'string', required: true },
    },
  },
});

describe('lookupResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(undefined);
    mockMcpConnect.mockResolvedValue(undefined);
    mockMcpClose.mockResolvedValue(undefined);
    mockRequest.mockResolvedValue({
      data: { id: 42, title: 'Fix bug', state: 'open' },
      headers: new Headers(),
      status: 200,
    });
  });

  it('passes the lookup operation and input to the client and maps the parent output', async () => {
    const records = await lookupResource({
      integration: baseIntegration,
      resource: baseResource,
      input: { id: '42', owner: 'other-org' },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          api: baseResource.lookup!.api,
          input: baseResource.lookup!.input,
        },
        input: {
          id: '42',
          owner: 'other-org',
        },
      })
    );
    expect(records).toEqual([{ id: 42, title: 'Fix bug', state: 'open' }]);
  });

  it('projects contextual output from an exact targeted parent binding', async () => {
    const resource = makeResource({
      name: 'events',
      integration: 'github',
      input: { project_id: { type: 'integer', required: true } },
      output: {
        id: { type: 'integer', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
      lookup: {
        description: 'Fetch an event',
        api: {
          endpoint: '/projects/${{ input.project_id }}/events/${{ input.id }}',
          method: 'GET',
        },
        input: {
          project_id: { type: 'integer', required: true },
          id: { type: 'integer', required: true },
        },
      },
    });
    mockRequest.mockResolvedValue({ data: { id: 7 }, headers: new Headers(), status: 200 });

    await expect(
      lookupResource({
        integration: baseIntegration,
        resource,
        input: { project_id: 42, id: 7 },
      })
    ).resolves.toEqual([{ id: 7, project_id: 42 }]);
  });

  it('rejects lookup context that cannot be proven from the direct binding', async () => {
    const resource = makeResource({
      name: 'events',
      integration: 'github',
      input: { project_id: { type: 'integer', required: true } },
      output: {
        id: { type: 'integer', path: '$.id' },
        organization_id: {
          type: 'integer',
          from: { resource: 'organizations', path: '$.id' },
        },
      },
      extract: {
        record_path: '$',
        for_each: { resource: 'projects', field: 'id', input: 'project_id' },
      },
      lookup: {
        description: 'Fetch an event',
        api: {
          endpoint: '/projects/${{ input.project_id }}/events/${{ input.id }}',
          method: 'GET',
        },
        input: {
          project_id: { type: 'integer', required: true },
          id: { type: 'integer', required: true },
        },
      },
    });

    await expect(
      lookupResource({
        integration: baseIntegration,
        resource,
        input: { project_id: 42, id: 7 },
      })
    ).rejects.toThrow(/cannot prove fan-out context.*co-schedule its fan-out ancestors/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('uses lookup-specific output and record path when provided', async () => {
    const resource: ResourceSpec = makeResource({
      name: 'search_results',
      integration: 'github',
      output: baseResource.output,
      lookup: {
        description: 'Search items',
        api: {
          endpoint: '/items/search',
          method: 'POST',
          headers: { 'X-Lookup': '${{ input.repo }}' },
          query_params: { expand: '${{ input.item_id }}' },
          request_body: { query: '${{ input.repo }}' },
        },
        input: {
          repo: { type: 'string', default: 'demo-repo' },
          item_id: { type: 'string', required: true },
        },
        output: {
          item_id: { type: 'integer', path: '$.id' },
        },
        extract: {
          record_path: '$.data.items',
        },
      },
    });

    mockRequest.mockResolvedValue({
      data: { data: { items: [{ id: 42, title: 'Fix bug', state: 'open' }] } },
      headers: new Headers(),
      status: 200,
    });

    const records = await lookupResource({
      integration: baseIntegration,
      resource,
      input: { item_id: '42' },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          api: resource.lookup!.api,
          input: resource.lookup!.input,
        },
        input: {
          item_id: '42',
        },
      })
    );
    expect(records).toEqual([{ item_id: 42 }]);
  });

  it('throws when a resource has no lookup config', async () => {
    await expect(
      lookupResource({
        integration: baseIntegration,
        resource: { ...baseResource, lookup: undefined },
        input: { id: '42' },
      })
    ).rejects.toThrow('does not define a lookup operation');
  });

  it('uses request-scoped secrets and forwards cancellation', async () => {
    const signal = new AbortController().signal;

    await lookupResource({
      integration: baseIntegration,
      resource: baseResource,
      input: { id: '42' },
      secrets: { API_TOKEN: 'request-only-token' },
      signal,
    });

    expect(mockClient).toHaveBeenCalledWith({
      integration: baseIntegration,
      secrets: { API_TOKEN: 'request-only-token' },
      env: { API_TOKEN: 'request-only-token' },
    });
    expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('fails closed for billable lookups and runs after explicit approval', async () => {
    const billableResource = {
      ...baseResource,
      billing: {
        mode: 'billable' as const,
        unit: 'request',
        estimation: { model: 'per_request' as const, amount: 1 },
        authorization: { requires_plan: true as const },
      },
    };

    await expect(
      lookupResource({ integration: baseIntegration, resource: billableResource })
    ).rejects.toThrow('billable');
    expect(mockRequest).not.toHaveBeenCalled();

    const authorizeBillable = vi.fn().mockResolvedValue(true);
    await lookupResource({
      integration: baseIntegration,
      resource: billableResource,
      authorizeBillable,
    });

    expect(authorizeBillable).toHaveBeenCalledWith({
      operation: 'lookup',
      resource: billableResource,
      billing: billableResource.billing,
      maxNetworkRequests: 3,
    });
    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it('passes one bounded network-attempt budget to the HTTP lookup', async () => {
    await lookupResource({
      integration: baseIntegration,
      resource: baseResource,
      limits: { maxNetworkRequests: 2 },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeRequestAttempt: expect.any(Function),
      })
    );
  });

  it('runs a lookup-only HTTP Resource', async () => {
    const resource = ResourceSpecSchema.parse({
      type: 'resource',
      name: 'user',
      description: 'One user',
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
      },
      lookup: {
        description: 'Find one user',
        api: { endpoint: '/users/${{ input.user_id }}', method: 'GET' },
        input: { user_id: { type: 'string', required: true } },
      },
    });
    mockRequest.mockResolvedValue({
      data: { id: 'u-1', name: 'Alice' },
      headers: new Headers(),
      status: 200,
    });

    await expect(
      lookupResource({ integration: baseIntegration, resource, input: { user_id: 'u-1' } })
    ).resolves.toEqual([{ id: 'u-1', name: 'Alice' }]);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: { api: resource.lookup.api, input: resource.lookup.input },
      })
    );
  });

  it('rejects a response that exceeds the lookup record limit', async () => {
    const resource = makeResource({
      ...baseResource,
      lookup: {
        ...baseResource.lookup!,
        extract: { record_path: '$.items' },
      },
    });
    mockRequest.mockResolvedValue({
      data: {
        items: [
          { id: 1, title: 'First', state: 'open' },
          { id: 2, title: 'Second', state: 'open' },
        ],
      },
      headers: new Headers(),
      status: 200,
    });

    await expect(lookupResource({ integration: baseIntegration, resource })).rejects.toThrow(
      'record limit of 1'
    );
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('rejects a response that exceeds the lookup result-size limit', async () => {
    await expect(
      lookupResource({
        integration: baseIntegration,
        resource: baseResource,
        limits: { maxResultBytes: 10 },
      })
    ).rejects.toThrow('result-size limit of 10 bytes');

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('rejects lookup limits above the hard caps before making a request', async () => {
    await expect(
      lookupResource({
        integration: baseIntegration,
        resource: baseResource,
        limits: { maxNetworkRequests: 4 },
      })
    ).rejects.toThrow('maxNetworkRequests must be between 1 and 3');

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('closes the HTTP client after a failed request', async () => {
    mockRequest.mockRejectedValueOnce(new Error('upstream failed'));

    await expect(
      lookupResource({ integration: baseIntegration, resource: baseResource })
    ).rejects.toThrow('upstream failed');

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('runs a lookup-only MCP Resource and always closes the client', async () => {
    const integration: IntegrationSpec = {
      auth_env_vars: ['MCP_TOKEN'],
      spec_version: '2',
      type: 'source',
      source_type: 'custom_mcp',
      name: 'identity',
      transports: [
        {
          id: 'default',
          type: 'mcp_http',
          url: 'https://mcp.example.com/mcp',
          auth: { type: 'bearer', token: '${{ secrets.MCP_TOKEN }}' },
        },
      ],
      default_transport: 'default',
    };
    const resource = ResourceSpecSchema.parse({
      type: 'resource',
      name: 'users',
      via: 'default',
      description: 'Identity users',
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
      },
      lookup: {
        description: 'Find one user',
        tool: { tool_name: 'get_user' },
        input: { user_id: { type: 'string', required: true } },
      },
    });
    const signal = new AbortController().signal;
    mockMcpCallTool.mockResolvedValue({ id: 'u-1', name: 'Alice' });

    const records = await lookupResource({
      integration,
      resource,
      input: { user_id: 'u-1' },
      secrets: { MCP_TOKEN: 'request-only-token' },
      signal,
    });

    expect(mockMcpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { MCP_TOKEN: 'request-only-token' },
        env: { MCP_TOKEN: 'request-only-token' },
      })
    );
    expect(mockMcpConnect).toHaveBeenCalledWith(signal);
    expect(mockMcpCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        signal,
        beforeRequestAttempt: expect.any(Function),
      })
    );
    expect(mockMcpClose).toHaveBeenCalledOnce();
    expect(records).toEqual([{ id: 'u-1', name: 'Alice' }]);
  });
});
