import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildDuckDbRunner,
  CustomRunnerRegistry,
  SqlCancelledError,
} from '@bobsled-inc/connections';
import { runProject } from '@bobsled-inc/model-spec/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishCrossWarehouse } from '../../../src/runtime/cross-warehouse.js';
import { resolvePublishTarget } from '../../../src/runtime/cross-warehouse-destinations.js';

import type { DuckDbIntegration } from '@bobsled-inc/connections';
import type {
  CrossWarehousePublishContext,
  PlannedPublishedModel,
  ResolvedIntegration,
} from '@bobsled-inc/model-spec/project';

let tmpDir = '';

function duckIntegration(name: string, dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath, read_only: false },
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function seedDuckDb(integration: DuckDbIntegration, sql: string[]): Promise<void> {
  const runner = await buildDuckDbRunner(integration);
  try {
    for (const statement of sql) {
      await runner.run(statement);
    }
  } finally {
    await runner.close?.();
  }
}

async function queryDuckDb(
  integration: DuckDbIntegration,
  sql: string
): Promise<Record<string, unknown>[]> {
  const runner = await buildDuckDbRunner(integration);
  try {
    return await runner.query!(sql);
  } finally {
    await runner.close?.();
  }
}

async function writeProject(
  projectDir: string,
  paths: { crm: string; orders: string; mart: string },
  opts: { martStagingUri?: string } = {}
) {
  await writeFile(
    path.join(projectDir, 'integrations', 'crm.yml'),
    `spec_version: '1'
type: integration
name: crm
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(paths.crm)}
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'orders.yml'),
    `spec_version: '1'
type: integration
name: orders
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(paths.orders)}
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'mart.yml'),
    `spec_version: '1'
type: integration
name: mart
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(paths.mart)}
${opts.martStagingUri ? `cross_warehouse_staging:\n  uri: ${JSON.stringify(opts.martStagingUri)}\n` : ''}
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'customers.yml'),
    `spec_version: '0.2'
name: customers
type: source
source_type: warehouse_table
connection: crm
table: main.customers
schema:
  columns:
    - { name: customer_id, type: integer, primary_key: true }
    - { name: email, type: string }
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'orders.yml'),
    `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: orders
table: main.orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'customer_orders.yml'),
    `spec_version: '0.2'
name: customer_orders
type: model
description: Published customer order mart.
grain: order_id
publish: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: table
`
  );
}

describe('publishCrossWarehouse', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-xwh-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('defaults Postgres publish target SSL to enabled unless explicitly disabled', async () => {
    const integrationFile = {
      spec_version: '1' as const,
      type: 'integration' as const,
      name: 'mart',
      source_type: 'postgres' as const,
      connection: {
        host: 'db.example.com',
        port: 5432,
        database: 'warehouse',
      },
      auth: {
        type: 'password' as const,
        user: 'loader',
        password: 'secret-password',
      },
    };
    const integration = {
      handle: 'mart',
      dialect: 'postgres',
      targetSchema: 'analytics',
      integration: integrationFile,
    } satisfies ResolvedIntegration;
    const model = {
      targetHandle: 'mart',
      node: {
        name: 'customer_orders',
        parsedSpec: { name: 'customer_orders' },
      },
    } as PlannedPublishedModel;
    const context = {
      project: {
        integrations: new Map([['mart', integration]]),
      },
      state: { models: {} },
      secretResolver: { resolve: async () => '' },
    } as CrossWarehousePublishContext;

    const enabled = await resolvePublishTarget(model, context);
    expect(enabled.config).toMatchObject({ dest: 'postgres', ssl: true });

    const disabled = await resolvePublishTarget(model, {
      ...context,
      project: {
        integrations: new Map([
          [
            'mart',
            {
              ...integration,
              integration: {
                ...integrationFile,
                connection: { ...integrationFile.connection, ssl: { mode: 'disable' as const } },
              },
            },
          ],
        ]),
      },
    } as CrossWarehousePublishContext);
    expect(disabled.config).toMatchObject({ dest: 'postgres', ssl: false });
  });

  it('normalizes Databricks workspace URLs before building publish target config', async () => {
    const integration = {
      handle: 'mart',
      dialect: 'databricks',
      targetSchema: 'analytics',
      integration: {
        spec_version: '1',
        type: 'integration',
        name: 'mart',
        source_type: 'databricks',
        connection: {
          workspace_url: ' HTTPS://example.cloud.databricks.com/sql/warehouses?o=123 ',
          http_path: '/sql/1.0/warehouses/abc',
          catalog: 'main',
        },
        auth: { type: 'pat', token: 'secret-token' },
      },
    } satisfies ResolvedIntegration;
    const model = {
      targetHandle: 'mart',
      node: {
        name: 'customer_orders',
        parsedSpec: { name: 'customer_orders' },
      },
    } as PlannedPublishedModel;
    const context = {
      project: {
        integrations: new Map([['mart', integration]]),
      },
      state: { models: {} },
      secretResolver: { resolve: async () => '' },
    } as CrossWarehousePublishContext;

    await expect(resolvePublishTarget(model, context)).resolves.toMatchObject({
      database: 'main',
      config: { dest: 'databricks', serverHostname: 'example.cloud.databricks.com' },
    });
  });

  it('publishes a DuckDB + DuckDB model into a DuckDB target on every run', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com'), (2, 'b@example.com')",
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5), (11, 2, 40.0)',
    ]);

    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, paths);

    const tokenProvider = vi.fn(async () => ({
      accessToken: 'managed-token',
      expiresAt: 3_600,
    }));
    const runnerContexts: Array<{ tokenProvider?: unknown; queryTag?: string }> = [];
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async (integration, context) => {
      runnerContexts.push(context);
      if (integration.source_type !== 'duckdb') throw new Error('Expected DuckDB integration');
      return buildDuckDbRunner(integration);
    });

    const first = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
      customRunners,
      tokenProvider,
      queryTag: 'custom:model-run:123',
    });
    expect(first.ok).toBe(true);
    expect(runnerContexts.some((context) => context.tokenProvider === tokenProvider)).toBe(true);
    expect(runnerContexts.every((context) => context.queryTag === 'custom:model-run:123')).toBe(
      true
    );
    expect(first.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });

    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT order_id, customer_id, email, amount FROM main.customer_orders ORDER BY order_id'
      )
    ).resolves.toEqual([
      { order_id: 10n, customer_id: 1n, email: 'a@example.com', amount: 25.5 },
      { order_id: 11n, customer_id: 2n, email: 'b@example.com', amount: 40 },
    ]);

    const second = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(second.ok).toBe(true);
    expect(second.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });

    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'UPDATE orders SET amount = 50.25 WHERE order_id = 10',
    ]);

    const changed = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(changed.ok).toBe(true);
    expect(changed.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT order_id, customer_id, email, amount FROM main.customer_orders ORDER BY order_id'
      )
    ).resolves.toEqual([
      { order_id: 10n, customer_id: 1n, email: 'a@example.com', amount: 50.25 },
      { order_id: 11n, customer_id: 2n, email: 'b@example.com', amount: 40 },
    ]);

    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'ALTER TABLE orders ADD COLUMN note VARCHAR',
      "UPDATE orders SET note = 'unused'",
    ]);

    const schemaExpanded = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(schemaExpanded.ok).toBe(true);
    expect(schemaExpanded.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });

    await seedDuckDb(duckIntegration('orders', paths.orders), ['DELETE FROM orders']);

    const empty = await runProject(projectDir, {
      integration: 'mart',
      fullRefresh: true,
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(empty.ok).toBe(true);
    expect(empty.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT COUNT(*) AS c FROM main.customer_orders'
      )
    ).resolves.toEqual([{ c: 0n }]);
  });

  it('uses DuckDB UNLOAD substrate when the publish target has staging configured', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com')",
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5)',
    ]);

    const projectDir = path.join(tmpDir, 'project-unload');
    const warnings: string[] = [];
    await writeProject(projectDir, paths, { martStagingUri: path.join(tmpDir, 'xwh-stage') });

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.ok).toBe(true);
    expect(warnings).toEqual([]);
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT order_id, email, amount FROM main.customer_orders ORDER BY order_id'
      )
    ).resolves.toEqual([{ order_id: 10n, email: 'a@example.com', amount: 25.5 }]);
  });

  it('executes recreate preDdl on the destination before CREATE TABLE so view→table publish transitions succeed', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com')",
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5)',
    ]);
    // Pre-create a VIEW on the destination with the published model's name so
    // a plain `CREATE TABLE main.customer_orders AS ...` would collide. Only
    // the preDdl `DROP VIEW IF EXISTS` can unblock the publish.
    await seedDuckDb(duckIntegration('mart', paths.mart), [
      'CREATE TABLE legacy_source (id BIGINT)',
      'CREATE VIEW main.customer_orders AS SELECT 0::BIGINT AS order_id, 0::BIGINT AS customer_id, NULL::VARCHAR AS email, 0::DOUBLE AS amount FROM legacy_source',
    ]);

    const projectDir = path.join(tmpDir, 'project-recreate');
    await writeProject(projectDir, paths);
    // Synthesize prior state showing the destination previously held a `view`
    // for this published model. `planTransition` returns `kind: 'recreate'`
    // carrying a DROP VIEW preDdl that must execute before CREATE TABLE.
    await writeFile(
      path.join(projectDir, '.dogsled/model-spec', 'run-state.json'),
      JSON.stringify({
        models: {
          'mart.customer_orders': {
            lastRunAt: '2026-05-01T00:00:00.000Z',
            materialization: 'view',
            specChecksum: 'previous',
            selectSignature: 'previous',
            columns: [],
          },
        },
      })
    );

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });

    expect(result.ok).toBe(true);
    expect(result.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
    });

    // Verify the destination object is now a TABLE (not a view) and holds the
    // newly published row, proving the DROP VIEW preDdl actually ran.
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        "SELECT table_type FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'customer_orders'"
      )
    ).resolves.toEqual([{ table_type: 'BASE TABLE' }]);
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT order_id, email, amount FROM main.customer_orders ORDER BY order_id'
      )
    ).resolves.toEqual([{ order_id: 10n, email: 'a@example.com', amount: 25.5 }]);
  });

  it('supports incremental materialization and prunes the driving source with cursor_field', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com'), (2, 'b@example.com'), (3, 'c@example.com')",
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5), (11, 2, 40.0)',
    ]);

    const projectDir = path.join(tmpDir, 'project-incremental');
    await writeProject(projectDir, paths);
    await writeFile(
      path.join(projectDir, 'models', 'customer_orders.yml'),
      `spec_version: '0.2'
name: customer_orders
type: model
description: Published customer order mart.
grain: order_id
publish: mart
source:
  ref: orders.orders
joins:
  - ref: crm.customers
    type: left
    on: orders.orders.customer_id = crm.customers.customer_id
columns:
  - { name: order_id, expr: orders.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: orders.orders.customer_id, type: integer }
  - { name: email, expr: crm.customers.email, type: string }
  - { name: amount, expr: orders.orders.amount, type: number }
materialization:
  type: incremental
  strategy: merge
  unique_key: order_id
  cursor_field: order_id
`
    );

    const first = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(first.ok).toBe(true);

    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'UPDATE orders SET amount = 99.0 WHERE order_id = 10',
      'INSERT INTO orders VALUES (12, 3, 75.0)',
    ]);
    const second = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(second.ok).toBe(true);

    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT order_id, amount FROM main.customer_orders ORDER BY order_id'
      )
    ).resolves.toEqual([
      { order_id: 10n, amount: 25.5 },
      { order_id: 11n, amount: 40 },
      { order_id: 12n, amount: 75 },
    ]);
  });

  it('flushes published rows in more than one chunk without retaining the full result set', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders SELECT i, i, i * 1.0 FROM range(0, 10005) AS t(i)',
    ]);
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers SELECT i, 'user-' || i::VARCHAR || '@example.com' FROM range(0, 10005) AS t(i)",
    ]);

    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, paths);

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    expect(result.ok).toBe(true);
    expect(result.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'success',
      rowsAffected: 10005,
    });
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        'SELECT COUNT(*) AS c FROM main.customer_orders'
      )
    ).resolves.toEqual([{ c: 10005n }]);
  });

  it('drops stage tables on the destination even when the post-stage runner re-open fails', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
      "INSERT INTO customers VALUES (1, 'a@example.com')",
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5)',
    ]);

    const projectDir = path.join(tmpDir, 'project-reopen-fail');
    await writeProject(projectDir, paths);

    // Custom runner factory: real DuckDB for sources and the first `mart`
    // call; throw on the second `mart` call (publisher's post-stage re-open).
    // This forces the cleanup path to handle a closed/unusable cached
    // destination runner without leaking stage tables on the warehouse.
    const martCalls = { count: 0 };
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async (integration) => {
      if (integration.name === 'mart') {
        martCalls.count += 1;
        if (martCalls.count === 2) {
          throw new Error('simulated re-open failure');
        }
      }
      return buildDuckDbRunner(integration as DuckDbIntegration);
    });

    const warnings: string[] = [];
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
      customRunners,
      onWarn: (message) => warnings.push(message),
    });

    expect(result.ok).toBe(false);
    expect(martCalls.count).toBeGreaterThanOrEqual(2);
    expect(result.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'failed',
    });

    // Stage tables follow the `_xwh_stage_*` prefix on the destination.
    // The cleanup path MUST drop them despite the re-open failure.
    const stagedTables = await queryDuckDb(
      duckIntegration('mart', paths.mart),
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name LIKE '_xwh_stage_%'"
    );
    expect(stagedTables).toEqual([]);
  });

  it('reports failed status with a structured error when a source extract fails', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    // Seed the orders database but intentionally omit the customers table on
    // the CRM database. The model references `crm.customers`, so the source
    // staging step must fail with a clear, surfaced error rather than crashing
    // or leaking secrets/stack traces.
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
      'INSERT INTO orders VALUES (10, 1, 25.5)',
    ]);
    // Touch the CRM file so resolveRunner can open it, but skip creating the
    // `customers` table. Loading the SELECT will fail.
    await seedDuckDb(duckIntegration('crm', paths.crm), ['CREATE TABLE placeholder (id BIGINT)']);

    const projectDir = path.join(tmpDir, 'project');
    await writeProject(projectDir, paths);

    const errors: string[] = [];
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
      onError: (message) => errors.push(message),
    });

    expect(result.ok).toBe(false);
    expect(result.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_orders',
      status: 'failed',
    });
    const failure = result.byIntegration[0]!.executionResults![0]!;
    expect(failure.error).toBeTruthy();
    expect(failure.error).not.toContain('undefined');
    expect(errors.some((message) => message.includes('customer_orders'))).toBe(true);
  });

  it('forwards cancellation through an active source stream and closes every runner', async () => {
    const paths = {
      crm: path.join(tmpDir, 'crm.duckdb'),
      orders: path.join(tmpDir, 'orders.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    await seedDuckDb(duckIntegration('crm', paths.crm), [
      'CREATE TABLE customers (customer_id BIGINT, email VARCHAR)',
    ]);
    await seedDuckDb(duckIntegration('orders', paths.orders), [
      'CREATE TABLE orders (order_id BIGINT, customer_id BIGINT, amount DOUBLE)',
    ]);
    const projectDir = path.join(tmpDir, 'project-cancel-publish');
    await writeProject(projectDir, paths);

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sourceClose = vi.fn(async () => {});
    const seenSignals: Array<AbortSignal | undefined> = [];
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async (integration) => {
      if (integration.name !== 'orders') {
        return buildDuckDbRunner(integration as DuckDbIntegration);
      }
      return {
        run: async () => ({ rowCount: 0 }),
        close: sourceClose,
        streamQueryRows: (_sql: string, _params?: unknown, options?: { signal?: AbortSignal }) => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                seenSignals.push(options?.signal);
                markStarted();
                return new Promise<IteratorResult<Record<string, unknown>>>((_resolve, reject) => {
                  const rejectCancelled = () =>
                    reject(new SqlCancelledError('source stream cancelled by driver'));
                  if (options?.signal?.aborted) rejectCancelled();
                  else options?.signal?.addEventListener('abort', rejectCancelled, { once: true });
                });
              },
              return: async () => ({ done: true as const, value: undefined }),
            };
          },
        }),
      };
    });

    const pending = runProject(projectDir, {
      integration: 'mart',
      state: { models: {} },
      signal: controller.signal,
      customRunners,
      crossWarehousePublisher: publishCrossWarehouse,
    });
    await started;
    controller.abort();

    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.byIntegration[0]?.executionResults?.[0]?.status).toBe('cancelled');
    expect(result.state.models['mart.customer_orders']).toBeUndefined();
    expect(seenSignals).toEqual([controller.signal]);
    expect(sourceClose).toHaveBeenCalledOnce();
  });
});
