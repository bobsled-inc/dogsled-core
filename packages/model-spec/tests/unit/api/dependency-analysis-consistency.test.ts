import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DogsledRuntimeError } from '@bobsled-inc/protocol';
import { analyzeDeployedModelProject } from '../../../src/api/deployed-model-plan.js';
import { loadProject } from '../../../src/api/load-project.js';
import { analyzeModelDependencies } from '../../../src/compiler/model-dependency-analysis.js';

function liveSource(connection: string, name: string): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'source',
    source_type: 'api_resource',
    integration: `${connection}_integration`,
    resource: name,
    connection,
    mode: 'live',
    schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
  };
}

function warehouseSource(connection: string, name: string): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'source',
    source_type: 'warehouse_table',
    connection,
    table: `main.${name}`,
    schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
  };
}

function model(
  name: string,
  source: string,
  joins: Array<{ ref: string; alias?: string; on: string }> = []
): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'model',
    description: `${name} model`,
    grain: 'id',
    source: { ref: source },
    joins: joins.map((join) => ({ type: 'left', ...join })),
    columns: [{ name: 'id', expr: 'id' }],
    materialization: { type: 'view' },
  };
}

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function writeProject(
  sources: readonly Record<string, unknown>[],
  models: readonly Record<string, unknown>[]
): Promise<string> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dependency-consistency-'));
  await fs.mkdir(path.join(tempRoot, 'sources'));
  await fs.mkdir(path.join(tempRoot, 'models'));
  await fs.writeFile(
    path.join(tempRoot, 'model-spec.yml'),
    'sources_dir: sources\nmodels_dir: models\n'
  );
  await Promise.all([
    ...sources.map((source, index) =>
      fs.writeFile(path.join(tempRoot!, 'sources', `source-${index}.yml`), JSON.stringify(source))
    ),
    ...models.map((definition, index) =>
      fs.writeFile(path.join(tempRoot!, 'models', `model-${index}.yml`), JSON.stringify(definition))
    ),
  ]);
  return tempRoot;
}

async function analyzeFileProject(
  sources: readonly Record<string, unknown>[],
  models: readonly Record<string, unknown>[]
) {
  const projectRoot = await writeProject(sources, models);
  const project = await loadProject(projectRoot, {
    skipIntegrations: true,
    skipEntities: true,
  });
  const result = analyzeModelDependencies({
    models: project.models.map((node) => node.parsedSpec),
    sourceEntries: project.sourceEntries,
  });
  if (!result.ok) throw new Error(result.error);
  return result.analyses;
}

describe('file and in-memory dependency analysis consistency', () => {
  const cases = [
    {
      name: 'direct live dependencies',
      sources: [liveSource('api', 'users')],
      models: [model('users_live', 'api.users')],
    },
    {
      name: 'transitive live dependencies',
      sources: [liveSource('api', 'users')],
      models: [model('users_live', 'api.users'), model('users_rollup', 'USERS_LIVE')],
    },
    {
      name: 'mixed roots',
      sources: [liveSource('lake', 'users'), warehouseSource('lake', 'orders')],
      models: [
        model('orders_with_users', 'lake.orders', [
          { ref: 'lake.users', alias: 'users', on: 'lake.orders.id = lake.users.id' },
        ]),
      ],
    },
    {
      name: 'materialized-only roots',
      sources: [warehouseSource('sales', 'orders')],
      models: [model('orders_rollup', 'sales.orders')],
    },
    {
      name: 'case differences',
      sources: [liveSource('CRM', 'Users')],
      models: [model('users_live', 'cRm.uSeRs')],
    },
    {
      name: 'duplicate source names under different Connections',
      sources: [liveSource('Product', 'Users'), liveSource('Support', 'Users')],
      models: [
        {
          ...model('joined_users', 'product.users', [
            {
              ref: 'SUPPORT.USERS',
              alias: 'support_users',
              on: 'product.users.id = SUPPORT.USERS.id',
            },
          ]),
          execution: { engine: 'duckdb_engine' },
        },
      ],
    },
  ];

  for (const scenario of cases) {
    it(`returns the same result for ${scenario.name}`, async () => {
      const fileResult = await analyzeFileProject(scenario.sources, scenario.models);
      const memoryResult = analyzeDeployedModelProject({
        sources: scenario.sources,
        models: scenario.models,
      });

      expect(fileResult).toEqual(memoryResult);
    });
  }

  it('rejects cycles through both entry points', async () => {
    const models = [model('model_a', 'model_b'), model('model_b', 'model_a')];

    const error = await analyzeFileProject([], models).catch(
      (value) => value as DogsledRuntimeError
    );
    expect(error).toMatchObject({ kind: 'validation' });
    expect(error.cause?.message).toMatch(/circular|cycle/i);
    expect(() => analyzeDeployedModelProject({ sources: [], models })).toThrow(/circular|cycle/i);
  });

  it('rejects missing references through both entry points', async () => {
    const models = [model('broken_model', 'missing_model')];

    const error = await analyzeFileProject([], models).catch(
      (value) => value as DogsledRuntimeError
    );
    expect(error).toMatchObject({ kind: 'validation' });
    expect(error.cause?.message).toMatch(/unknown/i);
    expect(() => analyzeDeployedModelProject({ sources: [], models })).toThrow(/unknown/i);
  });
});

it('keeps adaptive API tools out of SQL hydration while retaining their DAG references', async () => {
  const agent = {
    spec_version: '0.2',
    type: 'model',
    model_kind: 'agentic',
    name: 'research',
    description: 'Research prepared accounts.',
    grain: ['id'],
    sources: { accounts: { ref: 'db.accounts' }, web: { ref: 'api.search' } },
    llm: { profile: 'research' },
    limits: { tokens: 10000, timeout_seconds: 600 },
    plan: {
      steps: [
        {
          id: 'assess',
          source: { ref: 'accounts' },
          map: { over: 'accounts', group_by: ['id'] },
          execution: { mode: 'agent_loop' },
          context_sources: ['web'],
          instructions: 'Read public evidence.',
          columns: [{ name: 'id', type: 'integer', nullable: false }],
        },
      ],
    },
    output: { from: 'assess' },
    materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['id'] },
  };
  const root = await writeProject(
    [warehouseSource('db', 'accounts'), liveSource('api', 'search')],
    [agent, model('summary', 'research')]
  );
  const project = await loadProject(root, { skipIntegrations: true, skipEntities: true });
  expect(project.models.find((node) => node.name === 'research')!.sourceRefs).toContain(
    'api.search'
  );
  const result = analyzeModelDependencies({
    models: project.models.map((node) => node.parsedSpec),
    sourceEntries: project.sourceEntries,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  for (const analysis of result.analyses) {
    expect(analysis.executionMode).toBe('materialized');
    expect(analysis.closure.sources).toEqual(['db.accounts']);
  }
});
