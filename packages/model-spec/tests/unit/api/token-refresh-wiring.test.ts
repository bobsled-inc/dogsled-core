/**
 * `runProject` forwards the refreshable managed-credential provider through
 * `resolveRunner` into the runner factory context — so a long-running Model Spec model
 * run refreshes its short-lived warehouse token mid-run (the runner-level
 * proactive + reactive proof lives in `@bobsled-inc/connections`'s
 * snowflake/bigquery runner tests). We capture the context a DuckDB custom
 * runner is built with, keeping the test free of native drivers while
 * exercising the real threading path. Precedence:
 * `tokenProvider` > `credentialsTokenCommand` > `BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CustomRunnerRegistry,
  type BigQueryTokenProvider,
  type RunnerFactoryContext,
} from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeMinimalProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'tok-'));
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

describe('runProject — refreshable token wiring', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-tok-'));
  });

  afterEach(async () => {
    delete process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('forwards opts.tokenProvider into the runner factory context', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();
    const tokenProvider: BigQueryTokenProvider = vi.fn(async () => ({
      accessToken: 'tok-1',
      expiresAt: 10_000,
    }));

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
      tokenProvider,
    });

    expect(result.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.tokenProvider).toBe(tokenProvider);
  });

  it('builds a provider from credentialsTokenCommand when no provider is given', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
      credentialsTokenCommand: 'echo "{}"',
    });

    expect(result.ok).toBe(true);
    expect(typeof contexts[0]?.tokenProvider).toBe('function');
  });

  it('falls back to BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND for the standalone/Cloud Run path', async () => {
    process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'] = 'mint-token.sh';
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(typeof contexts[0]?.tokenProvider).toBe('function');
  });

  it('leaves the factory context tokenProvider undefined when nothing is configured', async () => {
    const projectDir = await writeMinimalProject();
    const { customRunners, contexts } = makeCapturingRunner();

    const result = await runProject(projectDir, {
      integration: 'duckdb',
      state: { models: {} },
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(contexts[0]?.tokenProvider).toBeUndefined();
  });
});
