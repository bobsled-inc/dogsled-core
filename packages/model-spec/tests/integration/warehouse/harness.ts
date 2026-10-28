import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CustomRunnerRegistry,
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import YAML from 'yaml';

import { runProject } from '../../../src/api/run-project.js';

export type WarehouseObjectType = 'TABLE' | 'VIEW' | 'DYNAMIC_TABLE' | 'MATERIALIZED_VIEW';

export interface WarehouseTestHarness {
  readonly handle: 'snowflake' | 'bigquery' | 'duckdb';
  readonly schema: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  runner: SqlRunnerModule;
  projectDir: string;
  getObjectType(fqName: string): Promise<WarehouseObjectType | null>;
  getRowCount(fqName: string): Promise<number>;
}

interface BaseHarnessOptions {
  handle: WarehouseTestHarness['handle'];
  schema: string;
  integration: IntegrationFile;
  sourceTableName: string;
  quoteFqName: (name: string) => string;
  objectTypeSql: (fqName: string) => string;
  setupSql: (schema: string, sourceTableName: string) => string[];
  teardownSql: (schema: string) => string[];
  dbFilePath?: string;
}

class BaseWarehouseHarness implements WarehouseTestHarness {
  readonly handle: WarehouseTestHarness['handle'];
  readonly schema: string;
  readonly #integration: IntegrationFile;
  readonly #sourceTableName: string;
  readonly #quoteFqName: (name: string) => string;
  readonly #objectTypeSql: (fqName: string) => string;
  readonly #setupSql: (schema: string, sourceTableName: string) => string[];
  readonly #teardownSql: (schema: string) => string[];
  readonly #dbFilePath: string | undefined;

  runner!: SqlRunnerModule;
  projectDir = '';

  constructor(options: BaseHarnessOptions) {
    this.handle = options.handle;
    this.schema = options.schema;
    this.#integration = options.integration;
    this.#sourceTableName = options.sourceTableName;
    this.#quoteFqName = options.quoteFqName;
    this.#objectTypeSql = options.objectTypeSql;
    this.#setupSql = options.setupSql;
    this.#teardownSql = options.teardownSql;
    this.#dbFilePath = options.dbFilePath;
  }

  async setup(): Promise<void> {
    this.runner = await resolveRunner(this.#integration);
    this.projectDir = await mkdtemp(join(tmpdir(), `model-spec-${this.handle}-warehouse-`));
    await writeProject(this.projectDir, this.handle, this.#integration, this.#sourceTableName);
    for (const sql of this.#setupSql(this.schema, this.#sourceTableName)) {
      await this.runner.run(sql);
    }
  }

  async teardown(): Promise<void> {
    if (this.runner) {
      for (const sql of this.#teardownSql(this.schema)) {
        await this.runner.run(sql).catch(() => ({}));
      }
      await this.runner.close?.();
    }
    if (this.projectDir) {
      await rm(this.projectDir, { recursive: true, force: true });
    }
    if (this.#dbFilePath) {
      await rm(this.#dbFilePath, { force: true });
    }
  }

  async getObjectType(fqName: string): Promise<WarehouseObjectType | null> {
    const query = this.runner.query;
    if (!query) throw new Error(`${this.handle} runner does not expose query()`);
    const rows = await query(this.#objectTypeSql(fqName));
    const raw = rows[0]?.TABLE_TYPE ?? rows[0]?.table_type;
    if (raw === undefined || raw === null) return null;
    const normalized = String(raw).toUpperCase();
    if (normalized === 'BASE TABLE') return 'TABLE';
    if (isWarehouseObjectType(normalized)) {
      return normalized;
    }
    return null;
  }

  async getRowCount(fqName: string): Promise<number> {
    const query = this.runner.query;
    if (!query) throw new Error(`${this.handle} runner does not expose query()`);
    const rows = await query(`SELECT COUNT(*) AS ROW_COUNT FROM ${this.#quoteFqName(fqName)}`);
    const firstRow = rows[0];
    const value = firstRow?.ROW_COUNT ?? firstRow?.row_count ?? firstRow?.count;
    const count = Number(value);
    if (!Number.isFinite(count)) {
      const keys = firstRow ? Object.keys(firstRow).join(', ') : '(no rows)';
      const preview = firstRow ? JSON.stringify(firstRow).slice(0, 500) : 'undefined';
      throw new Error(`Unable to parse row count for ${fqName}; keys: ${keys}; row: ${preview}`);
    }
    return count;
  }
}

export function createDuckDbHarness(): WarehouseTestHarness {
  const schema = 'main';
  const dbFilePath = join(tmpdir(), `${uniqueName('bms_duckdb_ci')}.duckdb`);
  return new BaseWarehouseHarness({
    handle: 'duckdb',
    schema,
    sourceTableName: `${schema}.raw_orders`,
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'duckdb',
      source_type: 'duckdb',
      connection: { schema },
      auth: { type: 'file', path: dbFilePath },
    },
    dbFilePath,
    quoteFqName: quoteDotted,
    objectTypeSql: (fqName) => {
      const { name } = splitFqName(fqName);
      return `SELECT table_type FROM information_schema.tables WHERE table_name = '${name}'`;
    },
    setupSql: (schemaName, sourceTableName) => [
      `CREATE TABLE ${quoteDotted(sourceTableName)} (
        order_id INTEGER,
        customer_id INTEGER,
        order_status VARCHAR,
        order_total DOUBLE,
        updated_at TIMESTAMP
      )`,
      `INSERT INTO ${quoteDotted(sourceTableName)} VALUES
        (1, 10, 'paid', 50.00, TIMESTAMP '2026-01-01 00:00:00'),
        (2, 20, 'paid', 75.00, TIMESTAMP '2026-01-02 00:00:00')`,
    ],
    teardownSql: (schemaName) => [
      `DROP VIEW IF EXISTS ${quoteDotted(`${schemaName}.stg_orders`)}`,
      `DROP TABLE IF EXISTS ${quoteDotted(`${schemaName}.order_summary`)}`,
      `DROP TABLE IF EXISTS ${quoteDotted(`${schemaName}.fct_orders`)}`,
      `DROP TABLE IF EXISTS ${quoteDotted(`${schemaName}.raw_orders`)}`,
    ],
  });
}

export function createSnowflakeHarness(): WarehouseTestHarness {
  const schema = uniqueName('DOGSLED_MODEL_SPEC_SNOWFLAKE_CI').toUpperCase();
  const database = requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_DATABASE');
  return new BaseWarehouseHarness({
    handle: 'snowflake',
    schema,
    sourceTableName: `${database}.${schema}.RAW_ORDERS`,
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'snowflake',
      source_type: 'snowflake',
      connection: {
        account_identifier: requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_ACCOUNT'),
        user: requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_USER'),
        role: requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_ROLE'),
        warehouse: requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_WAREHOUSE'),
        database,
        schema,
      },
      auth: { type: 'pat', token: requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_PAT') },
    },
    quoteFqName: quoteDotted,
    objectTypeSql: (fqName) => {
      const parts = fqName.split('.');
      const tableName = parts[parts.length - 1] ?? fqName;
      return `SELECT TABLE_TYPE FROM ${quoteDotted(database)}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${tableName.toUpperCase()}'`;
    },
    setupSql: (_schemaName, sourceTableName) => [
      `CREATE TRANSIENT SCHEMA IF NOT EXISTS ${quoteDotted(`${database}.${schema}`)}`,
      `CREATE OR REPLACE TABLE ${quoteDotted(sourceTableName)} (
        ORDER_ID NUMBER,
        CUSTOMER_ID NUMBER,
        ORDER_STATUS VARCHAR,
        ORDER_TOTAL NUMBER(12,2),
        UPDATED_AT TIMESTAMP_NTZ
      )`,
      `INSERT INTO ${quoteDotted(sourceTableName)} VALUES
        (1, 10, 'paid', 50.00, '2026-01-01 00:00:00'::TIMESTAMP_NTZ),
        (2, 20, 'paid', 75.00, '2026-01-02 00:00:00'::TIMESTAMP_NTZ)`,
    ],
    teardownSql: () => [`DROP SCHEMA IF EXISTS ${quoteDotted(`${database}.${schema}`)} CASCADE`],
  });
}

export function createBigQueryHarness(): WarehouseTestHarness {
  const schema = uniqueName('bms_bigquery_ci');
  const projectId = requiredEnv('DOGSLED_MODEL_SPEC_BIGQUERY_PROJECT');
  const location = process.env.DOGSLED_MODEL_SPEC_BIGQUERY_LOCATION ?? 'US';
  return new BaseWarehouseHarness({
    handle: 'bigquery',
    schema,
    sourceTableName: `${projectId}.${schema}.raw_orders`,
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'bigquery',
      source_type: 'bigquery',
      connection: { project_id: projectId, dataset: schema, default_location: location },
      auth: { type: 'adc' },
    },
    quoteFqName: quoteBigQuery,
    objectTypeSql: (fqName) => {
      const parts = fqName.split('.');
      const name = parts[parts.length - 1] ?? fqName;
      return `SELECT table_type FROM \`${projectId}.${schema}.INFORMATION_SCHEMA.TABLES\` WHERE table_name = '${name}'`;
    },
    setupSql: (_schemaName, sourceTableName) => [
      `CREATE SCHEMA IF NOT EXISTS \`${projectId}.${schema}\` OPTIONS(location='${location}', default_table_expiration_days=1)`,
      `CREATE OR REPLACE TABLE ${quoteBigQuery(sourceTableName)} (
        order_id INT64,
        customer_id INT64,
        order_status STRING,
        order_total NUMERIC,
        updated_at TIMESTAMP
      )`,
      `INSERT INTO ${quoteBigQuery(sourceTableName)} VALUES
        (1, 10, 'paid', 50.00, TIMESTAMP '2026-01-01 00:00:00 UTC'),
        (2, 20, 'paid', 75.00, TIMESTAMP '2026-01-02 00:00:00 UTC')`,
    ],
    teardownSql: () => [`DROP SCHEMA IF EXISTS \`${projectId}.${schema}\` CASCADE`],
  });
}

export async function runMaterializationProject(harness: WarehouseTestHarness): Promise<void> {
  const customRunners = new CustomRunnerRegistry();
  customRunners.register(harness.handle, runnerAuthType(harness.handle), async () => ({
    run: (sql) => harness.runner.run(sql),
    query: harness.runner.query ? (sql) => harness.runner.query!(sql) : undefined,
  }));
  const first = await runProject(harness.projectDir, {
    integration: harness.handle,
    fullRefresh: true,
    customRunners,
  });
  if (!first.ok) throw new Error(JSON.stringify(first.byIntegration, null, 2));

  await harness.runner.run(insertThirdOrderSql(harness));

  const second = await runProject(harness.projectDir, {
    integration: harness.handle,
    customRunners,
  });
  if (!second.ok) throw new Error(JSON.stringify(second.byIntegration, null, 2));
}

async function writeProject(
  projectDir: string,
  handle: WarehouseTestHarness['handle'],
  integration: IntegrationFile,
  sourceTableName: string
): Promise<void> {
  await mkdir(join(projectDir, 'integrations'), { recursive: true });
  await mkdir(join(projectDir, 'sources'), { recursive: true });
  await mkdir(join(projectDir, 'models'), { recursive: true });

  await writeFile(
    join(projectDir, 'model-spec.yml'),
    `sources_dir: sources
models_dir: models
integrations_dir: integrations
`,
    'utf8'
  );
  await writeFile(
    join(projectDir, 'integrations', `${handle}.yml`),
    YAML.stringify(integration),
    'utf8'
  );
  await writeFile(
    join(projectDir, 'sources', 'orders.yml'),
    `spec_version: '0.2'
name: orders
type: source
source_type: warehouse_table
connection: ${handle}
table: ${sourceTableName}
description: Warehouse materialization test source.
schema:
  columns:
    - { name: order_id, type: INTEGER }
    - { name: customer_id, type: INTEGER }
    - { name: order_status, type: STRING }
    - { name: order_total, type: NUMBER }
    - { name: updated_at, type: TIMESTAMP }
`,
    'utf8'
  );
  await writeFile(
    join(projectDir, 'models', 'stg_orders.yml'),
    modelYaml('stg_orders', `${handle}.orders`, 'view', targetSchemaFromIntegration(integration)),
    'utf8'
  );
  await writeFile(
    join(projectDir, 'models', 'order_summary.yml'),
    modelYaml('order_summary', 'stg_orders', 'table', targetSchemaFromIntegration(integration)),
    'utf8'
  );
  await writeFile(
    join(projectDir, 'models', 'fct_orders.yml'),
    modelYaml('fct_orders', 'stg_orders', 'incremental', targetSchemaFromIntegration(integration)),
    'utf8'
  );
}

function modelYaml(
  name: string,
  sourceRef: string,
  materialization: string,
  targetSchema: string
): string {
  const materializationBlock =
    materialization === 'incremental'
      ? `materialization:
  type: incremental
  strategy: merge
  unique_key: order_id`
      : `materialization:
  type: ${materialization}`;
  return `spec_version: '0.2'
name: ${name}
type: model
description: ${name} warehouse integration test model.
grain:
  - order_id
source:
  ref: ${sourceRef}
columns:
  - { name: order_id, expr: order_id }
  - { name: customer_id, expr: customer_id }
  - { name: order_status, expr: order_status }
  - { name: order_total, expr: order_total }
  - { name: updated_at, expr: updated_at }
target_schema: ${targetSchema}
${materializationBlock}
`;
}

function insertThirdOrderSql(harness: WarehouseTestHarness): string {
  if (harness.handle === 'snowflake') {
    const database = requiredEnv('DOGSLED_MODEL_SPEC_SNOWFLAKE_DATABASE');
    return `INSERT INTO ${quoteDotted(`${database}.${harness.schema}.RAW_ORDERS`)} VALUES (3, 30, 'paid', 125.00, '2026-01-03 00:00:00'::TIMESTAMP_NTZ)`;
  }
  if (harness.handle === 'bigquery') {
    const projectId = requiredEnv('DOGSLED_MODEL_SPEC_BIGQUERY_PROJECT');
    return `INSERT INTO ${quoteBigQuery(`${projectId}.${harness.schema}.raw_orders`)} VALUES (3, 30, 'paid', 125.00, TIMESTAMP '2026-01-03 00:00:00 UTC')`;
  }
  return `INSERT INTO ${quoteDotted(`${harness.schema}.raw_orders`)} VALUES (3, 30, 'paid', 125.00, TIMESTAMP '2026-01-03 00:00:00')`;
}

function splitFqName(fqName: string): { schema: string; name: string } {
  const parts = fqName.split('.');
  return {
    schema: parts.length > 1 ? (parts[parts.length - 2] ?? '') : '',
    name: parts[parts.length - 1] ?? fqName,
  };
}

function quoteDotted(fqName: string): string {
  return fqName
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');
}

function quoteBigQuery(fqName: string): string {
  return `\`${fqName.replaceAll('`', '')}\``;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function uniqueName(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  const raw = `${prefix}_${process.env.GITHUB_RUN_ID ?? process.pid}_${Date.now()}_${random}`;
  return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

function targetSchemaFromIntegration(integration: IntegrationFile): string {
  const connection = integration.connection as { schema?: unknown; dataset?: unknown };
  if (typeof connection.schema === 'string') return connection.schema;
  if (typeof connection.dataset === 'string') return connection.dataset;
  return 'analytics';
}

function runnerAuthType(handle: WarehouseTestHarness['handle']): string {
  if (handle === 'duckdb') return 'file';
  if (handle === 'bigquery') return 'adc';
  return 'pat';
}

function isWarehouseObjectType(value: string): value is WarehouseObjectType {
  return (
    value === 'TABLE' ||
    value === 'VIEW' ||
    value === 'DYNAMIC_TABLE' ||
    value === 'MATERIALIZED_VIEW'
  );
}
