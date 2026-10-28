/**
 * `runProject({ warehouse })` threads the session warehouse override through
 * `resolveRunner` into the runner factory context. The Snowflake runner reads
 * `context.warehouse` to override the connection default; here we use a DuckDB
 * custom runner to capture the context the resolver passes, so the test stays
 * free of native drivers and exercises the real threading path.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry, type RunnerFactoryContext } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeMinimalProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'wh-override-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'duckdb.yml'),
    `spec_version: '1'
type: integration
name: duckdb
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'db.duckdb'))}
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_orders.yml'),
    `spec_version: '0.2'
name: raw_orders
type: source
source_type: warehouse_table
connection: duckdb
table: main.raw_orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_orders.yml'),
    `spec_version: '0.2'
name: stg_orders
type: model
description: Staging orders.
grain: order_id
source:
  ref: duckdb.raw_orders
columns:
  - { name: order_id, expr: duckdb.raw_orders.order_id, type: integer, primary_key: true }
materialization:
  type: view
`
  );
  return projectDir;
}

/** Custom runner that records the factory context it was built with. */
function makeCapturingRunner() {
  const contexts: RunnerFactoryContext[] = [];
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('duckdb', 'file', async (_integration, context) => {
    contexts.push(context);
    return { run: vi.fn(async () => ({ rowCount: 0 })), close: vi.fn(async () => {}) };
  });
  return { customRunners, contexts };
}

describe('runProject — runner context overrides', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-wh-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('forwards opts.warehouse into the runner factory context', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
      warehouse: 'BIG_WH',
    });

    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.warehouse).toBe('BIG_WH');
  });

  it('leaves the factory context warehouse undefined when no override is given', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.warehouse).toBeUndefined();
  });

  it('forwards opts.queryTag into the runner factory context', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
      queryTag: 'custom:model-run:123',
    });

    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.queryTag).toBe('custom:model-run:123');
  });

  it('leaves the factory context queryTag undefined when no tag is given', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.queryTag).toBeUndefined();
  });
});
