import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDuckDbRunner,
  CustomRunnerRegistry,
  type DuckDbIntegration,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { readCsv } from '@bobsled-inc/model-spec';
import { loadSeeds, runProject } from '@bobsled-inc/model-spec/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { publishCrossWarehouse } from '../../../src/runtime/cross-warehouse.js';

const fixtureDir = fileURLToPath(
  new URL('./fixtures/cross-warehouse-bigquery-duckdb/', import.meta.url)
);

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

async function writeSmokeProject(
  projectDir: string,
  paths: { local: string; mart: string }
): Promise<void> {
  await writeFile(
    path.join(projectDir, 'integrations', 'local.yml'),
    `spec_version: '1'
type: integration
name: local
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: ${JSON.stringify(paths.local)}
`
  );
  await writeFile(
    path.join(projectDir, 'integrations', 'bigquery.yml'),
    `spec_version: '1'
type: integration
name: bigquery
source_type: bigquery
connection:
  project_id: mock_project
  dataset: bq_seed
  default_location: US
auth:
  type: adc
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
`
  );
  await writeFile(
    path.join(projectDir, 'seeds', 'customers.yml'),
    `spec_version: '0.2'
name: customers
type: seed
payload:
  format: csv
  path: data/customers.csv
schema:
  columns:
    - { name: customer_id, type: integer, primary_key: true }
    - { name: email, type: string }
    - { name: region, type: string }
`
  );
  await fs.mkdir(path.join(projectDir, 'seeds', 'data'), { recursive: true });
  await fs.copyFile(
    path.join(fixtureDir, 'customers.csv'),
    path.join(projectDir, 'seeds', 'data', 'customers.csv')
  );
  await writeFile(
    path.join(projectDir, 'sources', 'local', 'customers.yml'),
    `spec_version: '0.2'
name: customers
type: source
source_type: warehouse_table
connection: local
table: main.customers
schema:
  columns:
    - { name: customer_id, type: integer, primary_key: true }
    - { name: email, type: string }
    - { name: region, type: string }
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'bigquery', 'orders.yml'),
    `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: bigquery
table: bq_seed.orders
schema:
  columns:
    - { name: order_id, type: integer, primary_key: true }
    - { name: customer_id, type: integer }
    - { name: amount, type: number }
    - { name: order_date, type: string }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'customer_order_revenue.yml'),
    `spec_version: '0.2'
name: customer_order_revenue
type: model
description: Joined order rows from mocked BigQuery orders and local DuckDB customers.
grain: order_id
publish: mart
source:
  ref: bigquery.orders
joins:
  - ref: local.customers
    type: left
    on: bigquery.orders.customer_id = local.customers.customer_id
columns:
  - { name: order_id, expr: bigquery.orders.order_id, type: integer, primary_key: true }
  - { name: customer_id, expr: bigquery.orders.customer_id, type: integer }
  - { name: email, expr: local.customers.email, type: string }
  - { name: region, expr: local.customers.region, type: string }
  - { name: amount, expr: bigquery.orders.amount, type: number }
  - { name: order_date, expr: bigquery.orders.order_date, type: string }
materialization:
  type: table
`
  );
}

async function loadDuckDbSeed(projectDir: string, dbPath: string): Promise<void> {
  const runner = await buildDuckDbRunner(duckIntegration('local', dbPath));
  try {
    const result = await loadSeeds(projectDir, {
      dialect: 'duckdb',
      schema: 'main',
      runner: runner.run,
    });
    expect(result.ok).toBe(true);
    expect(result.seeds).toEqual([
      expect.objectContaining({ name: 'customers', executed: true, rowsLoaded: 3 }),
    ]);
  } finally {
    await runner.close?.();
  }
}

async function readMockBigQueryOrders(): Promise<Record<string, unknown>[]> {
  const csv = await fs.readFile(path.join(fixtureDir, 'orders.csv'), 'utf-8');
  const parsed = readCsv(csv, {
    delimiter: ',',
    expectedColumns: ['order_id', 'customer_id', 'amount', 'order_date'],
  });
  return parsed.rows.map((row) => ({
    order_id: Number(row[0]),
    customer_id: Number(row[1]),
    amount: Number(row[2]),
    order_date: row[3]!,
  }));
}

function mockBigQueryRunner(queryLog: string[]): SqlRunnerModule {
  return {
    run: async (sql) => {
      queryLog.push(sql);
      return {};
    },
    query: async (sql) => {
      queryLog.push(sql);
      expect(sql).toBe(
        'SELECT `order_id`, `customer_id`, `amount`, `order_date` FROM bq_seed.orders'
      );
      return readMockBigQueryOrders();
    },
    supportsBindings: true,
    close: async () => undefined,
  };
}

describe('cross-warehouse BigQuery + DuckDB smoke', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-xwh-bq-duck-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('publishes a model spanning mocked BigQuery seed data and local DuckDB seed data', async () => {
    const paths = {
      local: path.join(tmpDir, 'local.duckdb'),
      mart: path.join(tmpDir, 'mart.duckdb'),
    };
    const projectDir = path.join(tmpDir, 'project');
    await writeSmokeProject(projectDir, paths);
    await loadDuckDbSeed(projectDir, paths.local);

    const bigQueryQueries: string[] = [];
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('bigquery', 'adc', async () => mockBigQueryRunner(bigQueryQueries));

    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
      customRunners,
    });

    expect(result.ok).toBe(true);
    expect(result.byIntegration[0]?.executionResults?.[0]).toMatchObject({
      modelName: 'customer_order_revenue',
      status: 'success',
      rowsAffected: 3,
    });
    expect(bigQueryQueries).toContain(
      'SELECT `order_id`, `customer_id`, `amount`, `order_date` FROM bq_seed.orders'
    );
    await expect(
      queryDuckDb(
        duckIntegration('mart', paths.mart),
        [
          'SELECT order_id, customer_id, email, region, amount, order_date',
          'FROM main.customer_order_revenue',
          'ORDER BY order_id',
        ].join(' ')
      )
    ).resolves.toEqual([
      {
        order_id: 1001n,
        customer_id: 1n,
        email: 'ada@example.com',
        region: 'north',
        amount: 120.5,
        order_date: '2026-05-01',
      },
      {
        order_id: 1002n,
        customer_id: 1n,
        email: 'ada@example.com',
        region: 'north',
        amount: 35,
        order_date: '2026-05-02',
      },
      {
        order_id: 1003n,
        customer_id: 2n,
        email: 'beau@example.com',
        region: 'west',
        amount: 88.25,
        order_date: '2026-05-02',
      },
    ]);
  });
});
