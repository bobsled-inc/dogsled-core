import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const getIntegrationMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/runtime/workspace.js', () => ({
  resolveCliInvocation: vi.fn((target: string, _metaUrl: string, args: string[]) => ({
    command: `${target}-cli`,
    args,
  })),
}));

vi.mock('@bobsled-inc/integrations', () => ({
  getIntegrationsDir: vi.fn(() => '/mock/integrations'),
  // Minimal stubs so loadIntegrationsLib in @bobsled-inc/dogsled succeeds and
  // resolveEntityVariant has something to look up. Only linear is modeled —
  // existing tests that use strict-name resources (e.g. cycles_mcp) hit
  // resource_names directly and never need entity resolution.
  getIntegration: getIntegrationMock.mockImplementation((name: string) => {
    if (name === 'linear') {
      return {
        meta: { auth_setup: [] },
        resource_names: [
          'cycles_graphql',
          'cycles_mcp',
          'teams_graphql',
          'teams_mcp',
          'issues_graphql',
          'issues_mcp',
        ],
        spec: {
          transports: [{ id: 'graphql' }, { id: 'mcp' }],
          default_transport: 'graphql',
        },
      };
    }
    return {
      meta: { auth_setup: [] },
      resource_names: ['issues', 'pull_requests', 'charges', 'customers', 'repos'],
      spec: { transports: [{ id: 'rest' }], default_transport: 'rest' },
    };
  }),
  getResources: vi.fn((name: string) =>
    name === 'linear'
      ? [
          {
            resource: {
              name: 'cycles_mcp',
              extract: { for_each: { resource: 'teams_mcp', field: 'id', as: 'teamId' } },
            },
          },
        ]
      : [
          {
            resource: {
              name: 'issues',
              output: { name: { embedding_candidate: true } },
              input: {
                repo: { type: 'string' },
                state: { type: 'string' },
                per_page: { type: 'integer' },
              },
            },
          },
          {
            resource: {
              name: 'pull_requests',
              extract: { for_each: { resource: 'issues', field: 'id', as: 'issueId' } },
              input: {
                state: { type: 'string' },
              },
            },
          },
        ]
  ),
  listEntities: vi.fn((name: string) => {
    if (name === 'linear') return ['cycles', 'teams', 'issues'];
    return [];
  }),
  getEntityVariants: vi.fn((name: string, entity: string) => {
    if (name === 'linear' && entity === 'cycles') {
      return [
        { name: 'cycles_graphql', via: 'graphql' },
        { name: 'cycles_mcp', via: 'mcp' },
      ];
    }
    if (name === 'linear' && entity === 'teams') {
      return [
        { name: 'teams_graphql', via: 'graphql' },
        { name: 'teams_mcp', via: 'mcp' },
      ];
    }
    if (name === 'linear' && entity === 'issues') {
      return [
        { name: 'issues_graphql', via: 'graphql' },
        { name: 'issues_mcp', via: 'mcp' },
      ];
    }
    return [];
  }),
}));

// Project validation now consumes the metadata-only public catalog instead of
// dynamically importing the integrations package root. Adapt this test's
// deliberately small integration fixture at that public boundary so pipeline
// execution assertions stay isolated from the full built-in GitHub fan-out.
vi.mock('../../../src/validation.js', async () => {
  const integrations = await import('@bobsled-inc/integrations');
  return {
    BUILT_IN_VALIDATION_CATALOG: {
      getIntegration(name: string) {
        const source = integrations.getIntegration(name);
        return {
          meta: source.meta,
          resource_names: source.resource_names,
          transports: source.spec.transports,
          default_transport: source.spec.default_transport,
        };
      },
      getResources: integrations.getResources,
      listEntities: integrations.listEntities,
      getEntityVariants: integrations.getEntityVariants,
    },
  };
});

vi.mock('@bobsled-inc/embedder', async () => {
  const { z } = await import('zod');
  return {
    EmbedderConfigSchema: z.object({
      provider: z.string(),
      model: z.string(),
      api_key: z.string().optional(),
      streams: z.record(z.string(), z.array(z.object({ field: z.string() }))),
    }),
  };
});

import {
  runProjectPipeline,
  type PipelineRunEvent,
  type PipelineRunProjectResolver,
} from '../../../src/pipeline/index.js';
import { buildPipelineExtractArgs } from '../../../src/commands/pipeline-extract-args.js';

import type { ChildProcess } from 'node:child_process';
import type { Mock } from 'vitest';

function createMockChild(
  options: {
    stdin?: PassThrough | null;
    stderr?: PassThrough | null;
    stdout?: PassThrough | null;
  } = {}
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = options.stdin ?? null;
  child.stdout = options.stdout ?? null;
  child.stderr = options.stderr ?? null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

async function waitForSpawns(spawn: Mock, count = 2) {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(count));
}

function parseResourceInputsArg(args: string[]): unknown {
  const index = args.indexOf('--resource-inputs-json');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBeDefined();
  return JSON.parse(args[index + 1]!);
}

function parseResourceInputMatricesArg(args: string[]): unknown {
  const index = args.indexOf('--resource-input-matrices-json');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBeDefined();
  return JSON.parse(args[index + 1]!);
}

function parseResourceInputMatrixConcurrencyArg(args: string[]): unknown {
  const index = args.indexOf('--resource-input-matrix-concurrency-json');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBeDefined();
  return JSON.parse(args[index + 1]!);
}

function makeProject(dogsledYml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-project-'));
  fs.writeFileSync(path.join(dir, 'dogsled.yml'), dogsledYml, 'utf8');
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runProjectPipeline', () => {
  it('serializes deterministic per-resource input matrices for the extractor', () => {
    const args = buildPipelineExtractArgs(
      ['historical_outrights'],
      {
        integration: 'datagolf',
        resourceInputMatrices: {
          historical_outrights: [
            { tour: 'pga', year: 2025 },
            { tour: 'euro', year: 2024 },
          ],
        },
        resourceInputMatrixConcurrency: { historical_outrights: 2 },
      },
      undefined,
      false,
      {}
    );

    expect(parseResourceInputMatricesArg(args)).toEqual({
      historical_outrights: [
        { tour: 'pga', year: 2025 },
        { tour: 'euro', year: 2024 },
      ],
    });
    expect(parseResourceInputMatrixConcurrencyArg(args)).toEqual({
      historical_outrights: 2,
    });
  });

  it('uses the canonical project resolver when no resolver dependency is supplied', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    getIntegrationMock.mockClear();

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    expect(getIntegrationMock).toHaveBeenCalledWith('github');
  });

  it('runs a pipeline from a nested fragment when rooted above golf/datagolf/pga', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-nested-pipeline-'));
    tempDirs.push(projectRoot);
    const fragmentPath = path.join(projectRoot, 'golf', 'datagolf', 'pga', 'pipelines.yml');
    fs.mkdirSync(path.dirname(fragmentPath), { recursive: true });
    fs.writeFileSync(
      fragmentPath,
      `type: pipeline_config\ndestinations:\n  warehouse:\n    type: local\n    format: jsonl\npipelines:\n  pga_events:\n    schedule: daily\n    source: github\n    destination: warehouse\n    resources: [issues]\n`,
      'utf8'
    );

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'pga_events' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: projectRoot });
    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['run', 'issues', '--integration', 'github'])
    );
  });

  it.each([
    [
      'clickhouse',
      `destinations:
  warehouse:
    auth_env_vars: [CLICKHOUSE_PASSWORD]
    type: clickhouse
    host: ch.example.com
    database: analytics
    password: $CLICKHOUSE_PASSWORD
    ssl: true
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`,
      { CLICKHOUSE_PASSWORD: 'resolved-clickhouse-password' },
      ['--dest', 'clickhouse', '--clickhouse-host', 'ch.example.com', '--clickhouse-ssl'],
      'resolved-clickhouse-password',
    ],
    [
      'turbopuffer',
      `destinations:
  search:
    auth_env_vars: [TURBOPUFFER_API_KEY]
    type: turbopuffer
    api_key: $TURBOPUFFER_API_KEY
    region: gcp-us-central1
pipelines:
  github:
    schedule: daily
    source: github
    destination: search
    resources: [issues]
`,
      { TURBOPUFFER_API_KEY: 'resolved-turbopuffer-key' },
      ['--dest', 'turbopuffer', '--turbopuffer-region', 'gcp-us-central1'],
      'resolved-turbopuffer-key',
    ],
  ] as const)(
    'resolves %s single-destination fields before spawning the loader',
    async (_name, yaml, env, expectedArgs, resolvedSecret) => {
      const projectRoot = makeProject(yaml);
      tempDirs.push(projectRoot);
      const extractChild = createMockChild({ stdout: new PassThrough() });
      const loadChild = createMockChild({ stdin: new PassThrough() });
      const spawn = vi
        .fn()
        .mockReturnValueOnce(extractChild)
        .mockReturnValueOnce(loadChild) as Mock;

      const promise = runProjectPipeline(
        { projectRoot, pipelineName: 'github', env },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      );

      await waitForSpawns(spawn);
      extractChild.emit('close', 0);
      loadChild.emit('close', 0);
      await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

      const loadArgs = spawn.mock.calls[1]?.[1] as string[];
      expect(loadArgs).toEqual(expect.arrayContaining(expectedArgs));
      expect(loadArgs).not.toContain(resolvedSecret);
      const envName =
        _name === 'clickhouse'
          ? 'DOGSLED_LOADER_CLICKHOUSE_PASSWORD'
          : 'DOGSLED_LOADER_TURBOPUFFER_API_KEY';
      expect(loadArgs).toContain('$' + envName);
      expect(spawn.mock.calls[1]?.[2].env[envName]).toBe(resolvedSecret);
    }
  );

  it('rejects an unmaterialized managed destination before spawning a pipeline', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: dogsled_managed
    dogsled_connection_ref: warehouse-prod
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github' },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow('A "dogsled_managed" destination only runs in Dogsled Cloud.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses an injected project resolver for orchestrator-materialized sources', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  private_warehouse:
    schedule: manual
    source: warehouse_private
    destination: warehouse
    resources: [events]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const resolvePipeline = vi.fn().mockResolvedValue({
      config: {
        destinations: { warehouse: { type: 'local', format: 'jsonl' } },
        pipelines: {
          private_warehouse: {
            schedule: 'manual',
            source: 'warehouse_private',
            destination: 'warehouse',
            resources: ['events'],
          },
        },
      },
      projectRoot,
      pipeline: {
        name: 'private_warehouse',
        schedule: 'manual',
        cron: null,
        trigger: 'manual',
        source: 'warehouse_private',
        destinationNames: ['warehouse'],
        resources: [{ name: 'events' }],
        tablePrefix: '',
        enabled: true,
        runner: 'github-actions',
      },
      warnings: [],
    });
    getIntegrationMock.mockClear();

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'private_warehouse' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, resolvePipeline }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    expect(resolvePipeline).toHaveBeenCalledOnce();
    expect(resolvePipeline).toHaveBeenCalledWith(
      { projectRoot, pipelineName: 'private_warehouse' },
      expect.any(Function)
    );
    expect(getIntegrationMock).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['run', 'events', '--integration', 'warehouse_private'])
    );
  });

  it('keeps trusted source and destination Snowflake warehouses independent', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  private_warehouse:
    schedule: manual
    source: warehouse_private
    destination: warehouse
    resources: [events]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const resolvePipeline = vi.fn().mockResolvedValue({
      config: {
        destinations: {
          warehouse: {
            type: 'snowflake',
            account: 'acct',
            username: 'loader',
            password: 'secret',
            warehouse: 'destination_default',
            database: 'RAW',
          },
        },
        pipelines: {},
      },
      projectRoot,
      pipeline: {
        name: 'private_warehouse',
        schedule: 'manual',
        cron: null,
        trigger: 'manual',
        source: 'warehouse_private',
        destinationNames: ['warehouse'],
        resources: [{ name: 'events' }],
        tablePrefix: '',
        enabled: true,
        runner: 'github-actions',
        warehouse: 'pipeline_default',
      },
      warnings: [],
    });

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'private_warehouse',
        warehouse: 'managed_large',
        destinationWarehouse: 'LOAD_MEDIUM',
        queryTag: 'managed:run-42',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, resolvePipeline }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).toEqual(
      expect.arrayContaining(['--warehouse', 'managed_large', '--query-tag', 'managed:run-42'])
    );
    expect(extractArgs).not.toContain('pipeline_default');
    expect(loadArgs).toEqual(
      expect.arrayContaining(['--sf-warehouse', 'LOAD_MEDIUM', '--query-tag', 'managed:run-42'])
    );
    expect(loadArgs).not.toContain('managed_large');
    expect(loadArgs).not.toContain('destination_default');
  });

  it.each([
    ['non-Snowflake', ['warehouse']],
    ['multiple', ['first', 'second']],
  ])(
    'rejects a destination warehouse override for %s destinations before spawning',
    async (_, names) => {
      const projectRoot = makeProject(
        `destinations:\n  warehouse:\n    type: local\n    format: jsonl\npipelines:\n  sync:\n    schedule: manual\n    source: posthog\n    destination: warehouse\n    resources: [events]\n`
      );
      tempDirs.push(projectRoot);
      const spawn = vi.fn() as Mock;
      const destinations = Object.fromEntries(
        names.map((name) => [name, { type: 'local' as const, format: 'jsonl' as const }])
      );
      const resolvePipeline = vi.fn().mockResolvedValue({
        config: { destinations, pipelines: {} },
        projectRoot,
        pipeline: {
          name: 'sync',
          schedule: 'manual',
          cron: null,
          trigger: 'manual',
          source: 'posthog',
          destinationNames: names,
          resources: [{ name: 'events' }],
          tablePrefix: '',
          enabled: true,
          runner: 'managed',
        },
        warnings: [],
      });

      await expect(
        runProjectPipeline(
          { projectRoot, pipelineName: 'sync', destinationWarehouse: 'LOAD_MEDIUM' },
          { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, resolvePipeline }
        )
      ).rejects.toThrow(/singular materialized Snowflake destination/);
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects an unsafe managed query tag before spawning pipeline children', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  private_warehouse:
    schedule: manual
    source: warehouse_private
    destination: warehouse
    resources: [events]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;
    const resolvePipeline = vi.fn().mockResolvedValue({
      config: { destinations: { warehouse: { type: 'local', format: 'jsonl' } }, pipelines: {} },
      projectRoot,
      pipeline: {
        name: 'private_warehouse',
        schedule: 'manual',
        cron: null,
        trigger: 'manual',
        source: 'warehouse_private',
        destinationNames: ['warehouse'],
        resources: [{ name: 'events' }],
        tablePrefix: '',
        enabled: true,
        runner: 'managed',
      },
      warnings: [],
    });

    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'private_warehouse',
          queryTag: 'unsafe\nmetadata',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, resolvePipeline }
      )
    ).rejects.toThrow(/control characters/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('lets an injected resolver delegate bundled sources to the canonical resolver', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const resolvePipeline = vi.fn<PipelineRunProjectResolver>((options, resolveDefault) =>
      resolveDefault(options)
    );
    getIntegrationMock.mockClear();

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn, resolvePipeline }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    expect(resolvePipeline).toHaveBeenCalledOnce();
    expect(getIntegrationMock).toHaveBeenCalledWith('github');
  });

  it('runs a named pipeline from a project root with invocation-local env + cwd', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [SF_PASSWORD]
    type: snowflake
    account: demo
    username: demo_user
    password: \${{ env.SF_PASSWORD }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
        env: { SF_PASSWORD: 'secret-password' },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: projectRoot,
      env: expect.objectContaining({
        SF_PASSWORD: 'secret-password',
        DOGSLED_BUNDLED_INTEGRATIONS_DIR: '/mock/integrations',
      }),
    });
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({
      cwd: projectRoot,
      env: expect.objectContaining({
        SF_PASSWORD: 'secret-password',
        DOGSLED_LOADER_SF_PASSWORD: 'secret-password',
      }),
    });
    expect(spawn.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['--sf-password', '$DOGSLED_LOADER_SF_PASSWORD'])
    );
  });

  it('resolves Snowflake static and command OIDC fields for a single destination', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [SF_OIDC_TOKEN, SF_OIDC_TOKEN_COMMAND]
    type: snowflake
    account: demo
    username: demo_user
    credentials_access_token: \${{ env.SF_OIDC_TOKEN }}
    credentials_token_command: \${{ env.SF_OIDC_TOKEN_COMMAND }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
        env: {
          SF_OIDC_TOKEN: 'jwt-static',
          SF_OIDC_TOKEN_COMMAND: 'mint-snowflake-token --json',
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toEqual(
      expect.arrayContaining([
        '--sf-token-command',
        'mint-snowflake-token --json',
        '--sf-warehouse',
        'demo_wh',
      ])
    );
    expect(loadArgs).not.toContain('--sf-access-token');
  });

  it('transports a resolved Snowflake workload identity token for a named destination', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [VERCEL_OIDC_TOKEN]
    type: snowflake
    account: demo
    username: demo_user
    credentials_workload_identity_token: \${{ env.VERCEL_OIDC_TOKEN }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
        env: { VERCEL_OIDC_TOKEN: 'vercel-oidc-token' },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    const loadOptions = spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(loadArgs).toContain('--sf-workload-identity-token');
    expect(loadArgs).toContain('$DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(loadArgs).not.toContain('vercel-oidc-token');
    expect(loadOptions.env).toMatchObject({
      DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'vercel-oidc-token',
    });
  });

  it('rejects a blank named-config workload identity token before spawning or falling back', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [VERCEL_OIDC_TOKEN]
    type: snowflake
    account: demo
    username: demo_user
    credentials_workload_identity_token: \${{ env.VERCEL_OIDC_TOKEN }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn(() => {
      throw new Error('spawn observed');
    }) as Mock;

    const result = await runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
        env: { VERCEL_OIDC_TOKEN: '  \t' },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    expect(result.status).toBe('failure');
    expect(result.errors[0]?.message).toMatch(/workload identity token.*non-empty/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('redacts a workload identity token from named-pipeline failures', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [VERCEL_OIDC_TOKEN]
    type: snowflake
    account: demo
    username: demo_user
    credentials_workload_identity_token: \${{ env.VERCEL_OIDC_TOKEN }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockImplementationOnce(() => {
        throw new Error('loader failed with vercel-oidc-token');
      }) as Mock;
    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
        env: { VERCEL_OIDC_TOKEN: 'vercel-oidc-token' },
      },
      {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);

    const result = await promise;
    expect(JSON.stringify(result)).not.toContain('vercel-oidc-token');
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'RUNTIME_ERROR',
        message: 'loader failed with [REDACTED]',
      }),
    ]);
  });

  it('honors explicit resources + full refresh flags', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues, pull_requests]
`);
    tempDirs.push(projectRoot);

    const extractStderr = new PassThrough();
    const loadStderr = new PassThrough();
    const extractChild = createMockChild({ stdout: new PassThrough(), stderr: extractStderr });
    const loadChild = createMockChild({ stdin: new PassThrough(), stderr: loadStderr });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        resources: ['issues'],
        fullRefresh: true,
        logFormat: 'json',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['run', 'issues', '--integration', 'github', '--full-refresh'])
    );
  });

  it('forwards reconciliation through the public runner and overrides a destination strategy', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    auth_env_vars: [SF_PASSWORD]
    type: snowflake
    account: demo
    username: demo_user
    password: \${{ env.SF_PASSWORD }}
    warehouse: demo_wh
    database: analytics
    load_strategy: append
pipelines:
  linear:
    schedule: daily
    source: linear
    via: mcp
    destination: warehouse
    resources: [issues, teams]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'linear',
        resources: ['issues'],
        fullRefresh: true,
        reconcileSchema: ['issues'],
        env: { SF_PASSWORD: 'secret-password' },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['run', 'issues_mcp', '--full-refresh']));
    expect(loadArgs).toEqual(
      expect.arrayContaining([
        '--reconcile-schema',
        'issues_mcp',
        '--load-strategy',
        'full_refresh',
      ])
    );
    expect(loadArgs).not.toContain('append');
    expect(loadArgs).not.toContain('issues');
  });

  it('rejects reconciliation without full refresh before spawning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github', reconcileSchema: ['issues'] },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/--reconcile-schema requires fullRefresh: true/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an unselected reconciliation stream before spawning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: snowflake
    account: demo
    username: demo_user
    warehouse: demo_wh
    database: analytics
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues, pull_requests]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'github',
          resources: ['issues'],
          fullRefresh: true,
          reconcileSchema: ['pull_requests'],
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/must be included in the selected resources: pull_requests/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects reconciliation on non-Snowflake destinations before spawning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github', fullRefresh: true, reconcileSchema: ['issues'] },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/--reconcile-schema is only supported for Snowflake destinations/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects reconciliation for mixed fan-out destinations before spawning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: snowflake
    account: demo
    username: demo_user
    warehouse: demo_wh
    database: analytics
  archive:
    type: duckdb
    db_path: ./archive.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destinations: [warehouse, archive]
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github', fullRefresh: true, reconcileSchema: ['issues'] },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/Unsupported destination\(s\): archive/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('serializes scalar array pipeline inputs as comma-separated extractor input values', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    inputs:
      org: bobsled-inc
      repo_names: [dogsled, demo-repo]
    resources: [repos]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['--input', 'repo_names=dogsled,demo-repo'])
    );
  });

  it('rejects array pipeline inputs whose entries contain the comma delimiter', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    inputs:
      repo_names: ['has,comma', other-repo]
    resources: [repos]
`);
    tempDirs.push(projectRoot);

    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'github',
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/contains a comma/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('forwards a per-resource load_strategy override to the loader', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
    load_strategy: full_refresh
    schema_behavior: freeze
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    load_strategy: append
    schema_behavior: evolve
    resources:
      - resource: issues
        load_strategy: merge
        schema_behavior: strict
      - pull_requests
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    // Pipeline-level defaults beat destination settings; per-stream flags win
    // over both defaults in the loader.
    expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'append']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--schema-behavior', 'evolve']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-load-strategy', 'issues:merge']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-schema-behavior', 'issues:strict']));
    expect(loadArgs.filter((arg) => arg === '--stream-load-strategy')).toHaveLength(1);
    expect(loadArgs.filter((arg) => arg === '--stream-schema-behavior')).toHaveLength(1);
    expect(loadArgs).not.toContain('--stream-table');
  });

  it('forwards a destination schema_behavior when the pipeline omits one', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
    load_strategy: merge
    schema_behavior: strict
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'merge']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--schema-behavior', 'strict']));
  });

  it('omits schema behavior flags when neither pipeline nor destination declares one', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).not.toContain('--schema-behavior');
    expect(loadArgs).not.toContain('--stream-schema-behavior');
  });

  it('makes full refresh override pipeline and per-resource load strategies', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    load_strategy: append
    resources:
      - resource: issues
        load_strategy: merge
      - pull_requests
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github', fullRefresh: true },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).toContain('--full-refresh');
    expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'full_refresh']));
    expect(loadArgs).not.toContain('--stream-load-strategy');
  });

  it('forwards a per-resource table override to the loader', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    table_prefix: github__
    resources:
      - resource: issues
        table: raw_github__issues_v2
      - pull_requests
`);
    tempDirs.push(projectRoot);

    const extractStderr = new PassThrough();
    const loadStderr = new PassThrough();
    const extractChild = createMockChild({ stdout: new PassThrough(), stderr: extractStderr });
    const loadChild = createMockChild({ stdin: new PassThrough(), stderr: loadStderr });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractStderr.end(
      '{"_v":1,"type":"METRIC","stream":"issues","metrics":{"records_emitted":2}}\n'
    );
    loadStderr.end(
      '{"level":"info","event":"raw_github__issues_v2: loaded 2 rows","stream":"issues","rowsAffected":2,"loadMs":3}\n'
    );
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({
      exitCode: 0,
      status: 'success',
      metrics: {
        totalRowsLoaded: 2,
        resources: { issues: { rowsLoaded: 2 } },
      },
    });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toEqual(expect.arrayContaining(['--table-prefix', 'github__']));
    expect(loadArgs).toEqual(
      expect.arrayContaining(['--stream-table', 'issues:raw_github__issues_v2'])
    );
    expect(loadArgs.filter((arg) => arg === '--stream-table')).toHaveLength(1);
  });

  it('forwards a reserved Snowflake table and ownership marker together', async () => {
    const projectRoot = makeProject(`destinations:
  staging:
    auth_env_vars: [SF_PASSWORD]
    type: snowflake
    account: demo
    username: demo_user
    password: $SF_PASSWORD
    warehouse: demo_wh
    database: analytics
    schema: ATTACHMENT_STAGING
pipelines:
  attachment:
    schedule: manual
    source: github
    destination: staging
    resources:
      - resource: issues
        table: STAGED_012345
        table_ownership_marker: temp-dataset-012345
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'attachment', env: { SF_PASSWORD: 'test-password' } },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(loadArgs).toEqual(expect.arrayContaining(['--target-schema', 'ATTACHMENT_STAGING']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-table', 'issues:STAGED_012345']));
    expect(loadArgs).toEqual(
      expect.arrayContaining(['--stream-table-ownership-marker', 'issues:temp-dataset-012345'])
    );
  });

  it('forwards per-resource inputs to the extractor as a JSON payload', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    inputs:
      org: bobsled-inc
    resources:
      - resource: issues
        inputs:
          repo: 'dogsled:demo=1,part'
          state: closed
          per_page: 50
      - pull_requests
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    // Pipeline-wide inputs keep the key=value flag; per-resource inputs ride a
    // JSON envelope so `:`, `=`, and `,` in a scalar value survive intact.
    expect(extractArgs).toEqual(expect.arrayContaining(['--input', 'org=bobsled-inc']));
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      issues: {
        repo: 'dogsled:demo=1,part',
        state: 'closed',
        per_page: '50',
      },
    });
  });

  it('forwards via, load_strategy, table, and inputs overrides together', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        via: rest
        load_strategy: full_refresh
        table: raw_issues
        inputs: { state: closed }
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['--resource-via', 'issues:rest']));
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      issues: { state: 'closed' },
    });
    expect(loadArgs).toEqual(
      expect.arrayContaining(['--stream-load-strategy', 'issues:full_refresh'])
    );
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-table', 'issues:raw_issues']));
  });

  it('keeps different overrides on sibling resources isolated', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        load_strategy: merge
        table: raw_issues
        inputs: { state: open }
      - resource: pull_requests
        load_strategy: full_refresh
        table: raw_prs
        inputs: { state: closed }
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    // Each resource keeps its own input value — no cross-contamination.
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      issues: { state: 'open' },
      pull_requests: { state: 'closed' },
    });
    expect(loadArgs).toEqual(
      expect.arrayContaining([
        '--stream-load-strategy',
        'issues:merge',
        '--stream-load-strategy',
        'pull_requests:full_refresh',
      ])
    );
    expect(loadArgs).toEqual(
      expect.arrayContaining([
        '--stream-table',
        'issues:raw_issues',
        '--stream-table',
        'pull_requests:raw_prs',
      ])
    );
  });

  it('forwards only the selected resource overrides when the run is narrowed', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        load_strategy: merge
        table: raw_issues
        inputs: { state: open }
      - resource: pull_requests
        load_strategy: full_refresh
        table: raw_prs
        inputs: { state: closed }
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github', resources: ['issues'] },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      issues: { state: 'open' },
    });
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-load-strategy', 'issues:merge']));
    expect(loadArgs.join(' ')).not.toContain('pull_requests');
  });

  it('keys per-resource overrides by the resolved variant name', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    via: mcp
    resources:
      - resource: cycles
        load_strategy: merge
        table: raw_cycles
        inputs: { type: previous }
      - teams
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'linear' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['run', 'cycles_mcp', 'teams_mcp']));
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      cycles_mcp: { type: 'previous' },
    });
    expect(loadArgs).toEqual(
      expect.arrayContaining(['--stream-load-strategy', 'cycles_mcp:merge'])
    );
    expect(loadArgs).toEqual(expect.arrayContaining(['--stream-table', 'cycles_mcp:raw_cycles']));
  });

  it('emits no per-resource flags when every resource uses pipeline-level defaults', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    load_strategy: merge
    table_prefix: github__
    inputs: { org: bobsled-inc }
    resources: [issues, pull_requests]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const loadArgs = spawn.mock.calls[1]?.[1] as string[];
    expect(extractArgs).not.toContain('--resource-inputs-json');
    expect(extractArgs).toEqual(expect.arrayContaining(['--input', 'org=bobsled-inc']));
    expect(loadArgs).not.toContain('--stream-load-strategy');
    expect(loadArgs).not.toContain('--stream-table');
    expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'merge']));
    expect(loadArgs).toEqual(expect.arrayContaining(['--table-prefix', 'github__']));
  });

  it('forwards per-resource overrides to every fan-out destination', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
    load_strategy: append
    schema_behavior: freeze
  archive:
    type: duckdb
    db_path: ./archive.duckdb
    table_prefix: archive__
    load_strategy: full_refresh
    schema_behavior: evolve
pipelines:
  github:
    schedule: daily
    source: github
    destinations: [warehouse, archive]
    load_strategy: merge
    schema_behavior: strict
    resources:
      - resource: issues
        load_strategy: full_refresh
        schema_behavior: freeze
        table: raw_issues
`);
    tempDirs.push(projectRoot);

    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneStderr = new PassThrough();
    const loadTwoStderr = new PassThrough();
    const loadOneChild = createMockChild({ stdin: new PassThrough(), stderr: loadOneStderr });
    const loadTwoChild = createMockChild({ stdin: new PassThrough(), stderr: loadTwoStderr });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end('{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":1}}\n');
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 3);
    loadOneStderr.write(
      '{"level":"info","event":"raw_issues: loaded 1 rows","stream":"issues","rowsAffected":1,"loadMs":2}\n'
    );
    loadTwoStderr.write(
      '{"level":"info","event":"raw_issues: loaded 1 rows","stream":"issues","rowsAffected":1,"loadMs":2}\n'
    );
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);
    await waitForSpawns(spawn, 4);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({
      exitCode: 0,
      status: 'success',
      metrics: {
        totalRowsLoaded: 2,
        resources: { issues: { rowsLoaded: 2 } },
      },
    });
    loadOneStderr.end();
    loadTwoStderr.end();
    for (const call of [1, 2]) {
      const loadArgs = spawn.mock.calls[call]?.[1] as string[];
      expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'merge']));
      expect(loadArgs).toEqual(expect.arrayContaining(['--schema-behavior', 'strict']));
      expect(loadArgs).toEqual(
        expect.arrayContaining(['--stream-load-strategy', 'issues:full_refresh'])
      );
      expect(loadArgs).toEqual(
        expect.arrayContaining(['--stream-schema-behavior', 'issues:freeze'])
      );
      expect(loadArgs).toEqual(expect.arrayContaining(['--stream-table', 'issues:raw_issues']));
    }
  });

  it('serializes Snowflake OIDC fields for every multi-destination loader', async () => {
    const projectRoot = makeProject(`destinations:
  static_warehouse:
    auth_env_vars: [SF_STATIC_TOKEN]
    type: snowflake
    account: demo
    username: demo_user
    credentials_access_token: \${{ env.SF_STATIC_TOKEN }}
    warehouse: demo_wh
    database: analytics
  refresh_warehouse:
    auth_env_vars: [SF_STATIC_TOKEN, SF_TOKEN_COMMAND]
    type: snowflake
    account: demo
    username: demo_user
    credentials_access_token: \${{ env.SF_STATIC_TOKEN }}
    credentials_token_command: \${{ env.SF_TOKEN_COMMAND }}
    warehouse: demo_wh
    database: analytics
  workload_identity_warehouse:
    auth_env_vars: [SF_WIF_TOKEN]
    type: snowflake
    account: demo
    username: demo_user
    credentials_workload_identity_token: \${{ env.SF_WIF_TOKEN }}
    warehouse: demo_wh
    database: analytics
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destinations: [static_warehouse, refresh_warehouse, workload_identity_warehouse]
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const staticLoadChild = createMockChild({ stdin: new PassThrough() });
    const refreshLoadChild = createMockChild({ stdin: new PassThrough() });
    const workloadIdentityLoadChild = createMockChild({ stdin: new PassThrough() });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(staticLoadChild)
      .mockReturnValueOnce(refreshLoadChild)
      .mockReturnValueOnce(workloadIdentityLoadChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const inputEnv = {
      SF_STATIC_TOKEN: 'jwt-static',
      SF_TOKEN_COMMAND: 'mint-snowflake-token --json',
      SF_WIF_TOKEN: 'vercel-oidc-token',
      INHERITED_WIF_TOKEN: 'vercel-oidc-token',
      DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'stale-dedicated-token',
    };
    const originalEnv = { ...inputEnv };
    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'stripe', env: inputEnv },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end('{"_v":1,"type":"STATE","stream":"charges","value":{}}\n');
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 4);
    staticLoadChild.emit('close', 0);
    refreshLoadChild.emit('close', 0);
    workloadIdentityLoadChild.emit('close', 0);
    await waitForSpawns(spawn, 5);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractOptions = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(extractOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(extractOptions.env).not.toHaveProperty('DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    const staticArgs = spawn.mock.calls[1]?.[1] as string[];
    const staticOptions = spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(staticArgs).toEqual(
      expect.arrayContaining(['--sf-access-token', '$DOGSLED_SNOWFLAKE_ACCESS_TOKEN'])
    );
    expect(staticArgs).not.toContain('jwt-static');
    expect(staticOptions.env).toMatchObject({
      DOGSLED_SNOWFLAKE_ACCESS_TOKEN: 'jwt-static',
    });
    expect(staticOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(staticOptions.env).not.toHaveProperty('DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(staticArgs).not.toContain('--sf-token-command');
    const refreshArgs = spawn.mock.calls[2]?.[1] as string[];
    const refreshOptions = spawn.mock.calls[2]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(refreshArgs).toEqual(
      expect.arrayContaining(['--sf-token-command', 'mint-snowflake-token --json'])
    );
    expect(refreshArgs).not.toContain('--sf-access-token');
    expect(refreshOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    expect(refreshOptions.env).not.toHaveProperty('DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    const workloadIdentityArgs = spawn.mock.calls[3]?.[1] as string[];
    const workloadIdentityOptions = spawn.mock.calls[3]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(workloadIdentityArgs).toEqual(
      expect.arrayContaining([
        '--sf-workload-identity-token',
        '$DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN',
      ])
    );
    expect(workloadIdentityArgs).not.toContain('vercel-oidc-token');
    expect(workloadIdentityOptions.env).toMatchObject({
      DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN: 'vercel-oidc-token',
    });
    expect(workloadIdentityOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    const commitOptions = spawn.mock.calls[4]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(commitOptions.env).not.toHaveProperty('SF_WIF_TOKEN');
    for (const call of [0, 1, 2, 4]) {
      const childEnv = (spawn.mock.calls[call]?.[2] as { env?: NodeJS.ProcessEnv }).env ?? {};
      expect(Object.values(childEnv)).not.toContain('vercel-oidc-token');
    }
    expect(
      Object.entries(workloadIdentityOptions.env ?? {}).filter(
        ([, value]) => value === 'vercel-oidc-token'
      )
    ).toEqual([['DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN', 'vercel-oidc-token']]);
    expect(commitOptions.env).not.toHaveProperty('DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN');
    expect(inputEnv).toEqual(originalEnv);
  });

  it('makes full refresh authoritative for every fan-out destination', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
  archive:
    type: duckdb
    db_path: ./archive.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destinations: [warehouse, archive]
    load_strategy: append
    resources:
      - resource: issues
        load_strategy: merge
`);
    tempDirs.push(projectRoot);

    const extractStdout = new PassThrough();
    const extractChild = createMockChild({ stdout: extractStdout });
    const loadOneChild = createMockChild({ stdin: new PassThrough() });
    const loadTwoChild = createMockChild({ stdin: new PassThrough() });
    const commitChild = createMockChild();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockReturnValueOnce(loadOneChild)
      .mockReturnValueOnce(loadTwoChild)
      .mockReturnValueOnce(commitChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github', fullRefresh: true },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn, 1);
    extractStdout.end('{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":1}}\n');
    extractChild.emit('close', 0);
    await waitForSpawns(spawn, 3);
    loadOneChild.emit('close', 0);
    loadTwoChild.emit('close', 0);
    await waitForSpawns(spawn, 4);
    commitChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    for (const call of [1, 2]) {
      const loadArgs = spawn.mock.calls[call]?.[1] as string[];
      expect(loadArgs).toEqual(expect.arrayContaining(['--load-strategy', 'full_refresh']));
      expect(loadArgs).not.toContain('--stream-load-strategy');
    }
  });

  it('keeps a selected for_each parent and child together with child overrides', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - issues
      - resource: pull_requests
        for_each_parent: issues
        load_strategy: merge
        inputs: { state: closed }
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        resources: ['issues', 'pull_requests'],
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['run', 'issues', 'pull_requests']));
    expect(parseResourceInputsArg(extractArgs)).toEqual({
      pull_requests: { state: 'closed' },
    });
  });

  it('rejects explicit selection of a for_each child without its parent', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - issues
      - resource: pull_requests
        for_each_parent: issues
        load_strategy: merge
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'github',
          resources: ['pull_requests'],
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/for_each child "pull_requests" without its required parent "issues"/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still cancels, settles children, and hands back state with overrides present', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources:
      - resource: issues
        load_strategy: merge
        table: raw_issues
        inputs: { state: closed }
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const controller = new AbortController();
    const initialState = { streams: {} };

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        state: initialState,
        signal: controller.signal,
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const stateDir = extractArgs[extractArgs.indexOf('--state-backend') + 1]!;
    expect(path.dirname(stateDir)).toBe(projectRoot);
    controller.abort();
    await vi.waitFor(() => {
      expect(extractChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(loadChild.kill).toHaveBeenCalledWith('SIGTERM');
    });
    extractChild.emit('close', null, 'SIGTERM');
    loadChild.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toMatchObject({
      exitCode: 143,
      status: 'cancelled',
      state: initialState,
    });
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it('rejects an input override not declared by the selected resource', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        inputs:
          labels: ['has,comma', chore]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github' },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/unknown input.*labels.*issues/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a per-resource table override that is not a SQL identifier', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        table: raw.github issues
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github' },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/dogsled.yml:pipelines.github.resources.0.table/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still fails with Dogsled diagnostics when an override references an unknown transport', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    resources:
      - resource: cycles_mcp
        via: bogus
        load_strategy: merge
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'linear' },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/transport "bogus" not found on source "linear"/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves entity-name resources via pipeline-level via: when running programmatically', async () => {
    // Regression for the P1 the code review caught: runProjectPipeline used to
    // call resolvePipelines but not resolveEntityVariant, so entity-name
    // references (resources: [issues] + via: mcp) would reach the extractor
    // as their authored token instead of the resolved variant (issues_mcp).
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    via: mcp
    resources: [teams, cycles]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'linear' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['run', 'cycles_mcp']));
    expect(extractArgs).not.toEqual(expect.arrayContaining(['cycles']));
  });

  it('translates entity-name resource selections to resolved spec names', async () => {
    // Regression: runProjectPipeline({ resources: ['issues'] }) on an
    // entity-resolved pipeline used to forward the entity name to the
    // extractor, which would then fail to find any matching spec.
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    via: mcp
    resources: [issues, teams]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'linear', resources: ['issues'] },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['run', 'issues_mcp']));
    expect(extractArgs).not.toEqual(expect.arrayContaining(['teams_mcp']));
  });

  it('rejects selections that duplicate a resource after entity resolution', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    via: mcp
    resources: [issues, teams]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        {
          projectRoot,
          pipelineName: 'linear',
          resources: ['issues', 'issues_mcp'],
        },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/resolves to duplicate resources: issues_mcp/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { resources: [], message: /at least one resource/ },
    { resources: ['missing'], message: /Unknown resource selection: missing/ },
    { resources: ['issues', 'issues'], message: /duplicate entries: issues/ },
  ])(
    'rejects invalid explicit selection $resources before spawning',
    async ({ resources, message }) => {
      const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues, pull_requests]
`);
      tempDirs.push(projectRoot);
      const spawn = vi.fn() as Mock;

      await expect(
        runProjectPipeline(
          { projectRoot, pipelineName: 'github', resources },
          { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
        )
      ).rejects.toThrow(message);
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('rejects database-only per-resource overrides on file destinations before spawning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        load_strategy: full_refresh
        table: raw_issues
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github' },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/require database destinations.*file destination.*warehouse/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects selecting an implicit bundled for_each child without its resolved parent', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    via: mcp
    resources: [teams, cycles]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'linear', resources: ['cycles'] },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow(/for_each child "cycles" without its required parent "teams"/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('emits --resource-via for per-resource via overrides on the extractor argv', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  linear:
    schedule: daily
    source: linear
    destination: warehouse
    resources:
      - resource: teams_mcp
        via: graphql
      - resource: cycles_mcp
        via: graphql
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'linear' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });

    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['--resource-via', 'cycles_mcp:graphql']));
    expect(extractArgs).toEqual(expect.arrayContaining(['--resource-via', 'teams_mcp:graphql']));
  });

  it('forwards via-only per-resource overrides without rejecting', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  github:
    schedule: daily
    source: github
    destination: warehouse
    resources:
      - resource: issues
        via: rest
      - pull_requests
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
  });

  it('throws a helpful error when the pipeline is missing', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: csv
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    await expect(runProjectPipeline({ projectRoot, pipelineName: 'missing' })).rejects.toThrow(
      'Pipeline "missing" not found. Available: stripe'
    );
  });

  it.each([undefined, 'dogsled.yml'])(
    'authorizes host embedding keys before config validation (%s)',
    async (configPath) => {
      const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  stripe:
    schedule: daily
    source: stripe
    destination: warehouse
    resources: [issues]
    embed:
      provider: openai
      model: text-embedding-3-small
      api_key: $HOST_EMBED_KEY
      streams:
        issues: [{ field: name }]
`);
      tempDirs.push(projectRoot);
      const spawn = vi.fn();
      const base = {
        projectRoot,
        pipelineName: 'stripe',
        configPath,
        env: { HOST_EMBED_KEY: 'host-canary' },
      };
      await expect(runProjectPipeline(base, { spawn })).rejects.toThrow(
        'Undeclared API key environment variable: HOST_EMBED_KEY'
      );
      expect(spawn).not.toHaveBeenCalled();
      const children = [
        createMockChild({ stdout: new PassThrough(), stderr: new PassThrough() }),
        createMockChild({
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }),
        createMockChild({ stdin: new PassThrough(), stderr: new PassThrough() }),
      ];
      for (const child of children) spawn.mockReturnValueOnce(child);
      const promise = runProjectPipeline(
        { ...base, declaredEnvNames: ['HOST_EMBED_KEY'] },
        { spawn }
      );
      const settled = promise.catch((error) => error);
      await waitForSpawns(spawn, 3).catch(async () => {
        throw await settled;
      });
      const embedCall = spawn.mock.calls.find(([command]) => command === 'embed-cli')!;
      const args = embedCall[1] as string[];
      const embedConfig = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]!, 'utf8'));
      expect(embedConfig.auth_env_vars).toContain('HOST_EMBED_KEY');
      expect(embedConfig.api_key).toBe('$HOST_EMBED_KEY');
      expect(embedCall[2].env.HOST_EMBED_KEY).toBe('host-canary');
      children.forEach((child) => child.emit('close', 0));
      await expect(settled).resolves.toMatchObject({ exitCode: 0 });
    }
  );

  it('scopes host environment declarations to the supplied map and forwards source declarations', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: postgres
    host: localhost
    database: analytics
    username: loader
    password: $HOST_PASSWORD
pipelines:
  stripe:
    schedule: daily
    source: stripe
    destination: warehouse
    resources: [customers]
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn();
    const base = { projectRoot, pipelineName: 'stripe', env: { HOST_PASSWORD: 'host-canary' } };
    await expect(runProjectPipeline(base, { spawn })).rejects.toThrow(
      'Undeclared environment variable: HOST_PASSWORD'
    );
    expect(spawn).not.toHaveBeenCalled();
    vi.stubEnv('AMBIENT_PASSWORD', 'ambient-canary');
    try {
      await expect(
        runProjectPipeline({ ...base, declaredEnvNames: ['AMBIENT_PASSWORD'] }, { spawn })
      ).rejects.toThrow('must be supplied in options.env');
      expect(spawn).not.toHaveBeenCalled();
      const extractChild = createMockChild({
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const loadChild = createMockChild({ stdin: new PassThrough(), stderr: new PassThrough() });
      spawn.mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild);
      const promise = runProjectPipeline(
        { ...base, declaredEnvNames: ['HOST_PASSWORD'] },
        { spawn }
      );
      await waitForSpawns(spawn);
      const extractArgs = spawn.mock.calls[0]![1] as string[];
      expect(extractArgs).toContain('--host-env-names-json');
      expect(extractArgs[extractArgs.indexOf('--host-env-names-json') + 1]).toBe(
        '["HOST_PASSWORD"]'
      );
      expect(JSON.stringify(extractArgs)).not.toContain('host-canary');
      expect(spawn.mock.calls[0]![2].env.HOST_PASSWORD).toBe('host-canary');
      extractChild.emit('close', 0);
      loadChild.emit('close', 0);
      await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names the destination, never the value, for an invalid $ placeholder', async () => {
    const secret = '$ecr3t!';
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: postgres
    auth_env_vars: [PG_PASSWORD]
    host: '${secret}'
    database: analytics
    username: loader
    password: $PG_PASSWORD
pipelines:
  stripe:
    schedule: daily
    source: stripe
    destination: warehouse
    resources: [customers]
`);
    tempDirs.push(projectRoot);

    const error = await runProjectPipeline({ projectRoot, pipelineName: 'stripe' }).catch(
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('a destination setting in dogsled.yml');
    expect((error as Error).message).not.toContain(secret);
  });

  it('explains how to run a models pipeline locally', async () => {
    const projectRoot = makeProject(`pipelines:
  nightly_models:
    type: models
    connection: warehouse
    models: '*'
    schedule: daily
`);
    tempDirs.push(projectRoot);

    await expect(
      runProjectPipeline({ projectRoot, pipelineName: 'nightly_models' })
    ).rejects.toThrow('dogsled model run --integration warehouse');
  });

  it('names the listed models and explains entity-graph pipelines', async () => {
    const projectRoot = makeProject(`pipelines:
  marts:
    type: models
    connection: warehouse
    models: [orders_daily, customers]
    schedule: daily
  identity:
    type: entity-graph
    connection: warehouse
    entities: [Customer]
    schedule: daily
`);
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'models'));
    for (const name of ['orders_daily', 'customers']) {
      fs.writeFileSync(
        path.join(projectRoot, 'models', `${name}.yml`),
        `spec_version: '0.2'\ntype: model\nname: ${name}\nsource: { ref: warehouse.orders }\n`,
        'utf8'
      );
    }

    await expect(runProjectPipeline({ projectRoot, pipelineName: 'marts' })).rejects.toThrow(
      'dogsled model run orders_daily customers --integration warehouse'
    );
    await expect(runProjectPipeline({ projectRoot, pipelineName: 'identity' })).rejects.toThrow(
      'dogsled entity-graph build Customer'
    );
  });

  it('forwards pipeline-level via: as --default-via to the extractor', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  linear_mcp:
    schedule: manual
    source: linear
    destination: warehouse
    via: mcp
    resources: [teams_mcp, cycles_mcp]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'linear_mcp',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toContain('--default-via');
    expect(extractArgs[extractArgs.indexOf('--default-via') + 1]).toBe('mcp');
  });

  it('omits --default-via when the pipeline has no via:', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  stripe:
    schedule: hourly
    source: stripe
    destination: warehouse
    resources: [charges]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'stripe',
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).not.toContain('--default-via');
  });

  it('returns resource metrics and emits immutable ordered lifecycle events', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const loadChild = createMockChild({
      stdin: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const events: PipelineRunEvent[] = [];

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        logFormat: 'pretty',
        onEvent(event) {
          events.push(event);
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.stderr!.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          _v: 1,
          type: 'METRIC',
          stream: 'issues',
          metrics: { records_emitted: 3, api_calls: 2, duration_ms: 12 },
          time: '2026-07-27T00:00:00.000Z',
        })}\n`
      )
    );
    loadChild.stderr!.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ level: 'info', event: 'github__issues: loaded 3 rows', loadMs: 4 })}\n`
      )
    );
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    const result = await promise;
    for (const call of spawn.mock.calls.slice(0, 2)) {
      const args = call[1] as string[];
      expect(args.slice(args.indexOf('--log-format'), args.indexOf('--log-format') + 2)).toEqual([
        '--log-format',
        'json',
      ]);
    }
    expect(result).toMatchObject({
      exitCode: 0,
      status: 'success',
      metrics: {
        totalRecordsExtracted: 3,
        totalRowsLoaded: 3,
        totalApiCalls: 2,
        resources: {
          issues: {
            status: 'success',
            recordsExtracted: 3,
            rowsLoaded: 3,
            extractMs: 12,
            loadMs: 4,
          },
        },
      },
    });
    expect(events[0]?.type).toBe('run_started');
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(1);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(Object.isFrozen(events[0])).toBe(true);
    const progress = events.find((event) => event.type === 'progress');
    if (!progress || progress.type !== 'progress') throw new Error('expected progress event');
    expect(Object.isFrozen(progress.metrics)).toBe(true);
    expect(Object.isFrozen(progress.metrics.resources)).toBe(true);
    expect(Object.isFrozen(progress.metrics.resources.issues)).toBe(true);
  });

  it('forwards preview bounds, isolates caller state, returns updates, and cleans temporary state', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const initialState = {
      streams: {
        'github/issues': {
          cursor_field: 'updated_at',
          cursor_type: 'timestamp' as const,
          cursor_value: '2026-07-01T00:00:00.000Z',
          last_run_at: '2026-07-01T00:00:00.000Z',
          record_count: 2,
        },
      },
    };
    const stateTracker: { directory?: string; cleanAtTerminal: boolean } = {
      cleanAtTerminal: false,
    };

    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        maxRecords: 25,
        state: initialState,
        onEvent(event) {
          if (event.type === 'run_completed' && stateTracker.directory) {
            stateTracker.cleanAtTerminal = !fs.existsSync(stateTracker.directory);
          }
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    expect(extractArgs).toEqual(expect.arrayContaining(['--limit', '25', '--state-backend']));
    const spawnedStateDir = extractArgs[extractArgs.indexOf('--state-backend') + 1]!;
    stateTracker.directory = spawnedStateDir;
    expect(path.dirname(spawnedStateDir)).toBe(projectRoot);
    expect(JSON.parse(fs.readFileSync(path.join(spawnedStateDir, 'state.json'), 'utf8'))).toEqual(
      initialState
    );

    const updatedState = {
      streams: {
        ...initialState.streams,
        'github/pull_requests': {
          last_run_at: '2026-07-27T00:00:00.000Z',
          record_count: 1,
        },
      },
    };
    fs.writeFileSync(path.join(spawnedStateDir, 'state.json'), JSON.stringify(updatedState));
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ state: updatedState, status: 'success' });
    expect(fs.existsSync(spawnedStateDir)).toBe(false);
    expect(stateTracker.cleanAtTerminal).toBe(true);
  });

  it('rejects invalid maxRecords before spawning children', async () => {
    const projectRoot = makeProject(`destinations: {}
pipelines: {}
`);
    tempDirs.push(projectRoot);
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'missing', maxRecords: 0 },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).rejects.toThrow('maxRecords must be a positive safe integer');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('downgrades successful resource metrics when returned state is invalid', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const loadChild = createMockChild({
      stdin: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        state: { streams: {} },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    const extractArgs = spawn.mock.calls[0]?.[1] as string[];
    const stateDir = extractArgs[extractArgs.indexOf('--state-backend') + 1]!;
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{"streams":"invalid"}');
    extractChild.stderr!.write(
      `${JSON.stringify({
        _v: 1,
        type: 'METRIC',
        stream: 'issues',
        metrics: { records_emitted: 1 },
        time: '2026-07-27T00:00:00.000Z',
      })}\n`
    );
    loadChild.stderr!.write(
      `${JSON.stringify({ level: 'info', event: 'github__issues: loaded 1 rows' })}\n`
    );
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({
      exitCode: 0,
      status: 'failure',
      errors: [{ code: 'STATE_READ_FAILED', stage: 'state' }],
      metrics: { resources: { issues: { status: 'unknown' } } },
    });
  });

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn() as Mock;

    await expect(
      runProjectPipeline(
        { projectRoot, pipelineName: 'github', signal: controller.signal },
        { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
      )
    ).resolves.toMatchObject({ exitCode: 1, status: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels and settles every active child before returning', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const controller = new AbortController();
    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github', signal: controller.signal },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    controller.abort();
    await vi.waitFor(() => {
      expect(extractChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(loadChild.kill).toHaveBeenCalledWith('SIGTERM');
    });
    extractChild.emit('close', null, 'SIGTERM');
    loadChild.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toMatchObject({
      exitCode: 143,
      status: 'cancelled',
    });
  });

  it('keeps a completed run successful when a completion callback aborts reentrantly', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const controller = new AbortController();
    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        signal: controller.signal,
        onEvent(event) {
          if (event.type === 'stage_completed' && event.stage === 'load') controller.abort();
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.emit('close', 0);
    loadChild.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ exitCode: 0, status: 'success' });
  });

  it('redacts caller credentials from progress events, metrics, errors, and warnings', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const events: unknown[] = [];
    const secret = 'top-secret-token';
    const shortSecret = 'tiny';
    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        env: { GITHUB_TOKEN: secret, SHORT_TOKEN: shortSecret },
        onEvent(event) {
          events.push(event);
          if (event.type === 'progress') {
            throw new Error(`callback password=${secret} client_secret=${shortSecret}`);
          }
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.stderr!.write(
      `${JSON.stringify({
        _v: 1,
        type: 'LOG',
        level: 'error',
        message: `Failed: github/issues: Bearer ${secret}; db_password=${shortSecret}`,
        time: '2026-07-27T00:00:00.000Z',
      })}\n`
    );
    extractChild.emit('close', 2);
    loadChild.emit('close', null, 'SIGTERM');

    const result = await promise;
    const serializedBoundary = JSON.stringify({ result, events });
    expect(serializedBoundary).not.toContain(secret);
    expect(serializedBoundary).not.toContain(shortSecret);
    expect(serializedBoundary).toContain('[REDACTED]');
    expect(result.metrics.resources.issues?.status).toBe('failure');
  });

  it('returns structured runtime failures and contains event callback errors', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const promise = runProjectPipeline(
      {
        projectRoot,
        pipelineName: 'github',
        onEvent() {
          throw new Error('consumer callback failed');
        },
      },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.stderr!.write(
      `${JSON.stringify({
        _v: 1,
        type: 'METRIC',
        stream: 'issues',
        metrics: { records_emitted: 1 },
        time: '2026-07-27T00:00:00.000Z',
      })}\n`
    );
    extractChild.emit('close', 2);
    loadChild.emit('close', null, 'SIGTERM');

    const result = await promise;
    expect(result).toMatchObject({
      exitCode: 2,
      status: 'failure',
      errors: [{ code: 'PIPELINE_FAILED', message: 'Pipeline exited with code 2.' }],
      metrics: { resources: { issues: { status: 'unknown' } } },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('consumer callback failed')])
    );
  });

  it('returns the complete generic loader JSON error instead of only the exit code', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough(), stderr: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const providerError =
      'Failed to load stream "issues" to snowflake: SQL compilation error: invalid identifier "TOKEN".';

    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github', logFormat: 'json' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );
    await waitForSpawns(spawn);
    loadChild.stderr!.write(`${JSON.stringify({ level: 'error', event: providerError })}\n`);
    extractChild.emit('close', 0);
    loadChild.emit('close', 1);

    await expect(promise).resolves.toMatchObject({
      exitCode: 1,
      status: 'failure',
      errors: [{ code: 'PIPELINE_FAILED', message: providerError, resource: 'issues' }],
    });
  });

  it('returns the extractor cause for a failed resource', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);
    const extractChild = createMockChild({ stdout: new PassThrough(), stderr: new PassThrough() });
    const loadChild = createMockChild({ stdin: new PassThrough() });
    const spawn = vi.fn().mockReturnValueOnce(extractChild).mockReturnValueOnce(loadChild) as Mock;
    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    extractChild.stderr!.write(
      `${JSON.stringify({
        _v: 1,
        type: 'LOG',
        level: 'error',
        message: 'resource_error issues',
        time: '2026-08-19T00:00:00.000Z',
        event: 'progress.resource_error',
        attributes: {
          progress_event: 'resource_error',
          resource: 'issues',
          error: 'The provider could not complete the operation.',
          cause: { name: 'Error', message: 'HubSpot property hs_example does not exist' },
        },
      })}\n`
    );
    extractChild.emit('close', 2);
    loadChild.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toMatchObject({
      status: 'failure',
      errors: expect.arrayContaining([
        {
          code: 'PIPELINE_FAILED',
          message: 'The provider could not complete the operation.',
          resource: 'issues',
          cause: { name: 'Error', message: 'HubSpot property hs_example does not exist' },
        },
      ]),
    });
  });

  it('terminates and settles earlier children when a later spawn throws', async () => {
    const projectRoot = makeProject(`destinations:
  warehouse:
    type: local
    format: jsonl
pipelines:
  github:
    schedule: manual
    source: github
    destination: warehouse
    resources: [issues]
`);
    tempDirs.push(projectRoot);

    const extractChild = createMockChild({ stdout: new PassThrough() });
    const spawn = vi
      .fn()
      .mockReturnValueOnce(extractChild)
      .mockImplementationOnce(() => {
        throw new Error('loader spawn failed');
      }) as Mock;
    const promise = runProjectPipeline(
      { projectRoot, pipelineName: 'github' },
      { metaUrl: 'file:///dogsled/tests/mock.ts', spawn }
    );

    await waitForSpawns(spawn);
    expect(extractChild.kill).toHaveBeenCalledWith('SIGTERM');
    extractChild.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toMatchObject({
      exitCode: 1,
      status: 'failure',
      errors: [
        expect.objectContaining({
          code: 'RUNTIME_ERROR',
          message: 'loader spawn failed',
        }),
      ],
    });
  });
});
