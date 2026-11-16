import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn<typeof import('node:fs').lstatSync>(),
  realpathSync: vi.fn<typeof import('node:fs').realpathSync>(),
  actualLstatSync: undefined as typeof import('node:fs').lstatSync | undefined,
  actualRealpathSync: undefined as typeof import('node:fs').realpathSync | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  filesystem.actualLstatSync = actual.lstatSync;
  filesystem.actualRealpathSync = actual.realpathSync;
  filesystem.lstatSync.mockImplementation(actual.lstatSync);
  filesystem.realpathSync.mockImplementation(actual.realpathSync);
  return {
    ...actual,
    lstatSync: filesystem.lstatSync,
    realpathSync: filesystem.realpathSync,
  };
});

import {
  generateManifest,
  generateProjectManifest,
  parsePipelineManifest,
  resolveProjectPipelines,
  BobsledProjectValidationError,
} from '../../../src/manifest.js';
import { BobsledConfigSchema } from '../../../src/runner/config/schema.js';
import { resolvePipelines } from '../../../src/runner/config/loader.js';
import { createValidationCatalog } from '../../../src/validation.js';

describe('public project manifest compiler', () => {
  let projectRoot: string;

  beforeEach(() => {
    filesystem.lstatSync
      .mockReset()
      .mockImplementation(filesystem.actualLstatSync as typeof fs.lstatSync);
    filesystem.realpathSync
      .mockReset()
      .mockImplementation(filesystem.actualRealpathSync as typeof fs.realpathSync);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-project-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { force: true, recursive: true });
  });

  function writeConfig(destination = 'warehouse'): void {
    fs.writeFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      [
        'destinations:',
        '  warehouse:',
        '    type: duckdb',
        '    db_path: ./data.duckdb',
        'pipelines:',
        '  stripe_sync:',
        '    schedule: manual',
        '    runner: managed',
        '    source: stripe',
        `    destination: ${destination}`,
        '    load_strategy: merge',
        '    table_prefix: raw_stripe__',
        '    resources:',
        '      - resource: charges',
        '        load_strategy: full_refresh',
        '        table: settled_charges',
        '      - customers',
        '  stripe_disabled:',
        '    schedule: daily',
        '    runner: managed',
        '    source: stripe',
        '    destination: warehouse',
        '    resources:',
        '      - plans',
        '    enabled: false',
        '',
      ].join('\n')
    );
  }

  it('loads, cross-validates, and returns authoritative resolved extract pipelines', async () => {
    writeConfig();

    const resolved = await resolveProjectPipelines({ projectRoot });

    expect(resolved.configPaths).toEqual(['bobsled.yml']);
    expect(resolved.extractPipelines).toHaveLength(2);
    expect(resolved.extractPipelines[0]).toMatchObject({
      name: 'stripe_sync',
      source: 'stripe',
      destinationNames: ['warehouse'],
      loadStrategy: 'merge',
      runner: 'managed',
      trigger: 'manual',
      resources: [
        {
          name: 'charges',
          override: {
            loadStrategy: 'full_refresh',
            table: 'settled_charges',
          },
        },
        { name: 'customers' },
      ],
    });
  });

  it('threads an injected validation catalog through resolution and manifest grouping', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  host_sync:
    schedule: manual
    runner: managed
    source: host_source
    destination: warehouse
    resources: [accounts, contacts]
`
    );
    const validationCatalog = createValidationCatalog([
      {
        name: 'host_source',
        auth_setup: [{ env: 'HOST_TOKEN', description: 'Host token' }],
        transports: ['rest'],
        default_transport: 'rest',
        resources: [
          {
            name: 'accounts',
            entity: 'accounts',
            input_names: [],
            output_fields: ['id'],
            embedding_candidates: [],
            incremental: true,
          },
          {
            name: 'contacts',
            entity: 'contacts',
            input_names: ['account_id'],
            output_fields: ['id'],
            embedding_candidates: [],
            incremental: false,
            for_each: { resource: 'accounts', bound_inputs: ['account_id'] },
          },
        ],
      },
    ]);

    const resolved = await resolveProjectPipelines({ projectRoot, validationCatalog });
    expect(resolved.extractPipelines[0]?.resources).toEqual([
      { name: 'accounts' },
      { name: 'contacts', forEachParent: 'accounts' },
    ]);
    expect(resolved.secrets).toEqual([
      {
        integration: 'host_source',
        envVar: 'HOST_TOKEN',
        description: 'Host token',
        docsUrl: undefined,
      },
    ]);

    const manifest = await generateProjectManifest({
      projectRoot,
      validationCatalog,
      bobsledVersion: 'test-version',
    });
    expect(manifest.pipelines[0]?.nodes).toEqual([
      expect.objectContaining({ resources: ['accounts', 'contacts'] }),
    ]);
  });

  it.each([
    {
      source: 'posthog',
      resources: ['organizations', 'projects', 'events'],
      via: undefined,
    },
    {
      source: 'notion',
      resources: ['pages_rest', 'blocks'],
      via: 'rest',
    },
  ])(
    'resolves and compiles a managed $source for_each pipeline from built-in metadata',
    async ({ source, resources, via }) => {
      fs.writeFileSync(
        path.join(projectRoot, 'bobsled.yml'),
        `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  managed_sync:
    schedule: manual
    runner: managed
    source: ${source}
    destination: warehouse
${via ? `    via: ${via}\n` : ''}    resources: [${resources.join(', ')}]
`
      );

      const resolved = await resolveProjectPipelines({ projectRoot });
      expect(resolved.extractPipelines[0]?.resources.at(-1)).toMatchObject({
        name: resources.at(-1),
        forEachParent: resources.at(-2),
      });

      const manifest = await generateProjectManifest({
        projectRoot,
        bobsledVersion: 'test-version',
      });
      expect(manifest.version).toBe(7);
      expect(manifest.pipelines[0]).toMatchObject({
        kind: 'extract',
        integration: source,
      });
      expect(manifest.pipelines[0]?.nodes).toEqual([expect.objectContaining({ resources })]);
    }
  );

  it('compiles deterministic v6 manifests with complete effective load metadata', async () => {
    writeConfig();

    const first = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });
    const second = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(parsePipelineManifest(first)).toEqual(first);
    expect(first).toMatchObject({
      kind: 'bobsled.pipeline.dag',
      version: 7,
      command_contract: {
        command_env: 'BOBSLED_CORE_PIPELINE_COMMAND',
        cwd_env: 'BOBSLED_CORE_PIPELINE_CWD',
        timeout_seconds_env: 'BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS',
      },
    });
    expect(first.pipelines).toHaveLength(1);
    expect(first.pipelines[0]).toMatchObject({
      kind: 'extract',
      name: 'stripe_sync',
      trigger: 'manual',
      resource_metadata: {
        charges: {
          load: {
            destinations: ['warehouse'],
            load_strategy: 'full_refresh',
            table: 'settled_charges',
            table_prefix: 'raw_stripe__',
          },
        },
        customers: {
          load: {
            destinations: ['warehouse'],
            load_strategy: 'merge',
            table_prefix: 'raw_stripe__',
          },
        },
      },
    });
    expect(first.pipelines[0]?.nodes).toEqual([
      expect.objectContaining({
        id: 'extract_0_charges',
        resources: ['charges'],
      }),
      expect.objectContaining({
        id: 'extract_1_customers',
        resources: ['customers'],
      }),
    ]);
  });

  it('preserves an exact Snowflake table and ownership marker in a managed manifest', async () => {
    writeConfig();
    const configPath = path.join(projectRoot, 'bobsled.yml');
    const original = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(
      configPath,
      original
        .replace(
          '    type: duckdb\n    db_path: ./data.duckdb',
          '    type: snowflake\n    account: demo\n    username: loader\n    warehouse: ingest\n    database: analytics\n    schema: ATTACHMENT_STAGING'
        )
        .replace(
          '        table: settled_charges',
          '        table: DS_CSV_aabbcc\n        table_ownership_marker: temp-dataset-aabbcc'
        )
    );

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });
    expect(parsePipelineManifest(manifest)).toEqual(manifest);
    expect(manifest.pipelines[0]?.resource_metadata?.['charges']?.load).toMatchObject({
      table: 'DS_CSV_aabbcc',
      table_ownership_marker: 'temp-dataset-aabbcc',
    });
  });

  it('emits only enabled managed extract pipelines in the task DAG', async () => {
    writeConfig();
    fs.appendFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      `  stripe_second:
    schedule: daily
    runner: managed
    source: stripe
    destination: warehouse
    resources: [customers]
`
    );

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    expect(manifest.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'stripe_sync',
      'stripe_second',
    ]);
  });

  it('freezes destination-specific effective load settings for fan-out pipelines', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
    load_strategy: merge
    table_prefix: warehouse__
  archive:
    type: local
    format: parquet
    load_strategy: append
    table_prefix: archive__
pipelines:
  stripe_sync:
    schedule: hourly
    runner: managed
    source: stripe
    destinations: [warehouse, archive]
    resources: [charges]
`
    );

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    expect(manifest.pipelines[0]).toMatchObject({
      resource_metadata: {
        charges: {
          load: {
            destinations: ['warehouse', 'archive'],
            destination_settings: {
              warehouse: { load_strategy: 'merge', table_prefix: 'warehouse__' },
              archive: { load_strategy: 'append', table_prefix: 'archive__' },
            },
          },
        },
      },
    });
    const load = manifest.pipelines[0]?.resource_metadata?.['charges']?.load;
    expect(load).not.toHaveProperty('load_strategy');
    expect(load).not.toHaveProperty('table_prefix');
  });

  it('resolves load strategy and schema behavior as resource then pipeline then destination', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      `destinations:
  warehouse:
    type: bobsled_managed
    bobsled_connection_ref: warehouse-prod
    load_strategy: append
    schema_behavior: freeze
pipelines:
  app_sync:
    schedule: hourly
    runner: managed
    source: stripe
    destination: warehouse
    load_strategy: merge
    schema_behavior: strict
    resources:
      - customers
      - resource: charges
        load_strategy: full_refresh
        schema_behavior: evolve
  destination_default:
    schedule: daily
    runner: managed
    source: stripe
    destination: warehouse
    resources: [plans]
`
    );

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    expect(parsePipelineManifest(manifest)).toEqual(manifest);
    expect(manifest.pipelines[0]?.resource_metadata).toMatchObject({
      customers: {
        load: {
          load_strategy: 'merge',
          schema_behavior: 'strict',
          destination_settings: {
            warehouse: { load_strategy: 'merge', schema_behavior: 'strict' },
          },
        },
      },
      charges: {
        load: {
          load_strategy: 'full_refresh',
          schema_behavior: 'evolve',
          destination_settings: {
            warehouse: { load_strategy: 'full_refresh', schema_behavior: 'evolve' },
          },
        },
      },
    });
    expect(manifest.pipelines[1]?.resource_metadata).toMatchObject({
      plans: {
        load: {
          load_strategy: 'append',
          schema_behavior: 'freeze',
          destination_settings: {
            warehouse: { load_strategy: 'append', schema_behavior: 'freeze' },
          },
        },
      },
    });
  });

  it('omits schema behavior when unauthored so the loader keeps its evolve default', async () => {
    writeConfig();

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    for (const resource of Object.values(manifest.pipelines[0]?.resource_metadata ?? {})) {
      expect(resource.load).not.toHaveProperty('schema_behavior');
      for (const settings of Object.values(resource.load?.destination_settings ?? {})) {
        expect(settings).not.toHaveProperty('schema_behavior');
      }
    }
  });

  it('compiles scheduled extract and model pipelines together', async () => {
    fs.mkdirSync(path.join(projectRoot, 'models'));
    fs.writeFileSync(
      path.join(projectRoot, 'models', 'daily_revenue.yml'),
      `spec_version: '0.2'
name: daily_revenue
type: model
source:
  ref: warehouse.raw_charges
materialization:
  type: table
`
    );
    fs.writeFileSync(
      path.join(projectRoot, 'bobsled.yml'),
      `destinations:
  warehouse:
    type: duckdb
    db_path: ./data.duckdb
pipelines:
  stripe_sync:
    schedule: hourly
    runner: managed
    source: stripe
    destination: warehouse
    resources: [charges]
  revenue_models:
    type: models
    schedule: daily
    connection: warehouse
    models: [daily_revenue]
`
    );

    const manifest = await generateProjectManifest({ projectRoot, bobsledVersion: 'test-version' });

    expect(manifest.pipelines.map((pipeline) => [pipeline.kind, pipeline.name])).toEqual([
      ['extract', 'stripe_sync'],
      ['models', 'revenue_models'],
    ]);
    expect(manifest.pipelines[0]?.schedule.cron).toBe('0 * * * *');
    expect(parsePipelineManifest(manifest)).toEqual(manifest);
  });

  it('preserves model-pipeline warehouse IDs in a disk-less v7 manifest', () => {
    const config = BobsledConfigSchema.parse({
      pipelines: {
        silver_models: {
          type: 'models',
          connection: 'snowflake',
          schedule: 'daily',
          models: ['daily_revenue'],
          warehouse: 'large',
        },
      },
    });
    const manifest = generateManifest({
      config,
      models: new Map([
        [
          'daily_revenue',
          { connection: 'snowflake', materialization: 'table', refs: [], tags: [] },
        ],
      ]),
    });

    expect(manifest.version).toBe(7);
    expect(manifest.pipelines[0]).toMatchObject({
      kind: 'models',
      warehouse: 'large',
      nodes: [
        expect.objectContaining({
          command: ['model', 'run', 'daily_revenue', '--integration', 'snowflake', '--json'],
        }),
      ],
    });
    expect(parsePipelineManifest(manifest)).toEqual(manifest);
  });

  it('preserves a managed extract destination warehouse ID only at pipeline level', () => {
    const config = BobsledConfigSchema.parse({
      destinations: {
        warehouse: {
          type: 'bobsled_managed',
          bobsled_connection_ref: 'warehouse-prod',
        },
      },
      pipelines: {
        posthog_ingestion: {
          type: 'extract',
          source: 'posthog',
          destination: 'warehouse',
          runner: 'managed',
          schedule: 'manual',
          resources: ['events'],
          destination_warehouse: 'medium',
        },
      },
    });
    const manifest = generateManifest(
      { config, models: new Map() },
      { extractPipelines: resolvePipelines(config) }
    );
    const pipeline = manifest.pipelines[0];

    expect(pipeline).toMatchObject({
      kind: 'extract',
      destination_warehouse: 'medium',
    });
    expect(JSON.stringify(pipeline?.nodes)).not.toContain('destination_warehouse');
    expect(JSON.stringify(pipeline?.resource_metadata)).not.toContain('destination_warehouse');
    expect(parsePipelineManifest(manifest)).toEqual(manifest);
  });

  it('rejects invalid resources through the same project cross-validation path', async () => {
    writeConfig();
    const configPath = path.join(projectRoot, 'bobsled.yml');
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf8').replace('      - customers', '      - not_a_resource')
    );

    await expect(generateProjectManifest({ projectRoot })).rejects.toMatchObject({
      name: 'BobsledProjectValidationError',
      issues: [expect.objectContaining({ message: expect.stringContaining('not_a_resource') })],
    });
  });

  it('throws a typed validation error with stable issue paths', async () => {
    writeConfig('missing');

    await expect(resolveProjectPipelines({ projectRoot })).rejects.toMatchObject({
      name: 'BobsledProjectValidationError',
      exitCode: 2,
      issues: [
        expect.objectContaining({
          path: 'bobsled.yml:pipelines.stripe_sync',
          message: expect.stringContaining('Destination "missing" not found'),
        }),
      ],
    } satisfies Partial<BobsledProjectValidationError>);
  });

  it('rejects config paths outside the caller-owned project root', async () => {
    await expect(
      resolveProjectPipelines({
        projectRoot,
        configPath: path.join(path.dirname(projectRoot), 'outside', 'bobsled.yml'),
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      issues: [
        expect.objectContaining({
          filePath: '.',
          message: 'configPath must live inside projectRoot.',
        }),
      ],
    });
  });

  it('rejects in-root config symlinks that resolve outside the project root', async () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-project-outside-'));
    const outsideConfig = path.join(outsideRoot, 'bobsled.yml');
    fs.writeFileSync(outsideConfig, 'destinations: {}\npipelines: {}\n');
    const linkedConfig = path.join(projectRoot, 'bobsled.yml');
    fs.symlinkSync(outsideConfig, linkedConfig);

    try {
      await expect(
        resolveProjectPipelines({ projectRoot, configPath: linkedConfig })
      ).rejects.toMatchObject({
        exitCode: 2,
        issues: [
          expect.objectContaining({
            filePath: 'bobsled.yml',
            message: 'configPath must live inside projectRoot.',
          }),
        ],
      });
    } finally {
      fs.rmSync(outsideRoot, { force: true, recursive: true });
    }
  });

  it('names a linked bobsled.yml instead of reporting no configuration', async () => {
    const configDirectory = path.join(projectRoot, 'config');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(configDirectory, 'bobsled.yml'),
      'destinations: {}\npipelines: {}\n'
    );
    fs.symlinkSync(
      path.join(configDirectory, 'bobsled.yml'),
      path.join(projectRoot, 'bobsled.yml')
    );

    await expect(resolveProjectPipelines({ projectRoot })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('bobsled.yml: Dogsled does not follow symbolic links.'),
    });
  });

  it('rejects missing configs beneath in-root directories that resolve outside the project', async () => {
    const linkedDirectory = path.join(projectRoot, 'linked-config');
    const missingConfig = path.join(linkedDirectory, 'missing-bobsled.yml');
    const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const rootStats = filesystem.actualLstatSync?.(projectRoot);
    expect(rootStats).toBeDefined();
    filesystem.lstatSync
      .mockReset()
      .mockReturnValueOnce(rootStats!)
      .mockImplementationOnce(() => {
        throw missingError;
      })
      .mockReturnValueOnce(rootStats!);
    filesystem.realpathSync
      .mockReset()
      .mockReturnValueOnce(projectRoot)
      .mockReturnValueOnce(path.join(path.dirname(projectRoot), 'outside'));

    await expect(
      resolveProjectPipelines({
        projectRoot,
        configPath: missingConfig,
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      issues: [
        expect.objectContaining({
          filePath: 'linked-config/missing-bobsled.yml',
          message: 'configPath must live inside projectRoot.',
        }),
      ],
    });
  });
});
