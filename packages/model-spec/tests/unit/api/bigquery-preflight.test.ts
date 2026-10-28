import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProject } from '../../../src/api/index.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeBigQueryProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'bq-preflight-'));
  await writeFile(
    path.join(projectDir, 'integrations', 'bq.yml'),
    `spec_version: '1'
type: integration
name: bq
source_type: bigquery
connection:
  project_id: test-project
  dataset: analytics
  default_location: US
auth:
  type: adc
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_accounts.yml'),
    `spec_version: '0.2'
name: raw_accounts
type: source
source_type: warehouse_table
connection: bq
table: raw.accounts
schema:
  columns:
    - { name: account_id, type: STRING }
    - { name: deleted_at, type: TIMESTAMP }
`
  );
  await writeFile(
    path.join(projectDir, 'sources', 'raw_accounts_b.yml'),
    `spec_version: '0.2'
name: raw_accounts_b
type: source
source_type: warehouse_table
connection: bq
table: raw.accounts_b
schema:
  columns:
    - { name: account_id, type: STRING }
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'stg_accounts.yml'),
    `spec_version: '0.2'
name: stg_accounts
type: model
description: Staged accounts.
grain: account_id
source:
  ref: bq.raw_accounts
columns:
  - { name: account_id, expr: bq.raw_accounts.account_id, type: STRING, primary_key: true }
  - { name: deleted_at, expr: bq.raw_accounts.deleted_at, type: TIMESTAMP }
materialization:
  type: view
`
  );
  return projectDir;
}

async function writeUnionModel(projectDir: string): Promise<void> {
  await writeFile(
    path.join(projectDir, 'models', 'stg_accounts.yml'),
    `spec_version: '0.2'
name: stg_accounts
type: model
description: Staged accounts.
grain: account_id
source:
  ref: bq.raw_accounts
columns:
  - { name: account_id, expr: bq.raw_accounts.account_id, type: STRING, primary_key: true }
  - { name: deleted_at, expr: bq.raw_accounts.deleted_at, type: TIMESTAMP }
union:
  - ref: bq.raw_accounts_b
materialization:
  type: view
`
  );
}

interface BigQueryRunnerOptions {
  liveColumns?: string[];
  liveColumnsByTable?: Record<string, string[]>;
  dryRunError?: Error;
  run?: ReturnType<typeof vi.fn>;
}

function makeBigQueryRunner(options: BigQueryRunnerOptions) {
  const run = options.run ?? vi.fn(async () => ({}));
  const dryRun = vi.fn(async () => {
    if (options.dryRunError) throw options.dryRunError;
  });
  const query = vi.fn(async (sql: string) => {
    // The post-write view verification (runProject → verifyViewsWritten) reads
    // INFORMATION_SCHEMA.VIEWS to confirm each view actually landed. Model the
    // planned view as present so a healthy run is not flagged as a silent
    // no-op; the source-column preflight path still reads INFORMATION_SCHEMA.COLUMNS.
    if (/INFORMATION_SCHEMA\.VIEWS/i.test(sql)) {
      const tableName = /table_name = '([^']+)'/.exec(sql)?.[1];
      return tableName ? [{ table_name: tableName }] : [];
    }
    return columnsForInformationSchemaQuery(options, sql).map((column) => ({
      column_name: column,
    }));
  });
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('bigquery', 'adc', async () => ({
    run,
    dryRun,
    query,
  }));
  return { customRunners, run, dryRun, query };
}

function columnsForInformationSchemaQuery(
  options: Pick<BigQueryRunnerOptions, 'liveColumns' | 'liveColumnsByTable'>,
  sql: string
): string[] {
  if (!options.liveColumnsByTable) return options.liveColumns ?? [];
  const tableName = /table_name = '([^']+)'/.exec(sql)?.[1];
  return tableName ? (options.liveColumnsByTable[tableName] ?? []) : [];
}

describe('BigQuery model preflight', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-model-spec-bq-preflight-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('fails with an actionable source-column error before executing SQL', async () => {
    const projectDir = await writeBigQueryProject();
    const { customRunners, run, dryRun, query } = makeBigQueryRunner({
      liveColumns: ['account_id'],
    });

    const result = await runProject(projectDir, { integration: 'bq', customRunners });

    expect(result.ok).toBe(false);
    expect(query).toHaveBeenCalledWith(
      "SELECT column_name FROM `raw.INFORMATION_SCHEMA.COLUMNS` WHERE table_name = 'accounts'"
    );
    // Schema bootstrap (dbt parity) runs first; the source-column preflight
    // then fails, so no model SQL is dry-run or executed.
    expect(run.mock.calls.map((call) => String(call[0]))).toEqual([
      'CREATE SCHEMA IF NOT EXISTS `analytics`',
    ]);
    expect(dryRun).not.toHaveBeenCalled();
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain('deleted_at');
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'Update the source spec/model projection or evolve the raw table'
    );
  });

  it('allows UNION ALL branches to omit direct canonical columns that compile to NULL', async () => {
    const projectDir = await writeBigQueryProject();
    await writeUnionModel(projectDir);
    const { customRunners, run, dryRun, query } = makeBigQueryRunner({
      liveColumnsByTable: {
        accounts: ['account_id', 'deleted_at'],
        accounts_b: ['account_id'],
      },
    });

    const result = await runProject(projectDir, { integration: 'bq', customRunners });

    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledWith(
      "SELECT column_name FROM `raw.INFORMATION_SCHEMA.COLUMNS` WHERE table_name = 'accounts_b'"
    );
    expect(dryRun).toHaveBeenCalledOnce();
    expect(dryRun.mock.calls[0]?.[0]).toContain('CAST(NULL AS TIMESTAMP) AS deleted_at');
    // The schema bootstrap plus the model's view DDL both execute.
    expect(run.mock.calls.some((call) => /CREATE OR REPLACE VIEW/i.test(String(call[0])))).toBe(
      true
    );
  });

  it('dry-runs planned BigQuery model SQL before execution', async () => {
    const projectDir = await writeBigQueryProject();
    const { customRunners, run, dryRun } = makeBigQueryRunner({
      liveColumns: ['account_id', 'deleted_at'],
      dryRunError: new Error('UNION ALL has mismatched column count'),
    });

    const result = await runProject(projectDir, { integration: 'bq', customRunners });

    expect(result.ok).toBe(false);
    expect(dryRun).toHaveBeenCalledOnce();
    // Only the schema bootstrap ran; the dry run failed before any model SQL executed.
    expect(run.mock.calls.map((call) => String(call[0]))).toEqual([
      'CREATE SCHEMA IF NOT EXISTS `analytics`',
    ]);
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'BigQuery dry run failed before execution'
    );
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'UNION ALL has mismatched column count'
    );
  });
});
