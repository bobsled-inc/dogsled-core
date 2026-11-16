import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDuckDbRunner,
  type BigQueryIntegration,
  type DuckDbIntegration,
} from '@bobsled-inc/connections';
import { readCsv } from '@bobsled-inc/model-spec';
import { loadSeeds } from '@bobsled-inc/model-spec/project';

export interface SmokeConfig {
  projectId: string;
  location: string;
  datasetId: string;
  tableId: string;
  shouldDropDataset: boolean;
}

const packageDir = fileURLToPath(new URL('..', import.meta.url));
export const fixtureDir = path.join(
  packageDir,
  'tests/unit/runtime/fixtures/cross-warehouse-bigquery-duckdb'
);

export function duckIntegration(name: string, dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath, read_only: false },
  };
}

export function bigQueryIntegration(config: SmokeConfig): BigQueryIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'bigquery',
    source_type: 'bigquery',
    connection: {
      project_id: config.projectId,
      dataset: config.datasetId,
      default_location: config.location,
    },
    auth: { type: 'adc' },
  };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function writeSmokeProject(
  projectDir: string,
  config: SmokeConfig,
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
  project_id: ${JSON.stringify(config.projectId)}
  dataset: ${config.datasetId}
  default_location: ${config.location}
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
table: ${config.datasetId}.${config.tableId}
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
description: Joined order rows from BigQuery orders and local DuckDB customers.
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

export async function loadDuckDbSeed(projectDir: string, dbPath: string): Promise<void> {
  const runner = await buildDuckDbRunner(duckIntegration('local', dbPath));
  try {
    const result = await loadSeeds(projectDir, {
      dialect: 'duckdb',
      schema: 'main',
      runner: runner.run,
    });
    if (!result.ok) {
      throw new Error(`DuckDB seed load failed: ${JSON.stringify(result.seeds)}`);
    }
  } finally {
    await runner.close?.();
  }
}

export async function readOrdersCsv(): Promise<Array<Record<string, string>>> {
  const csv = await fs.readFile(path.join(fixtureDir, 'orders.csv'), 'utf-8');
  const parsed = readCsv(csv, {
    delimiter: ',',
    expectedColumns: ['order_id', 'customer_id', 'amount', 'order_date'],
  });
  return parsed.rows.map((row) => ({
    order_id: row[0] ?? '',
    customer_id: row[1] ?? '',
    amount: row[2] ?? '',
    order_date: row[3] ?? '',
  }));
}

export async function queryDuckDb(
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
