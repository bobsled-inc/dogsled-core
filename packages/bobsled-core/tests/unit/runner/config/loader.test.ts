import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBobsledConfig as loadBobsledConfigFromManifest } from '../../../../src/manifest.js';

const integrations = vi.hoisted(() => ({
  getIntegration: vi.fn(),
  getResources: vi.fn(),
  listEntities: vi.fn(),
  getEntityVariants: vi.fn(),
}));

import {
  findBobsledProject,
  loadIntegrationsLib,
  loadBobsledConfig,
  resolveDestinationConfig,
  resolveModelPipelines,
  resolvePipelines,
  validateEmbedSecretsResolvable,
  validateBobsledConfig as validateBobsledConfigWithCatalog,
  type IntegrationsLib,
} from '../../../../src/runner/config/loader.js';
import type { BobsledConfig } from '../../../../src/runner/config/schema.js';

function validateBobsledConfig(config: BobsledConfig, projectRoot: string) {
  return validateBobsledConfigWithCatalog(config, projectRoot, integrations as IntegrationsLib);
}

/** An empty project, for checks that only read bundled integrations. */
const emptyProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-empty-project-'));
afterAll(() => fs.rmSync(emptyProjectRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BobsledConfig> = {}): BobsledConfig {
  return {
    destinations: {
      warehouse: { type: 'duckdb', db_path: './data.duckdb' },
    },
    pipelines: {
      github: {
        schedule: 'daily',
        source: 'github',
        destination: 'warehouse',
        resources: ['issues'],
        enabled: true,
        runner: 'managed',
      },
    },
    ...overrides,
  } as BobsledConfig;
}

describe('root configuration file spellings', () => {
  it.each(['bobsled.yml', 'bobsled.yaml'])('finds a project whose root config is %s', (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-config-'));
    try {
      fs.writeFileSync(path.join(dir, name), 'pipelines: {}\n');
      fs.mkdirSync(path.join(dir, 'nested'));
      const project = findBobsledProject(path.join(dir, 'nested'));
      expect(project?.configPaths.map((file) => path.basename(file))).toEqual([name]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadBobsledConfig legacy aliases', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-loader-aliases-'));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function writeConfig(contents: string): string {
    const configPath = path.join(configDir, 'bobsled.yml');
    fs.writeFileSync(configPath, contents);
    return configPath;
  }

  it('reports malformed YAML without quoting the authored source line', () => {
    const marker = 'synthetic-bobsled-secret-marker';
    const configPath = writeConfig(`pipelines: [${marker}`);
    let error: unknown;
    try {
      loadBobsledConfigFromManifest(configPath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(2);
    expect((error as CommandError).message).toContain(`Invalid YAML in ${configPath}:`);
    expect((error as CommandError).message).toMatch(/at line \d+, column \d+/u);
    expect((error as CommandError).message).not.toContain(marker);
  });

  it('rejects the retired runner alias', () => {
    expect(() =>
      loadBobsledConfig(
        writeConfig(`
destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  sync:
    source: github
    schedule: daily
    destination: warehouse
    resources: [issues]
    runner: langgraph
`)
      )
    ).toThrow('Invalid bobsled.yml');
  });

  it('accepts canonical values', () => {
    const config = loadBobsledConfigFromManifest(
      writeConfig(`
destinations:
  managed:
    type: bobsled_managed
    bobsled_connection_ref: warehouse-prod
pipelines:
  sync:
    schedule: daily
    source: github
    destination: managed
    resources: [issues]
    runner: managed
`)
    );

    expect(config.destinations.managed).toMatchObject({ type: 'bobsled_managed' });
    expect(config.pipelines.sync).toMatchObject({ runner: 'managed' });
  });

  it('loads the other destination spellings as canonical configuration without a warning', async () => {
    writeConfig(
      `destinations:\n  managed:\n    type: bobsled_managed\n    bobsled_connection_ref: warehouse-prod\npipelines: {}\n`
    );
    const config = loadBobsledConfig(path.join(configDir, 'bobsled.yml'));
    expect(config.destinations.managed).toEqual({
      type: 'bobsled_managed',
      bobsled_connection_ref: 'warehouse-prod',
    });
    const validation = await validateBobsledConfig(config, configDir);
    expect(validation.errors).toEqual([]);
    expect(
      validation.warnings.filter((warning) => warning.includes('BOBSLED_CORE_LEGACY_BLUEPRINT_KEY'))
    ).toEqual([]);
  });

  it('ignores alias words in unrelated fields and text in strict mode', () => {
    const config = loadBobsledConfigFromManifest(
      writeConfig(`
destinations:
  warehouse:
    type: duckdb
    db_path: bobsled_managed
    table_prefix: langgraph
pipelines:
  sync:
    description: "langgraph bobsled_managed"
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
`)
    );

    expect(config.destinations.warehouse).toMatchObject({
      db_path: 'bobsled_managed',
      table_prefix: 'langgraph',
    });
    expect(config.pipelines.sync).toMatchObject({ description: 'langgraph bobsled_managed' });
  });

  it.each([
    {
      name: 'runner',
      config: `
destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  sync:
    schedule: daily
    source: github
    destination: warehouse
    resources: [issues]
    runner: langgraph
`,
      alias: 'langgraph',
      canonical: 'managed',
      configPath: 'pipelines.sync.runner',
    },
    {
      name: 'destination type',
      config: `
destinations:
  managed:
    type: bobsled_lakehouse
    bobsled_connection_ref: warehouse-prod
pipelines:
  sync:
    schedule: daily
    source: github
    destination: managed
    resources: [issues]
`,
      alias: 'bobsled_lakehouse',
      canonical: 'bobsled_managed',
      configPath: 'destinations.managed.type',
    },
  ])('rejects the unsupported $name spelling', ({ config, name }) => {
    let error: unknown;
    try {
      loadBobsledConfigFromManifest(writeConfig(config));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(2);
    expect((error as CommandError).message).toContain('Invalid bobsled.yml');
    if (name === 'destination type') {
      expect((error as CommandError).message).toContain('use bobsled_managed');
    }
  });
});

function makeLib(): IntegrationsLib {
  return {
    getIntegration(name) {
      if (name === 'github') {
        return {
          meta: {
            auth_setup: [
              { env: 'GITHUB_TOKEN', description: 'GitHub token' },
              { env: 'GITHUB_TOKEN', description: 'GitHub token duplicate' },
            ],
          },
          resource_names: ['issues', 'pull_requests', 'traffic'],
          transports: [{ id: 'rest' }],
          default_transport: 'rest',
        };
      }
      if (name === 'stripe') {
        return {
          meta: {
            auth_setup: [{ env: 'STRIPE_API_KEY', description: 'Stripe key' }],
          },
          resource_names: ['charges', 'customers'],
          transports: [{ id: 'rest' }],
          default_transport: 'rest',
        };
      }
      if (name === 'linear') {
        return {
          meta: {
            auth_setup: [{ env: 'LINEAR_API_KEY', description: 'Linear API key' }],
          },
          resource_names: ['issues'],
          transports: [{ id: 'graphql' }, { id: 'mcp' }],
          default_transport: 'graphql',
        };
      }
      throw new Error(`Unknown integration: ${name}`);
    },
    getResources(name) {
      if (name === 'github') {
        return [
          {
            resource: {
              name: 'issues',
              extract: { incremental: true },
              output: {
                id: {},
                body: { embedding_candidate: true },
                title: {},
              },
            },
          },
          {
            resource: {
              name: 'pull_requests',
              output: { id: {}, body: {} },
            },
          },
          {
            resource: { name: 'traffic', output: { id: {} } },
          },
        ];
      }
      if (name === 'stripe') {
        return [
          { resource: { name: 'charges', output: { id: {} } } },
          { resource: { name: 'customers', output: { id: {} } } },
        ];
      }
      throw new Error(`Unknown integration: ${name}`);
    },
    listEntities(name) {
      if (name === 'github') return ['issues', 'pull_requests', 'traffic'];
      if (name === 'stripe') return ['charges', 'customers'];
      if (name === 'linear') return ['issues'];
      return [];
    },
    getEntityVariants(name, entity) {
      if (name === 'linear' && entity === 'issues') {
        return [
          { name: 'issues_graphql', via: 'graphql' },
          { name: 'issues_mcp', via: 'mcp' },
        ];
      }
      if (name === 'github' && entity === 'issues') {
        return [{ name: 'issues', via: undefined }];
      }
      if (name === 'github' && entity === 'pull_requests') {
        return [{ name: 'pull_requests', via: undefined }];
      }
      if (name === 'github' && entity === 'traffic') {
        return [{ name: 'traffic', via: undefined }];
      }
      if (name === 'stripe' && entity === 'charges') {
        return [{ name: 'charges', via: undefined }];
      }
      if (name === 'stripe' && entity === 'customers') {
        return [{ name: 'customers', via: undefined }];
      }
      return [];
    },
  };
}

function getIntegrationStub(name: string): unknown {
  return makeLib().getIntegration(name);
}

// ---------------------------------------------------------------------------
// resolvePipelines
// ---------------------------------------------------------------------------

describe('resolvePipelines', () => {
  it('returns the pipeline name as a separate field from the source', () => {
    const config = makeConfig({
      pipelines: {
        primary_sync: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);

    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatchObject({
      name: 'primary_sync',
      source: 'stripe',
    });
  });

  it('normalizes a singular destination into a one-element list', () => {
    const config = makeConfig();
    const pipelines = resolvePipelines(config);

    expect(pipelines[0]?.destinationNames).toEqual(['warehouse']);
  });

  it('preserves the destinations array for fan-out', () => {
    const config = makeConfig({
      destinations: {
        warehouse: { type: 'duckdb', db_path: './data.duckdb' },
        archive: { type: 's3', bucket: 'b', format: 'parquet' },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destinations: ['warehouse', 'archive'],
          resources: ['charges'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.destinationNames).toEqual(['warehouse', 'archive']);
  });

  it('normalizes resource refs (string + override object)', () => {
    const config = makeConfig({
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [
            'charges',
            {
              resource: 'subscriptions',
              load_strategy: 'append',
              table: 'raw_stripe__subs',
            },
          ],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.resources).toEqual([
      { name: 'charges' },
      {
        name: 'subscriptions',
        override: { loadStrategy: 'append', table: 'raw_stripe__subs' },
      },
    ]);
  });

  it('carries a pipeline-level `warehouse:` selector onto ResolvedPipeline', () => {
    const config = makeConfig({
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          warehouse: 'large',
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.warehouse).toBe('large');
  });

  it('carries destination_warehouse onto the resolved extract pipeline', () => {
    const config = makeConfig({
      destinations: {
        warehouse: { type: 'bobsled_managed', bobsled_connection_ref: 'warehouse-prod' },
      },
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          destination_warehouse: 'medium',
          enabled: true,
          runner: 'managed',
        },
      },
    });

    expect(resolvePipelines(config)[0]?.destinationWarehouse).toBe('medium');
  });

  it('carries a per-resource `warehouse:` override onto ResolvedResource (for rejection)', () => {
    const config = makeConfig({
      pipelines: {
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: [{ resource: 'charges', warehouse: 'BIG_WH' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.resources[0]).toEqual({
      name: 'charges',
      override: { warehouse: 'BIG_WH' },
    });
  });

  it('leaves warehouse undefined when no selector is present (behaves as today)', () => {
    const pipelines = resolvePipelines(makeConfig());
    expect(pipelines[0]?.warehouse).toBeUndefined();
  });

  it('applies a default tablePrefix derived from the pipeline name', () => {
    const config = makeConfig({
      pipelines: {
        my_sync: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.tablePrefix).toBe('my_sync__');
  });

  it('respects an explicit tablePrefix', () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          table_prefix: 'gh_',
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.tablePrefix).toBe('gh_');
  });

  it('passes through inputs, loadStrategy, schemaBehavior, buffer_size, and embed', () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          inputs: { since: '2024-01-01', repo_names: ['dogsled', 'demo-repo'] },
          load_strategy: 'merge',
          schema_behavior: 'strict',
          buffer_size: 10_000,
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]).toMatchObject({
      inputs: { since: '2024-01-01', repo_names: ['dogsled', 'demo-repo'] },
      loadStrategy: 'merge',
      schemaBehavior: 'strict',
      bufferSize: 10_000,
    });
  });

  it('normalizes per-resource schemaBehavior overrides', () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: [{ resource: 'issues', schema_behavior: 'freeze' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    expect(resolvePipelines(config)[0]?.resources[0]?.override).toMatchObject({
      schemaBehavior: 'freeze',
    });
  });

  it('leaves bufferSize undefined when buffer_size is omitted (loader default applies)', () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const pipelines = resolvePipelines(config);
    expect(pipelines[0]?.bufferSize).toBeUndefined();
  });
});

describe('resolvePipelines — via: propagation', () => {
  it('carries pipeline-level via on ResolvedPipeline', () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: ['cycles_mcp'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const [pipeline] = resolvePipelines(config);
    expect(pipeline?.via).toBe('mcp');
  });

  it('carries per-resource via on ResolvedResource.override', () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: [{ resource: 'teams_mcp', via: 'mcp' }, 'initiatives'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const [pipeline] = resolvePipelines(config);
    expect(pipeline?.resources[0]?.name).toBe('teams_mcp');
    expect(pipeline?.resources[0]?.override?.via).toBe('mcp');
    expect(pipeline?.resources[1]?.name).toBe('initiatives');
    expect(pipeline?.resources[1]?.override).toBeUndefined();
  });

  it('leaves via undefined when not declared (back-compat)', () => {
    const config = makeConfig();
    const [pipeline] = resolvePipelines(config);
    expect(pipeline?.via).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveDestinationConfig
// ---------------------------------------------------------------------------

describe('resolveDestinationConfig', () => {
  it('returns the destination by name', () => {
    const config = makeConfig();
    const dest = resolveDestinationConfig(config, 'warehouse');
    expect(dest).toEqual({ type: 'duckdb', db_path: './data.duckdb' });
  });

  it('returns undefined for an unknown destination', () => {
    const config = makeConfig();
    expect(resolveDestinationConfig(config, 'missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateBobsledConfig
// ---------------------------------------------------------------------------

describe('validateBobsledConfig', () => {
  let projectRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockImplementation(getIntegrationStub);
    vi.mocked(integrations.getResources).mockImplementation(makeLib().getResources);
    vi.mocked(integrations.listEntities).mockImplementation(makeLib().listEntities);
    vi.mocked(integrations.getEntityVariants).mockImplementation(makeLib().getEntityVariants);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('passes for a minimal valid config (bundled source + bundled resource)', async () => {
    const config = makeConfig();
    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports a broken file in a Dogsled folder as a validation error instead of throwing', async () => {
    fs.mkdirSync(path.join(projectRoot, 'models'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'models', 'scratch.yml'), 'type: model\nname: [\n');

    const result = await validateBobsledConfig(makeConfig(), projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'models/scratch.yml',
        message: expect.stringMatching(/^Invalid YAML: .+ at line \d+, column \d+$/),
      },
    ]);
    expect(result.pipelines).toEqual([]);
  });

  it('validates a project root that does not exist yet', async () => {
    const result = await validateBobsledConfig(makeConfig(), path.join(projectRoot, 'missing'));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validates a project-local custom API matrix against its resource inputs', async () => {
    const customCatalog: IntegrationsLib = {
      getIntegration: (name) => {
        if (name !== 'datagolf') throw new Error(`Unknown integration: ${name}`);
        return {
          meta: { auth_setup: [] },
          resource_names: ['historical_outrights'],
          transports: [{ id: 'rest' }],
          default_transport: 'rest',
        };
      },
      getResources: (name) =>
        name === 'datagolf'
          ? [
              {
                resource: {
                  name: 'historical_outrights',
                  input: {
                    tour: { type: 'string', enum: ['pga', 'euro'] },
                    year: { type: 'integer', minimum: 2019, maximum: 2025 },
                  },
                },
              },
            ]
          : [],
      listEntities: () => [],
      getEntityVariants: () => [],
    };
    fs.mkdirSync(path.join(projectRoot, 'resources', 'datagolf'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'datagolf', 'historical_outrights.yml'),
      `spec_version: '1'
type: resource
name: historical_outrights
integration: datagolf
input:
  tour: { type: string, enum: [pga, euro] }
  year: { type: integer, minimum: 2019, maximum: 2025 }
api:
  endpoint: /historical-odds/outrights
  method: GET
output:
  tour: { type: string, path: '$.tour' }
extract:
  record_path: '$.data'
  incremental: { strategy: full_refresh }
`
    );
    const config = makeConfig({
      pipelines: {
        datagolf: {
          schedule: 'manual',
          source: 'datagolf',
          destination: 'warehouse',
          resources: [
            {
              resource: 'historical_outrights',
              input_matrix: {
                axes: {
                  tour: ['pga', 'euro'],
                  year: [2024, 2025],
                },
                concurrency: 2,
              },
            },
          ],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfigWithCatalog(config, projectRoot, customCatalog);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.pipelines[0]?.resources[0]?.override?.inputMatrix?.concurrency).toBe(2);
  });

  it('reports duplicate normalized matrix tuples', async () => {
    const customCatalog: IntegrationsLib = {
      getIntegration: () => ({
        meta: { auth_setup: [] },
        resource_names: ['reports'],
        transports: [{ id: 'rest' }],
        default_transport: 'rest',
      }),
      getResources: () => [
        {
          resource: {
            name: 'reports',
            input: { mode: { type: 'string' } },
          },
        },
      ],
      listEntities: () => [],
      getEntityVariants: () => [],
    };
    fs.mkdirSync(path.join(projectRoot, 'resources', 'datagolf'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'datagolf', 'reports.yml'),
      `spec_version: '1'
type: resource
name: reports
integration: datagolf
input: { mode: { type: string } }
api: { endpoint: /reports, method: GET }
output: { id: { type: string, path: '$.id' } }
extract: { record_path: '$', incremental: { strategy: full_refresh } }
`
    );
    const config = makeConfig({
      pipelines: {
        datagolf: {
          schedule: 'manual',
          source: 'datagolf',
          destination: 'warehouse',
          resources: [{ resource: 'reports', input_matrix: { axes: { mode: ['same', 'same'] } } }],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfigWithCatalog(config, projectRoot, customCatalog);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('duplicate normalized tuple') })
    );
  });

  it('accepts destination_warehouse only for a singular managed destination', async () => {
    const managed = makeConfig({
      destinations: {
        warehouse: { type: 'bobsled_managed', bobsled_connection_ref: 'warehouse-prod' },
      },
      pipelines: {
        github: {
          schedule: 'manual',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          destination_warehouse: 'medium',
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const concrete = makeConfig({
      pipelines: {
        github: {
          schedule: 'manual',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          destination_warehouse: 'medium',
          enabled: true,
          runner: 'managed',
        },
      },
    });

    expect((await validateBobsledConfig(managed, projectRoot)).errors).toEqual([]);
    expect((await validateBobsledConfig(concrete, projectRoot)).errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.github.destination_warehouse',
        message: expect.stringContaining('singular destination whose type is "bobsled_managed"'),
      })
    );
  });

  it('rejects an unknown destination name', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'unknown_warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.github',
        message: expect.stringContaining('Destination "unknown_warehouse" not found'),
      })
    );
  });

  it('rejects an unknown destination name in a fan-out list', async () => {
    const config = makeConfig({
      destinations: {
        warehouse: { type: 'duckdb', db_path: './data.duckdb' },
      },
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destinations: ['warehouse', 'missing_archive'],
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Destination "missing_archive" not found'),
      })
    );
  });

  it('rejects an unknown source handle', async () => {
    const config = makeConfig({
      pipelines: {
        weird: {
          schedule: 'daily',
          source: 'not_a_real_integration',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.weird.source',
        message: expect.stringContaining('Source "not_a_real_integration" not found'),
      })
    );
  });

  it('rejects a bare resource name not in bundled or project-local', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['nonexistent'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.github.resources',
        message: expect.stringContaining('Resource "nonexistent" not found in source "github"'),
      })
    );
  });

  it('accepts a project-local resource that overrides a bundled one (with a warning)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'issues.yml'),
      'spec_version: "1"\ntype: resource\nname: issues\n'
    );

    const config = makeConfig();
    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Project-local overrides bundled')])
    );
  });

  it('keeps bundled siblings available when one resource is overridden project-locally', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'issues.yml'),
      'spec_version: "1"\ntype: resource\nname: issues\n'
    );

    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues', 'pull_requests', 'traffic'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('resource "issues" exists both in bundled integration "github"'),
      ])
    );
  });

  it('accepts a path-like resource that resolves to a project-local nested file', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github', 'finance'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'finance', 'invoices.yml'),
      'spec_version: "1"\ntype: resource\nname: invoices\n'
    );

    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['finance/invoices'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(true);
  });

  it('passes when extract.integration matches pipeline.source on a project-local resource', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'orders.yml'),
      "spec_version: '1'\ntype: resource\nname: orders\nextract:\n  integration: github\n  source: { table: orders }\n  replication: { method: full_refresh }\nschema:\n  columns:\n    id: { type: integer }\n"
    );
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['orders'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(true);
  });

  it('fails when extract.integration differs from pipeline.source', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'orders.yml'),
      "spec_version: '1'\ntype: resource\nname: orders\nextract:\n  integration: bigquery_warehouse\n  source: { table: orders }\n  replication: { method: full_refresh }\nschema:\n  columns:\n    id: { type: integer }\n"
    );
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['orders'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.github.resources',
        message: expect.stringContaining('declares extract.integration as "bigquery_warehouse"'),
      })
    );
  });

  it('skips the cross-check when extract.integration is absent', async () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'github'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'github', 'orders.yml'),
      "spec_version: '1'\ntype: resource\nname: orders\n"
    );
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['orders'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(true);
  });

  it('rejects a path-like resource missing from the filesystem', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['finance/invoices'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Resource "finance/invoices" not found at'),
      })
    );
  });

  it('enumerates secrets from each pipeline source (deduplicated)', async () => {
    const config = makeConfig({
      destinations: {
        warehouse: { type: 'duckdb', db_path: './data.duckdb' },
      },
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
        stripe: {
          schedule: 'hourly',
          source: 'stripe',
          destination: 'warehouse',
          resources: ['charges'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.secrets).toEqual([
      { integration: 'github', envVar: 'GITHUB_TOKEN', description: 'GitHub token' },
      { integration: 'stripe', envVar: 'STRIPE_API_KEY', description: 'Stripe key' },
    ]);
  });

  it('warns when an embedding_candidate field exists but no embed block is set', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      'Pipeline "github": stream "issues" has embedding_candidate fields (body) but no embed config.'
    );
  });

  it('rejects an embed config that references a missing field', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
          embed: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            api_key: '$OPENAI_API_KEY',
            streams: { issues: [{ field: 'missing_field' }] },
          },
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.github.embed.streams.issues.missing_field',
        message: expect.stringContaining('field "missing_field" not found'),
      })
    );
  });

  it('enumerates embed api_key placeholders as secret requirements', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
          embed: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            api_key: '$OPENAI_API_KEY',
            streams: { issues: [{ field: 'body' }] },
          },
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.secrets).toContainEqual({
      integration: 'embed:openai',
      envVar: 'OPENAI_API_KEY',
      description: expect.stringContaining('pipeline "github"'),
    });
  });

  it('recognizes both $VAR and ${{ env.VAR }} embed api_key placeholders', async () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
          embed: {
            provider: 'amazon-bedrock',
            model: 'amazon.titan-embed-text-v2:0',
            region: 'us-east-1',
            api_key: '${{ env.AWS_BEARER_TOKEN_BEDROCK }}',
            streams: { issues: [{ field: 'body' }] },
          },
        },
      },
    });

    const result = await validateBobsledConfig(config, projectRoot);

    expect(result.secrets).toContainEqual(
      expect.objectContaining({
        integration: 'embed:amazon-bedrock',
        envVar: 'AWS_BEARER_TOKEN_BEDROCK',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// validateBobsledConfig — via: cross-validation
// ---------------------------------------------------------------------------

describe('validateBobsledConfig — via: cross-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockImplementation(getIntegrationStub);
    vi.mocked(integrations.getResources).mockImplementation(makeLib().getResources);
    vi.mocked(integrations.listEntities).mockImplementation(makeLib().listEntities);
    vi.mocked(integrations.getEntityVariants).mockImplementation(makeLib().getEntityVariants);
  });

  it('accepts pipeline `via:` that matches a transport id', async () => {
    const config = makeConfig({
      pipelines: {
        linear_mcp: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: ['cycles_mcp'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const viaErrors = result.errors.filter((e) => e.message.includes('transport'));
    expect(viaErrors).toEqual([]);
  });

  it('rejects pipeline `via:` that does not match any transport', async () => {
    const config = makeConfig({
      pipelines: {
        linear_bogus: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'bogus',
          resources: ['cycles_mcp'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    expect(result.valid).toBe(false);
    const viaError = result.errors.find((e) => e.path === 'bobsled.yml:pipelines.linear_bogus.via');
    expect(viaError?.message).toMatch(/transport "bogus" not found.*linear/);
    expect(viaError?.message).toMatch(/Available: graphql, mcp/);
  });

  it('rejects per-resource `via:` that does not match any transport', async () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: [{ resource: 'teams_mcp', via: 'bogus' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    expect(result.valid).toBe(false);
    const viaError = result.errors.find(
      (e) => e.path === 'bobsled.yml:pipelines.linear.resources.teams_mcp.via'
    );
    expect(viaError?.message).toMatch(/transport "bogus" not found.*linear/);
  });

  it('reports per-resource via errors against the entity-name path the user authored', async () => {
    // When the user writes an entity-name resource with a bad per-resource via,
    // the diagnostic should echo back the entity name they wrote — not the
    // resolved variant spec name. The path is fixed at step 4b before
    // resolveEntityVariant fires, so this is locked in by ordering.
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: [{ resource: 'issues', via: 'bogus' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    expect(result.valid).toBe(false);
    const viaError = result.errors.find(
      (e) => e.path === 'bobsled.yml:pipelines.linear.resources.issues.via'
    );
    expect(viaError?.message).toMatch(/transport "bogus" not found.*linear/);
  });

  it('does nothing when no via: is declared', async () => {
    const config = makeConfig();
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const viaErrors = result.errors.filter((e) => e.message.includes('transport'));
    expect(viaErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateBobsledConfig — entity-aware resource resolution
// ---------------------------------------------------------------------------

describe('validateBobsledConfig — entity-aware resource resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockImplementation(getIntegrationStub);
    vi.mocked(integrations.getResources).mockImplementation(makeLib().getResources);
    vi.mocked(integrations.listEntities).mockImplementation(makeLib().listEntities);
    vi.mocked(integrations.getEntityVariants).mockImplementation(makeLib().getEntityVariants);
    // Expand linear's resource_names to include the variant spec names so the
    // strict-name precedence test below has something to find.
    vi.mocked(integrations.getIntegration).mockImplementation((name: string) => {
      const stub = getIntegrationStub(name) as {
        resource_names: string[];
      } & Record<string, unknown>;
      if (name === 'linear') {
        return { ...stub, resource_names: ['issues_graphql', 'issues_mcp', 'initiatives'] };
      }
      return stub;
    });
  });

  it('rewrites entity-name resource to variant when pipeline via matches', async () => {
    const config = makeConfig({
      pipelines: {
        linear_mcp: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const pipeline = result.pipelines.find((p) => p.name === 'linear_mcp');
    expect(pipeline?.resources[0]?.name).toBe('issues_mcp');
    expect(pipeline?.resources[0]?.requestedName).toBe('issues');
    expect(result.errors.filter((e) => e.message.includes('Resource'))).toEqual([]);
  });

  it('per-resource via overrides pipeline via for entity resolution', async () => {
    const config = makeConfig({
      pipelines: {
        linear_mixed: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: [{ resource: 'issues', via: 'graphql' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const pipeline = result.pipelines.find((p) => p.name === 'linear_mixed');
    expect(pipeline?.resources[0]?.name).toBe('issues_graphql');
    expect(pipeline?.resources[0]?.requestedName).toBe('issues');
  });

  it('leaves strict-name references untouched (back-compat with explicit variant names)', async () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: ['issues_mcp'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const pipeline = result.pipelines.find((p) => p.name === 'linear');
    expect(pipeline?.resources[0]?.name).toBe('issues_mcp');
    expect(pipeline?.resources[0]?.requestedName).toBeUndefined();
  });

  it('reports a structured error when an entity has multiple variants and no via was provided', async () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    expect(result.valid).toBe(false);
    const entityError = result.errors.find((e) =>
      e.message.includes('multiple transport variants')
    );
    expect(entityError?.path).toBe('bobsled.yml:pipelines.linear.resources.issues');
    expect(entityError?.message).toMatch(/"issues"/);
  });

  it('reports a no-matching-via error and lists available variants', async () => {
    const config = makeConfig({
      pipelines: {
        linear: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'graphql',
          // `issues` has graphql + mcp variants in the fixture; per-resource
          // via "rest" triggers both (1) transport mismatch on validateViaSelections
          // and (2) no-matching-variant on resolveEntityVariant.
          resources: [{ resource: 'issues', via: 'rest' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    expect(result.valid).toBe(false);
    // Two errors: (1) per-resource via "rest" not in transport list, (2) entity
    // resolution finds no matching variant. Both are useful diagnostics.
    const entityError = result.errors.find((e) => e.message.includes('No variant for entity'));
    expect(entityError?.message).toMatch(/issues_graphql/);
    expect(entityError?.message).toMatch(/issues_mcp/);
  });

  it('flows entity-name pipelines through to extractor invocation as resolved names', async () => {
    // End-to-end signal: result.pipelines has the rewritten name, which is
    // what buildPipelineInvocation hands off to the subprocess.
    const config = makeConfig({
      pipelines: {
        linear_mcp: {
          schedule: 'manual',
          source: 'linear',
          destination: 'warehouse',
          via: 'mcp',
          resources: ['issues', { resource: 'initiatives' }],
          enabled: true,
          runner: 'managed',
        },
      },
    });
    const result = await validateBobsledConfig(config, emptyProjectRoot);
    const pipeline = result.pipelines.find((p) => p.name === 'linear_mcp');
    expect(pipeline?.resources.map((r) => r.name)).toEqual(['issues_mcp', 'initiatives']);
    // initiatives: strict-name match wins (no rewrite), so requestedName stays unset.
    expect(pipeline?.resources[1]?.requestedName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateEmbedSecretsResolvable
// ---------------------------------------------------------------------------

describe('validateEmbedSecretsResolvable', () => {
  function configWithEmbed(apiKey: string): BobsledConfig {
    return makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
          embed: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            api_key: apiKey,
            streams: { issues: [{ field: 'body' }] },
          },
        },
      },
    });
  }

  it('returns no issues when every embed api_key resolves in env', () => {
    const issues = validateEmbedSecretsResolvable(configWithEmbed('$OPENAI_API_KEY'), {
      OPENAI_API_KEY: 'sk-test',
    });
    expect(issues).toEqual([]);
  });

  it('reports a structured ValidationIssue when an embed env var is missing', () => {
    const issues = validateEmbedSecretsResolvable(configWithEmbed('$OPENAI_API_KEY'), {});
    expect(issues).toEqual([
      {
        path: 'bobsled.yml:pipelines.github.embed.api_key',
        message: expect.stringContaining('OPENAI_API_KEY'),
      },
    ]);
  });

  it('treats empty-string env values as missing', () => {
    const issues = validateEmbedSecretsResolvable(configWithEmbed('$OPENAI_API_KEY'), {
      OPENAI_API_KEY: '',
    });
    expect(issues).toHaveLength(1);
  });

  it('skips pipelines whose embed block has no api_key (Bedrock credential chain)', () => {
    const config = makeConfig({
      pipelines: {
        github: {
          schedule: 'daily',
          source: 'github',
          destination: 'warehouse',
          resources: ['issues'],
          enabled: true,
          runner: 'managed',
          embed: {
            provider: 'amazon-bedrock',
            model: 'amazon.titan-embed-text-v2:0',
            region: 'us-east-1',
            streams: { issues: [{ field: 'body' }] },
          },
        },
      },
    });

    expect(validateEmbedSecretsResolvable(config, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveNeedsState
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model pipelines: resolution + membership validation
// ---------------------------------------------------------------------------

describe('resolveModelPipelines', () => {
  it('returns one ResolvedModelPipeline per `type: models` entry', () => {
    const config = makeConfig({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
        ecom_gold: {
          type: 'models',
          connection: 'bigquery',
          schedule: 'every 6h',
          models: ['fct_revenue', 'mart_customer_360'],
        },
      },
    });

    const resolved = resolveModelPipelines(config);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      name: 'ecom_silver',
      schedule: 'hourly',
      cron: '0 * * * *',
      connection: 'snowflake',
      models: '*',
    });
    expect(resolved[1]).toMatchObject({
      name: 'ecom_gold',
      schedule: 'every 6h',
      cron: '0 */6 * * *',
      connection: 'bigquery',
      models: ['fct_revenue', 'mart_customer_360'],
    });
  });

  it('carries a pipeline-level `warehouse:` selector onto ResolvedModelPipeline', () => {
    const config = makeConfig({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
          warehouse: 'large',
        },
      },
    });

    const resolved = resolveModelPipelines(config);
    expect(resolved[0]?.warehouse).toBe('large');
  });

  it('leaves warehouse undefined when no selector is present (behaves as today)', () => {
    const config = makeConfig({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
      },
    });

    const resolved = resolveModelPipelines(config);
    expect(resolved[0]?.warehouse).toBeUndefined();
  });

  it('skips extract pipelines', () => {
    const config = makeConfig();
    expect(resolveModelPipelines(config)).toEqual([]);
  });

  it('throws CommandError(2) on an unrecognized schedule expression', () => {
    const config = makeConfig({
      pipelines: {
        ecom: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'whenever I feel like it',
          models: '*',
        },
      },
    });
    expect(() => resolveModelPipelines(config)).toThrow();
  });
});

describe('validateBobsledConfig — model pipeline membership', () => {
  let projectRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockImplementation(getIntegrationStub);
    vi.mocked(integrations.getResources).mockImplementation(makeLib().getResources);
    vi.mocked(integrations.listEntities).mockImplementation(makeLib().listEntities);
    vi.mocked(integrations.getEntityVariants).mockImplementation(makeLib().getEntityVariants);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-loader-models-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function configWithModelsPipeline(extra: Partial<BobsledConfig> = {}): BobsledConfig {
    return {
      destinations: { warehouse: { type: 'duckdb', db_path: './data.duckdb' } },
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: ['stg_orders'],
        },
      },
      ...extra,
    } as BobsledConfig;
  }

  it('passes when the named model exists and belongs to the declared connection', async () => {
    fs.mkdirSync(path.join(projectRoot, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'source:',
        '  ref: snowflake.raw_orders',
        '',
      ].join('\n')
    );

    const result = await validateBobsledConfig(configWithModelsPipeline(), projectRoot);
    expect(result.errors).toEqual([]);
    expect(result.modelPipelines).toHaveLength(1);
  });

  it('rejects an unknown model name with CommandError-level error', async () => {
    // No model files written — every name is unknown.
    const result = await validateBobsledConfig(configWithModelsPipeline(), projectRoot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.ecom_silver.models',
        message: expect.stringContaining('Model "stg_orders" not found'),
      })
    );
  });

  it('rejects a model that belongs to a different connection', async () => {
    fs.mkdirSync(path.join(projectRoot, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'source:',
        '  ref: bigquery.raw_orders', // different connection
        '',
      ].join('\n')
    );

    const result = await validateBobsledConfig(configWithModelsPipeline(), projectRoot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.ecom_silver.models',
        message: expect.stringContaining('Model "stg_orders" belongs to connection "bigquery"'),
      })
    );
  });

  it('resolves connection through a chained source ref (model -> model -> dotted ref)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'source:',
        '  ref: snowflake.raw_orders',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'mart_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: mart_orders',
        'type: model',
        'source:',
        '  ref: stg_orders', // chained ref
        '',
      ].join('\n')
    );

    const config = configWithModelsPipeline({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: ['mart_orders'],
        },
      },
    } as Partial<BobsledConfig>);

    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.errors).toEqual([]);
  });

  it('warns (not errors) when a wildcard pipeline matches zero models', async () => {
    // No models on disk for the snowflake connection.
    fs.mkdirSync(path.join(projectRoot, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'source:',
        '  ref: bigquery.raw_orders', // different connection
        '',
      ].join('\n')
    );

    const config = configWithModelsPipeline({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
      },
    } as Partial<BobsledConfig>);

    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`models: '*' matched zero derived models for connection "snowflake"`)
    );
  });

  it('treats a missing models/ directory as zero matches (warning for wildcard, error for explicit names)', async () => {
    // No `models/` directory at all.
    const explicitResult = await validateBobsledConfig(configWithModelsPipeline(), projectRoot);
    expect(explicitResult.valid).toBe(false);

    const wildcardConfig = configWithModelsPipeline({
      pipelines: {
        ecom_silver: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'hourly',
          models: '*',
        },
      },
    } as Partial<BobsledConfig>);
    const wildcardResult = await validateBobsledConfig(wildcardConfig, projectRoot);
    expect(wildcardResult.valid).toBe(true);
    expect(wildcardResult.warnings.length).toBeGreaterThan(0);
  });

  it('respects top-level models.project to locate the Model Spec root', async () => {
    const modelSpecRoot = path.join(projectRoot, 'analytics');
    fs.mkdirSync(path.join(modelSpecRoot, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(modelSpecRoot, 'models', 'stg_orders.yml'),
      [
        "spec_version: '0.2'",
        'name: stg_orders',
        'type: model',
        'source:',
        '  ref: snowflake.raw_orders',
        '',
      ].join('\n')
    );

    const config = configWithModelsPipeline({
      models: { project: 'analytics' },
    } as Partial<BobsledConfig>);
    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.errors).toEqual([]);
  });

  it('reports missing models when models.project names a missing directory', async () => {
    const config = configWithModelsPipeline({
      models: { project: 'missing-analytics' },
    } as Partial<BobsledConfig>);
    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'bobsled.yml:pipelines.ecom_silver.models',
        message: expect.stringContaining('Model "stg_orders" not found'),
      })
    );
  });

  it('reports problems in a separate Model Spec project as validation errors instead of throwing', async () => {
    const modelSpecRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-separate-model-spec-'));
    try {
      fs.mkdirSync(path.join(modelSpecRoot, 'models'), { recursive: true });
      fs.mkdirSync(path.join(modelSpecRoot, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(modelSpecRoot, 'model-spec.yml'), 'models_dir: models\n');
      fs.writeFileSync(path.join(modelSpecRoot, 'notes', 'copy.yml'), 'type: model_spec_config\n');
      fs.writeFileSync(
        path.join(modelSpecRoot, 'models', 'stg_orders.yml'),
        [
          "spec_version: '0.2'",
          'name: stg_orders',
          'type: model',
          'source:',
          '  ref: snowflake.raw_orders',
          '',
        ].join('\n')
      );
      const modelSpecFolder = path.relative(projectRoot, modelSpecRoot);

      const config = configWithModelsPipeline({
        models: { project: modelSpecFolder },
      } as Partial<BobsledConfig>);
      const result = await validateBobsledConfig(config, projectRoot);
      const duplicate = expect.stringContaining('A project may contain one model_spec_config file');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        { path: path.posix.join(modelSpecFolder, 'model-spec.yml'), message: duplicate },
        { path: path.posix.join(modelSpecFolder, 'notes/copy.yml'), message: duplicate },
      ]);
    } finally {
      fs.rmSync(modelSpecRoot, { recursive: true, force: true });
    }
  });

  it('does not change validation behavior for extract pipelines (back-compat)', async () => {
    // Same shape as the existing minimal valid extract pipeline — no
    // `type:` field, must still resolve and pass.
    const config = makeConfig();
    const result = await validateBobsledConfig(config, projectRoot);
    expect(result.valid).toBe(true);
    expect(result.modelPipelines).toEqual([]);
    expect(result.pipelines).toHaveLength(1);
  });
});

describe('loadIntegrationsLib — transports surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockImplementation(getIntegrationStub);
    vi.mocked(integrations.getResources).mockImplementation(makeLib().getResources);
    vi.mocked(integrations.listEntities).mockImplementation(makeLib().listEntities);
    vi.mocked(integrations.getEntityVariants).mockImplementation(makeLib().getEntityVariants);
  });

  it('returns the generated built-in validation adapter', async () => {
    const lib = await loadIntegrationsLib();
    const linear = lib.getIntegration('linear');
    expect(linear.transports.map((t) => t.id).sort()).toEqual(['graphql', 'mcp']);
    expect(linear.default_transport).toBe('graphql');
  });
});
