import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';
import type { SqlRunnerModule } from '../../../src/compiler/index.js';
import type { IntegrationCompileContext } from '../../../src/api/integration-context.js';
import {
  buildViewExistsQuery,
  verifyViewsWritten,
  type VerifiableMaterializedModel,
} from '../../../src/api/view-write-verify.js';

// ---------------------------------------------------------------------------
// buildViewExistsQuery — per-dialect catalog query strings
// ---------------------------------------------------------------------------

describe('buildViewExistsQuery', () => {
  it('bigquery: dataset-qualified INFORMATION_SCHEMA.VIEWS using database as project', () => {
    expect(buildViewExistsQuery('bigquery', 'analytics', 'my-project', 'StgOrders')).toBe(
      'SELECT table_name FROM `my-project.analytics.INFORMATION_SCHEMA.VIEWS` ' +
        "WHERE table_name = 'stgorders' LIMIT 1"
    );
  });

  it('bigquery: derives project from a `project.dataset` schema when no database is set', () => {
    expect(buildViewExistsQuery('bigquery', 'proj.ds', undefined, 'v')).toBe(
      'SELECT table_name FROM `proj.ds.INFORMATION_SCHEMA.VIEWS` ' +
        "WHERE table_name = 'v' LIMIT 1"
    );
  });

  it('snowflake: database-scoped INFORMATION_SCHEMA, uppercased identifiers', () => {
    expect(buildViewExistsQuery('snowflake', 'analytics', 'mydb', 'orders')).toBe(
      'SELECT table_name FROM MYDB.INFORMATION_SCHEMA.VIEWS ' +
        "WHERE table_schema = 'ANALYTICS' AND table_name = 'ORDERS' LIMIT 1"
    );
  });

  it('postgres: plain information_schema.views, lowercased identifiers', () => {
    expect(buildViewExistsQuery('postgres', 'public', undefined, 'Orders')).toBe(
      'SELECT table_name FROM information_schema.views ' +
        "WHERE table_schema = 'public' AND table_name = 'orders' LIMIT 1"
    );
  });

  it('duckdb: plain information_schema.views, lowercased identifiers', () => {
    expect(buildViewExistsQuery('duckdb', 'main', undefined, 'StgItems')).toBe(
      'SELECT table_name FROM information_schema.views ' +
        "WHERE table_schema = 'main' AND table_name = 'stgitems' LIMIT 1"
    );
  });

  it('databricks: catalog-qualified information_schema.views', () => {
    expect(buildViewExistsQuery('databricks', 'analytics', 'main_cat', 'Orders')).toBe(
      'SELECT table_name FROM main_cat.information_schema.views ' +
        "WHERE table_schema = 'analytics' AND table_name = 'orders' LIMIT 1"
    );
  });

  it('mysql: information_schema.views scoped by database', () => {
    expect(buildViewExistsQuery('mysql', 'ignored', 'appdb', 'Orders')).toBe(
      'SELECT table_name FROM information_schema.views ' +
        "WHERE table_schema = 'appdb' AND table_name = 'orders' LIMIT 1"
    );
  });
});

// ---------------------------------------------------------------------------
// verifyViewsWritten — catalog read-back
// ---------------------------------------------------------------------------

function ictxStub(overrides: Partial<IntegrationCompileContext> = {}): IntegrationCompileContext {
  return {
    dialect: 'duckdb',
    targetSchema: 'main',
    targetDatabase: undefined,
    integration: { handle: 'lake' },
    ...overrides,
  } as unknown as IntegrationCompileContext;
}

function viewModel(
  name: string,
  opts: { materialization?: string; targetSchema?: string; targetDatabase?: string } = {}
): VerifiableMaterializedModel {
  return {
    node: {
      name,
      materialization: opts.materialization ?? 'view',
      parsedSpec: {
        name,
        target_schema: opts.targetSchema,
        target_database: opts.targetDatabase,
      },
    },
  } as unknown as VerifiableMaterializedModel;
}

function runnerWithQuery(query: SqlRunnerModule['query']): SqlRunnerModule {
  return { run: vi.fn(async () => ({ rowCount: 0 })), query } as unknown as SqlRunnerModule;
}

describe('verifyViewsWritten', () => {
  it('returns no failure when the view exists in the catalog', async () => {
    const query = vi.fn(async () => [{ table_name: 'stg_items' }]);
    const failures = await verifyViewsWritten(
      ictxStub(),
      [viewModel('stg_items')],
      runnerWithQuery(query)
    );

    expect(failures).toEqual([]);
    expect(query).toHaveBeenCalledWith(
      "SELECT table_name FROM information_schema.views WHERE table_schema = 'main' AND table_name = 'stg_items' LIMIT 1"
    );
  });

  it('returns a loud failure when a view that reported success is absent (silent no-op)', async () => {
    const query = vi.fn(async () => [] as Array<Record<string, unknown>>);
    const failures = await verifyViewsWritten(
      ictxStub(),
      [viewModel('stg_items')],
      runnerWithQuery(query)
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.modelName).toBe('stg_items');
    expect(failures[0]?.status).toBe('failed');
    expect(failures[0]?.error).toContain('absent from the warehouse catalog');
    expect(failures[0]?.exitCode).toBe(1);
  });

  it('reads the per-model target_schema / target_database override', async () => {
    const query = vi.fn(async () => [{ table_name: 'v' }]);
    await verifyViewsWritten(
      ictxStub({ dialect: 'snowflake', targetSchema: 'DEFAULT_S' }),
      [viewModel('v', { targetSchema: 'custom_s', targetDatabase: 'custom_db' })],
      runnerWithQuery(query)
    );

    expect(query).toHaveBeenCalledWith(
      'SELECT table_name FROM CUSTOM_DB.INFORMATION_SCHEMA.VIEWS ' +
        "WHERE table_schema = 'CUSTOM_S' AND table_name = 'V' LIMIT 1"
    );
  });

  it('skips gracefully (no failure, warns) when the runner has no query() capability', async () => {
    const onWarn = vi.fn();
    const runner = { run: vi.fn(async () => ({ rowCount: 0 })) } as unknown as SqlRunnerModule;
    const failures = await verifyViewsWritten(ictxStub(), [viewModel('v')], runner, { onWarn });

    expect(failures).toEqual([]);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]?.[0]).toContain('does not expose query()');
  });

  it('does not fail the model when the catalog read itself throws (warns instead)', async () => {
    const onWarn = vi.fn();
    const query = vi.fn(async () => {
      throw new Error('information_schema unavailable');
    });
    const failures = await verifyViewsWritten(
      ictxStub(),
      [viewModel('v')],
      runnerWithQuery(query),
      {
        onWarn,
      }
    );

    expect(failures).toEqual([]);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]?.[0]).toContain('Could not verify view');
  });

  it('ignores non-view materializations (no catalog read)', async () => {
    const query = vi.fn(async () => [] as Array<Record<string, unknown>>);
    const failures = await verifyViewsWritten(
      ictxStub(),
      [viewModel('fct', { materialization: 'table' })],
      runnerWithQuery(query)
    );

    expect(failures).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runProject — flips a silently-missing view to failed
// ---------------------------------------------------------------------------

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeDuckDbViewProject(rootDir: string): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(rootDir, 'view-verify-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'lake.yml'),
    `spec_version: '1'
type: integration
name: lake
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: /tmp/view-verify-not-opened.duckdb
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_items.yml'),
    `spec_version: '0.2'
name: raw_items
type: source
source_type: warehouse_table
connection: lake
table: raw.items
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: name, type: STRING }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_items.yml'),
    `spec_version: '0.2'
name: stg_items
type: model
description: Staged items.
grain: id
source:
  ref: lake.raw_items
columns:
  - { name: id, expr: id, primary_key: true }
  - { name: name, expr: name }
materialization:
  type: view
`
  );
  return projectDir;
}

function makeDuckRunner(viewExists: boolean) {
  const run = vi.fn(async () => ({ rowCount: 0 }));
  const query = vi.fn(async () => (viewExists ? [{ table_name: 'stg_items' }] : []));
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('duckdb', 'file', async () => ({ run, query }));
  return { customRunners, run, query };
}

describe('runProject view-write verification', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-model-spec-view-verify-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('flips a view that reported success but is absent from the catalog to failed', async () => {
    const projectDir = await writeDuckDbViewProject(tmpDir);
    const { customRunners, run, query } = makeDuckRunner(false);

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
    });

    // CREATE OR REPLACE VIEW "succeeded" on the runner...
    expect(run).toHaveBeenCalled();
    // ...but the catalog read-back found nothing, so the run is marked failed.
    expect(query).toHaveBeenCalledWith(
      "SELECT table_name FROM information_schema.views WHERE table_schema = 'main' AND table_name = 'stg_items' LIMIT 1"
    );
    expect(result.ok).toBe(false);

    const modelResult = result.byIntegration[0]?.executionResults?.find(
      (r) => r.modelName === 'stg_items'
    );
    expect(modelResult?.status).toBe('failed');
    expect(modelResult?.error).toContain('absent from the warehouse catalog');

    // The no-op view's stale success must not be written to run state.
    expect(result.state?.models['lake.stg_items']).toBeUndefined();
  });

  it('keeps a view that exists in the catalog as a successful run', async () => {
    const projectDir = await writeDuckDbViewProject(tmpDir);
    const { customRunners } = makeDuckRunner(true);

    const result = await runProject(projectDir, {
      integration: 'lake',
      customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    const modelResult = result.byIntegration[0]?.executionResults?.find(
      (r) => r.modelName === 'stg_items'
    );
    expect(modelResult?.status).toBe('success');
    expect(result.state?.models['lake.stg_items']).toBeDefined();
  });
});
