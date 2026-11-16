import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveRunner, type SqlRunnerModule } from '@bobsled-inc/connections';
import { runProject } from '@bobsled-inc/model-spec/project';

import {
  bigQueryIntegration,
  duckIntegration,
  loadDuckDbSeed,
  queryDuckDb,
  readOrdersCsv,
  writeSmokeProject,
  type SmokeConfig,
} from './cross-warehouse-bigquery-duckdb-project.js';
import { publishCrossWarehouse } from '../src/runtime/cross-warehouse.js';

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

let stepNumber = 0;

function step(message: string): void {
  stepNumber += 1;
  info(`[${new Date().toISOString()}] Step ${stepNumber}: ${message}`);
}

function detail(message: string): void {
  info(`  - ${message}`);
}

function formatJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
    2
  );
}

function fail(message: string): never {
  throw new Error(message);
}

function readConfig(): SmokeConfig {
  const projectId = process.env['BOBSLED_CORE_XWH_BIGQUERY_PROJECT_ID'];
  if (!projectId) {
    fail(
      [
        'BOBSLED_CORE_XWH_BIGQUERY_PROJECT_ID is required.',
        'Authenticate with ADC first, for example:',
        '  gcloud auth application-default login',
        'Then run:',
        '  BOBSLED_CORE_XWH_BIGQUERY_PROJECT_ID=<project> pnpm --filter @bobsled-inc/bobsled-core smoke:cross-warehouse:bigquery',
      ].join('\n')
    );
  }

  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const datasetId = process.env['BOBSLED_CORE_XWH_BIGQUERY_DATASET'] ?? `bobsled_xwh_smoke_${suffix}`;
  const tableId = `orders_${suffix}`;
  validateBqIdentifier(datasetId, 'BOBSLED_CORE_XWH_BIGQUERY_DATASET');
  validateBqIdentifier(tableId, 'generated BigQuery table');
  validateBqPathPart(projectId, 'BOBSLED_CORE_XWH_BIGQUERY_PROJECT_ID');

  return {
    projectId,
    location: process.env['BOBSLED_CORE_XWH_BIGQUERY_LOCATION'] ?? 'US',
    datasetId,
    tableId,
    shouldDropDataset: process.env['BOBSLED_CORE_XWH_BIGQUERY_DATASET'] === undefined,
  };
}

function validateBqIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail(`${label} must be a BigQuery identifier using only letters, numbers, and underscores.`);
  }
}

function validateBqPathPart(value: string, label: string): void {
  if (value.includes('`') || value.length === 0) {
    fail(`${label} must be non-empty and must not contain backticks.`);
  }
}

function bqFqn(projectId: string, datasetId: string, tableId?: string): string {
  return tableId === undefined
    ? `\`${projectId}.${datasetId}\``
    : `\`${projectId}.${datasetId}.${tableId}\``;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function setupBigQuery(config: SmokeConfig): Promise<void> {
  step('Connecting to BigQuery with ADC credentials');
  detail(`Project: ${config.projectId}`);
  detail(`Dataset: ${config.datasetId}`);
  detail(`Table: ${config.tableId}`);
  detail(`Location: ${config.location}`);

  const runner = await resolveRunner(bigQueryIntegration(config));
  try {
    const createSchemaSql = `CREATE SCHEMA IF NOT EXISTS ${bqFqn(config.projectId, config.datasetId)} OPTIONS(location = ${quoteSqlString(config.location)})`;
    detail(`Running: ${createSchemaSql}`);
    await runner.run(createSchemaSql);
    detail('Dataset is ready.');

    const dropTableSql = `DROP TABLE IF EXISTS ${bqFqn(config.projectId, config.datasetId, config.tableId)}`;
    detail(`Running: ${dropTableSql}`);
    await runner.run(dropTableSql);
    detail('Old smoke table, if any, was removed.');

    const createTableSql = [
      `CREATE TABLE ${bqFqn(config.projectId, config.datasetId, config.tableId)} (`,
      '  order_id INT64,',
      '  customer_id INT64,',
      '  amount FLOAT64,',
      '  order_date STRING',
      ')',
    ].join('\n');
    detail(`Running:\n${createTableSql}`);
    await runner.run(createTableSql);
    detail('Smoke orders table was created.');

    const rows = await readOrdersCsv();
    detail(`Read ${rows.length} fake order rows from fixture CSV.`);
    detail(`Order fixture rows:\n${formatJson(rows)}`);
    const values = rows
      .map(
        (row) =>
          `(${Number(row.order_id)}, ${Number(row.customer_id)}, ${Number(row.amount)}, ${quoteSqlString(row.order_date)})`
      )
      .join(',\n');
    const insertSql = `INSERT INTO ${bqFqn(config.projectId, config.datasetId, config.tableId)} (order_id, customer_id, amount, order_date)\nVALUES\n${values}`;
    detail(`Running:\n${insertSql}`);
    await runner.run(insertSql);
    detail('BigQuery source rows were inserted.');
  } finally {
    detail('Closing BigQuery setup connection.');
    await runner.close?.();
  }
}

async function cleanupBigQuery(config: SmokeConfig): Promise<void> {
  let runner: SqlRunnerModule | undefined;
  try {
    step('Cleaning up BigQuery smoke objects');
    detail(
      `Cleanup mode: ${config.shouldDropDataset ? 'drop temporary dataset' : 'drop generated table only'}`
    );
    runner = await resolveRunner(bigQueryIntegration(config));
    if (config.shouldDropDataset) {
      const sql = `DROP SCHEMA IF EXISTS ${bqFqn(config.projectId, config.datasetId)} CASCADE`;
      detail(`Running: ${sql}`);
      await runner.run(sql);
      detail('Temporary BigQuery dataset was dropped.');
    } else {
      const sql = `DROP TABLE IF EXISTS ${bqFqn(config.projectId, config.datasetId, config.tableId)}`;
      detail(`Running: ${sql}`);
      await runner.run(sql);
      detail('Generated BigQuery smoke table was dropped.');
    }
  } catch (error) {
    process.stderr.write(
      `BigQuery cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`
    );
  } finally {
    detail('Closing BigQuery cleanup connection.');
    await runner?.close?.();
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, absolutePath)));
    } else {
      files.push(path.relative(rootDir, absolutePath));
    }
  }
  return files.sort();
}

async function logGeneratedProject(projectDir: string): Promise<void> {
  const files = await listFiles(projectDir);
  detail(`Generated ${files.length} project files:`);
  for (const file of files) {
    detail(`  ${file}`);
  }
}

function assertRows(rows: Record<string, unknown>[]): void {
  const normalized = rows.map((row) => ({
    order_id: String(row['order_id']),
    customer_id: String(row['customer_id']),
    email: row['email'],
    region: row['region'],
    amount: Number(row['amount']),
    order_date: row['order_date'],
  }));
  const expected = [
    {
      order_id: '1001',
      customer_id: '1',
      email: 'ada@example.com',
      region: 'north',
      amount: 120.5,
      order_date: '2026-05-01',
    },
    {
      order_id: '1002',
      customer_id: '1',
      email: 'ada@example.com',
      region: 'north',
      amount: 35,
      order_date: '2026-05-02',
    },
    {
      order_id: '1003',
      customer_id: '2',
      email: 'beau@example.com',
      region: 'west',
      amount: 88.25,
      order_date: '2026-05-02',
    },
  ];
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    fail(`Unexpected mart rows:\n${JSON.stringify(normalized, null, 2)}`);
  }
  detail(`Verified output rows:\n${formatJson(normalized)}`);
}

async function main(): Promise<void> {
  step('Reading smoke test configuration');
  const config = readConfig();
  detail(`BOBSLED_CORE_XWH_BIGQUERY_PROJECT_ID: ${config.projectId}`);
  detail(`BOBSLED_CORE_XWH_BIGQUERY_LOCATION: ${config.location}`);
  detail(`BOBSLED_CORE_XWH_BIGQUERY_DATASET: ${config.datasetId}`);
  detail(`Generated BigQuery table: ${config.tableId}`);
  detail(
    `GOOGLE_APPLICATION_CREDENTIALS set: ${process.env['GOOGLE_APPLICATION_CREDENTIALS'] ? 'yes' : 'no'}`
  );
  detail(
    `Cleanup target: ${config.shouldDropDataset ? 'temporary dataset' : 'generated table only'}`
  );

  step('Creating local temporary workspace');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-xwh-live-bq-duck-'));
  const projectDir = path.join(tmpDir, 'project');
  const paths = {
    local: path.join(tmpDir, 'local.duckdb'),
    mart: path.join(tmpDir, 'mart.duckdb'),
  };
  detail(`Temp directory: ${tmpDir}`);
  detail(`Generated Bobsled Core project: ${projectDir}`);
  detail(`Local DuckDB source path: ${paths.local}`);
  detail(`DuckDB mart path: ${paths.mart}`);
  detail(`BigQuery source: ${config.projectId}.${config.datasetId}.${config.tableId}`);

  try {
    step('Writing generated Bobsled Core project files');
    await writeSmokeProject(projectDir, config, paths);
    await logGeneratedProject(projectDir);

    step('Loading local DuckDB customers seed');
    await loadDuckDbSeed(projectDir, paths.local);
    detail('DuckDB customers seed loaded into main.customers.');

    await setupBigQuery(config);

    step('Running Bobsled Core cross-warehouse publish');
    detail('Input sources: bigquery.orders + local.customers');
    detail('Target integration: mart');
    detail('Expected target table: main.customer_order_revenue');
    const result = await runProject(projectDir, {
      integration: 'mart',
      crossWarehousePublisher: publishCrossWarehouse,
    });
    detail(`Bobsled Core run result:\n${formatJson(result)}`);
    if (!result.ok) {
      fail(`Cross-warehouse run failed:\n${JSON.stringify(result, null, 2)}`);
    }
    detail('Bobsled Core cross-warehouse publish completed successfully.');

    step('Querying DuckDB mart output');
    const martSql = [
      'SELECT order_id, customer_id, email, region, amount, order_date',
      'FROM main.customer_order_revenue',
      'ORDER BY order_id',
    ].join(' ');
    detail(`Running mart query: ${martSql}`);
    const rows = await queryDuckDb(duckIntegration('mart', paths.mart), martSql);
    detail(`Mart query returned ${rows.length} rows.`);
    assertRows(rows);
    step('Smoke test complete');
    info('Cross-warehouse BigQuery + DuckDB smoke passed.');
  } finally {
    await cleanupBigQuery(config);
    if (process.env['BOBSLED_CORE_XWH_KEEP_SMOKE_ARTIFACTS'] === '1') {
      info(`Kept local artifacts in ${tmpDir}`);
    } else {
      step('Removing local temporary workspace');
      detail(`Removing ${tmpDir}`);
      await fs.rm(tmpDir, { recursive: true, force: true });
      detail('Local temporary workspace removed.');
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
