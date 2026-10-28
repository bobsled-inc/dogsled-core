import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractResourcesWithMatrices } from '../../../src/commands/extract-matrix.js';
import { extractResource } from '../../../src/commands/extract-resource.js';
import { ExtractorClient } from '../../../src/runtime/client.js';
import { ControlLogger } from '../../../src/runtime/control.js';
import { Emitter } from '../../../src/runtime/emitter.js';
import { ResourceCircuitBreaker } from '../../../src/runtime/errors.js';
import { EMPTY_FAN_OUT_CONTEXT } from '../../../src/runtime/for-each.js';
import { McpExtractorClient } from '../../../src/runtime/mcp-client.js';
import type { StateStore } from '../../../src/runtime/state.js';
import type { TransportClientPool } from '../../../src/runtime/transport-client-pool.js';
import type { ApiIntegrationSpec, ExtractorState } from '../../../src/types/index.js';
import { makeProvider, makeResource } from '../../helpers/fixtures.js';

const start = '2026-10-25T00:00:00.000Z';
const middle = '2026-10-26T00:00:00.000Z';
const end = '2026-10-27T00:00:00.000Z';

function makeHarness() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const state: ExtractorState = { streams: {} };
  const stateStore: StateStore = {
    load: async () => state,
    save: async () => undefined,
  };
  return {
    state,
    stateStore,
    emitter: new Emitter('stdout', 'unused', { stdoutStream: stream }),
    logger: new ControlLogger({ stream, quiet: true }),
    batchDir: 'unused',
    records: () =>
      lines
        .flatMap((line) => line.trim().split('\n'))
        .map((line) => JSON.parse(line) as { type: string; record: Record<string, unknown> })
        .filter((message) => message.type === 'RECORD')
        .map((message) => message.record),
  };
}

function makeContextResource(incremental = false) {
  return makeResource({
    name: 'metrics',
    api: {
      endpoint: '/metrics',
      method: 'POST',
      request_body: {
        project: '${{ input.project_id }}',
        start: '${{ input.window_start }}',
        end: '${{ input.window_end }}',
      },
    },
    input: {
      project_id: { type: 'string', default: 'default-project' },
      query_version: { type: 'string', default: 'recipe-v1' },
      window_start: { type: 'timestamp', default: '2000-01-01T00:00:00.000Z' },
      window_end: { type: 'timestamp', default: '2000-01-02T00:00:00.000Z' },
    },
    output: {
      id: { type: 'integer', path: '$.id' },
      project_id: { type: 'string', from: { input: 'project_id' } },
      query_version: { type: 'string', from: { input: 'query_version' } },
      requested_start: { type: 'timestamp', from: { input: 'window_start' } },
      requested_end: { type: 'timestamp', from: { input: 'window_end' } },
    },
    extract: {
      record_path: '$',
      ...(incremental
        ? {
            incremental: {
              strategy: 'filter' as const,
              cursor_field: 'requested_end',
              cursor_type: 'timestamp' as const,
              since_argument: 'window_start',
              until_argument: 'window_end',
              initial_lookback_seconds: 172800,
              window_size_seconds: 86400,
              value_format: 'iso8601' as const,
            },
          }
        : {}),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('extraction input context', () => {
  it.each([undefined, { project_id: 'caller-project' }])(
    'maps the required input supplied through HTTP where pushdown %j',
    async (inputOverrides) => {
      const fetcher = vi.fn().mockImplementation(async () => new Response('{"id":1}'));
      vi.stubGlobal('fetch', fetcher);
      const integration = makeProvider();
      const harness = makeHarness();
      const resource = makeContextResource();
      resource.input.project_id = { type: 'string', required: true };
      resource.query = {
        filters: {
          project: {
            operators: ['eq'],
            bind: { eq: { input: 'project_id' } },
            compile: { eq: { mode: 'http_query', param: 'project_id' } },
          },
        },
      };
      resource.extract.where = [{ field: 'project', eq: 'pushed-project' }];

      await extractResource({
        ...harness,
        integration,
        resource,
        client: new ExtractorClient({ integration }),
        inputOverrides,
        opts: {},
      });

      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body)).project).toBe('pushed-project');
      expect(harness.records()[0]?.project_id).toBe('pushed-project');
    }
  );

  it('maps required declared cursor inputs from each HTTP page request', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => new Response('{"items":[{"id":50}],"next":"80"}'))
      .mockImplementationOnce(async () => new Response('{"items":[{"id":90}],"next":null}'));
    vi.stubGlobal('fetch', fetcher);
    const integration = makeProvider();
    const harness = makeHarness();
    const resource = makeResource({
      name: 'cursor_items',
      api: { endpoint: '/items', method: 'GET', query_params: { after: '${{ input.after }}' } },
      input: { after: { type: 'integer', required: true } },
      output: {
        id: { type: 'integer', path: '$.id' },
        requested_after: { type: 'integer', from: { input: 'after' } },
      },
      extract: {
        record_path: '$.items',
        pagination: { type: 'cursor', cursor_path: '$.next', cursor_param: 'after' },
        incremental: {
          strategy: 'cursor',
          cursor_field: 'id',
          cursor_type: 'integer',
          cursor_param: 'after',
        },
      },
    });
    harness.state.streams[`${integration.name}/${resource.name}`] = {
      cursor_field: 'id',
      cursor_type: 'integer',
      cursor_value: '40',
      last_run_at: start,
      record_count: 1,
    };

    await extractResource({
      ...harness,
      integration,
      resource,
      client: new ExtractorClient({ integration }),
      opts: {},
    });

    expect(
      fetcher.mock.calls.map((call) => new URL(String(call[0])).searchParams.get('after'))
    ).toEqual(['40', '80']);
    expect(harness.records().map((record) => record.requested_after)).toEqual([40, 80]);
  });

  it('maps server_filter window bounds through declared bind-input aliases', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"id":1}'));
    vi.stubGlobal('fetch', fetcher);
    const integration = makeProvider();
    const harness = makeHarness();
    const resource = makeContextResource(true);
    delete resource.input.window_start;
    delete resource.input.window_end;
    resource.input.api_start = { type: 'timestamp', required: true };
    resource.input.api_end = { type: 'timestamp', required: true };
    resource.api = {
      endpoint: '/metrics',
      method: 'POST',
      request_body: { start: '${{ input.api_start }}', end: '${{ input.api_end }}' },
    };
    resource.output.requested_start = { type: 'timestamp', from: { input: 'api_start' } };
    resource.output.requested_end = { type: 'timestamp', from: { input: 'api_end' } };
    resource.query = {
      filters: {
        requested_end: {
          operators: ['gte', 'lte'],
          bind: { gte: { input: 'api_start' }, lte: { input: 'api_end' } },
          compile: {
            gte: { mode: 'http_query', param: 'api_start' },
            lte: { mode: 'http_query', param: 'api_end' },
          },
        },
      },
    };
    resource.extract.incremental = {
      strategy: 'server_filter',
      cursor_field: 'requested_end',
      cursor_type: 'timestamp',
      since_argument: 'logical_start',
      until_argument: 'logical_end',
      initial_lookback_seconds: 172800,
      window_size_seconds: 86400,
      value_format: 'iso8601',
    };

    await extractResource({
      ...harness,
      integration,
      resource,
      client: new ExtractorClient({ integration }),
      opts: { sinceOverride: start, untilValue: end },
    });

    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies).toEqual([
      { start, end: middle },
      { start: middle, end },
    ]);
    expect(
      harness.records().map((record) => [record.requested_start, record.requested_end])
    ).toEqual(bodies.map((body) => [body.start, body.end]));
  });

  it('preserves client input precedence while resolving defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('{"id":1}'))
    );
    const integration = makeProvider();
    const harness = makeHarness();

    await extractResource({
      ...harness,
      integration,
      resource: makeContextResource(),
      client: new ExtractorClient({
        integration,
        cliInputs: {
          project_id: 'client-project',
          query_version: 'client-recipe',
          sibling_input: 'ignored',
        },
      }),
      inputOverrides: { query_version: 'override-recipe' },
      opts: {},
    });

    expect(harness.records()[0]).toMatchObject({
      project_id: 'client-project',
      query_version: 'override-recipe',
    });
  });

  it.each([undefined, { project_id: 'explicit-project', query_version: 'recipe-v2' }])(
    'maps defaults and explicit inputs from the request tuple %j',
    async (inputOverrides) => {
      const fetcher = vi.fn().mockImplementation(async () => new Response('{"id":1}'));
      vi.stubGlobal('fetch', fetcher);
      const integration = makeProvider();
      const harness = makeHarness();

      await extractResource({
        ...harness,
        integration,
        resource: makeContextResource(),
        client: new ExtractorClient({ integration }),
        inputOverrides,
        inputContext: inputOverrides,
        opts: {},
      });

      const project = inputOverrides?.project_id ?? 'default-project';
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
        project,
        start: '2000-01-01T00:00:00.000Z',
        end: '2000-01-02T00:00:00.000Z',
      });
      expect(harness.records()).toEqual([
        {
          id: 1,
          project_id: project,
          query_version: inputOverrides?.query_version ?? 'recipe-v1',
          requested_start: '2000-01-01T00:00:00.000Z',
          requested_end: '2000-01-02T00:00:00.000Z',
        },
      ]);
    }
  );

  it('maps each generated HTTP window instead of the original dates', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"id":1}'));
    vi.stubGlobal('fetch', fetcher);
    const integration = makeProvider();
    const harness = makeHarness();
    const inputs = {
      project_id: 'project-a',
      query_version: 'recipe-v1',
      window_start: start,
      window_end: end,
    };

    await extractResource({
      ...harness,
      integration,
      resource: makeContextResource(true),
      client: new ExtractorClient({ integration }),
      inputOverrides: inputs,
      inputContext: inputs,
      opts: { sinceOverride: start, untilValue: end },
    });

    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(bodies).toEqual([
      { project: 'project-a', start, end: middle },
      { project: 'project-a', start: middle, end },
    ]);
    expect(
      harness.records().map((record) => [record.requested_start, record.requested_end])
    ).toEqual(bodies.map((body) => [body.start, body.end]));
    expect(harness.records().map((record) => record.query_version)).toEqual([
      'recipe-v1',
      'recipe-v1',
    ]);
    expect(inputs).toEqual({
      project_id: 'project-a',
      query_version: 'recipe-v1',
      window_start: start,
      window_end: end,
    });
  });

  it('uses the same generated inputs for MCP templates and output mapping', async () => {
    const integration: ApiIntegrationSpec = {
      ...makeProvider(),
      transport: { type: 'mcp_http', url: 'https://api.example.com/mcp', auth: { type: 'none' } },
    };
    const client = new McpExtractorClient({ integration });
    vi.spyOn(client, 'connect').mockResolvedValue();
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { id: 1 }, content: [] });
    (client as unknown as { client: { callTool: typeof callTool } }).client.callTool = callTool;
    const harness = makeHarness();
    const httpResource = makeContextResource(true);
    const { api: _api, ...resource } = httpResource;

    await extractResource({
      ...harness,
      integration,
      resource: {
        ...resource,
        tool: {
          tool_name: 'metrics',
          arguments: {
            project: '${{ input.project_id }}',
            range: { start: '${{ input.window_start }}', end: '${{ input.window_end }}' },
          },
        },
      },
      client,
      inputOverrides: { project_id: 'project-mcp' },
      inputContext: { project_id: 'project-mcp' },
      opts: { sinceOverride: start, untilValue: end },
    });

    expect(callTool.mock.calls.map((call) => call[0].arguments.range)).toEqual([
      { start, end: middle },
      { start: middle, end },
    ]);
    expect(
      harness.records().map((record) => [record.requested_start, record.requested_end])
    ).toEqual([
      [start, middle],
      [middle, end],
    ]);
  });

  it('keeps default metadata and window context isolated across for_each projects', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"id":1}'));
    vi.stubGlobal('fetch', fetcher);
    const integration = makeProvider();
    const client = new ExtractorClient({ integration });
    const harness = makeHarness();
    const resource = makeContextResource(true);
    resource.extract.for_each = {
      resource: 'projects',
      field: 'id',
      input: 'project_id',
      concurrency: 2,
    };

    await extractResourcesWithMatrices({
      ...harness,
      sortedResources: [{ spec: resource, warnings: [], filePath: 'resources/metrics.yml' }],
      integrationName: integration.name,
      integration,
      clientPool: {
        getForResource: async () => ({ integration, client }),
      } as unknown as TransportClientPool,
      circuitBreaker: new ResourceCircuitBreaker(),
      opts: { sinceOverride: start, untilValue: end },
      cliInputs: {},
      resourceInputsMap: undefined,
      forEachCache: new Map([
        [
          'projects',
          ['project-a', 'project-b'].map((id) => ({
            input: {},
            output: { id },
            context: EMPTY_FAN_OUT_CONTEXT,
          })),
        ],
      ]),
      parentResources: new Set(),
      presentResources: new Set(['projects', resource.name]),
      runStartedAt: new Date(end),
      isTimedOut: () => false,
      defaultSchemaBehavior: undefined,
      embedConfigFromFile: undefined,
      resourceResults: [],
    });

    expect(harness.records()).toHaveLength(4);
    for (const project of ['project-a', 'project-b']) {
      expect(
        harness
          .records()
          .filter((record) => record.project_id === project)
          .map((record) => [record.requested_start, record.requested_end])
      ).toEqual([
        [start, middle],
        [middle, end],
      ]);
    }
    expect(harness.records().every((record) => record.query_version === 'recipe-v1')).toBe(true);
  });

  describe.each(['http', 'mcp'] as const)('env references in %s input defaults', (transport) => {
    const sentinel = 'env-sentinel-7f3a9c';
    const envReference = '${{ env.DOGSLED_TEST_TOKEN }}';
    const env = { DOGSLED_TEST_TOKEN: sentinel };

    async function runWithDefault(input: 'project_id' | 'query_version') {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => new Response('{"id":1}'))
      );
      const harness = makeHarness();
      const resource = makeContextResource();
      resource.input[input] = { type: 'string', default: envReference };
      const httpIntegration = makeProvider('https://api.example.com', {
        auth_env_vars: ['DOGSLED_TEST_TOKEN'],
      });
      if (transport === 'http') {
        await extractResource({
          ...harness,
          integration: httpIntegration,
          resource,
          client: new ExtractorClient({ integration: httpIntegration, env, secrets: env }),
          opts: {},
        });
        return harness.records();
      }
      const integration: ApiIntegrationSpec = {
        ...httpIntegration,
        transport: { type: 'mcp_http', url: 'https://api.example.com/mcp', auth: { type: 'none' } },
      };
      const client = new McpExtractorClient({ integration, env, secrets: env });
      vi.spyOn(client, 'connect').mockResolvedValue();
      const callTool = vi.fn().mockResolvedValue({ structuredContent: { id: 1 }, content: [] });
      (client as unknown as { client: { callTool: typeof callTool } }).client.callTool = callTool;
      const { api: _api, ...rest } = resource;
      await extractResource({
        ...harness,
        integration,
        resource: {
          ...rest,
          tool: { tool_name: 'metrics', arguments: { project: '${{ input.project_id }}' } },
        },
        client,
        opts: {},
      });
      return harness.records();
    }

    it('rejects the request when a templated input default is env-referencing', async () => {
      await expect(runWithDefault('project_id')).rejects.toThrow(
        'Dogsled could not validate the request.'
      );
    });

    it('copies an untemplated env-referencing default only as the literal reference', async () => {
      const records = await runWithDefault('query_version');
      expect(records).toHaveLength(1);
      expect(records[0]?.query_version).toBe(envReference);
      expect(JSON.stringify(records)).not.toContain(sentinel);
    });
  });
});
