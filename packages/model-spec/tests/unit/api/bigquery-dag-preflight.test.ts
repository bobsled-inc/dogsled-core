import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { missingUpstreamMessage } from '../../../src/api/bigquery-preflight.js';
import { runProject } from '../../../src/api/index.js';

let tmpDir = '';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * raw.accounts (source) -> stg_accounts (view) -> account_rollup (table)
 *   -> account_top (view); stg_accounts -> account_daily (ephemeral)
 *   -> account_daily_report (table).
 */
async function writeDagProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(tmpDir, 'bq-dag-'));
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
    - { name: amount, type: FLOAT }
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
  - { name: account_id, expr: bq.raw_accounts.account_id, type: STRING }
  - { name: amount, expr: bq.raw_accounts.amount, type: FLOAT }
materialization:
  type: view
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'account_rollup.yml'),
    `spec_version: '0.2'
name: account_rollup
type: model
description: Totals per account.
grain: account_id
source:
  ref: stg_accounts
columns:
  - { name: account_id, expr: account_id }
  - { name: total, expr: SUM(amount) }
group_by:
  - account_id
materialization:
  type: table
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'account_top.yml'),
    `spec_version: '0.2'
name: account_top
type: model
description: Accounts with spend.
grain: account_id
source:
  ref: account_rollup
columns:
  - { name: account_id, expr: account_id }
  - { name: total, expr: total }
where: total > 0
materialization:
  type: view
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'account_daily.yml'),
    `spec_version: '0.2'
name: account_daily
type: model
description: Inlined staging step.
grain: account_id
source:
  ref: stg_accounts
columns:
  - { name: account_id, expr: account_id }
  - { name: amount, expr: amount }
materialization:
  type: ephemeral
`
  );
  await writeFile(
    path.join(projectDir, 'models', 'account_daily_report.yml'),
    `spec_version: '0.2'
name: account_daily_report
type: model
description: Report over the inlined staging step.
grain: account_id
source:
  ref: account_daily
columns:
  - { name: account_id, expr: account_id }
  - { name: amount, expr: amount }
materialization:
  type: table
`
  );
  return projectDir;
}

const MODELS = ['stg_accounts', 'account_rollup', 'account_top', 'account_daily_report'];
const MODELS_IN_ORDER = ['stg_accounts', 'account_rollup', 'account_daily_report', 'account_top'];
const RELATIONS = [...MODELS, 'account_incremental', 'stg_mirror', 'mirror'];

interface FakeWarehouseOptions {
  /** Tables that exist in the warehouse before the run, by bare name. */
  existing?: string[];
  /** Live source columns, by source table name. */
  sourceColumns?: Record<string, string[]>;
  /** Make the dry run reject SQL for one model with this message. */
  dryRunFailure?: { model: string; message: string };
  /** Make INFORMATION_SCHEMA.TABLES unreadable. */
  tablesUnreadable?: boolean;
}

/**
 * A BigQuery double that behaves like the catalog: a dry run of SQL that reads
 * a missing `analytics.<model>` relation fails with "Not found", and every
 * executed CREATE adds the relation.
 */
function makeFakeBigQuery(options: FakeWarehouseOptions = {}) {
  const tables = new Set(options.existing ?? []);
  const events: string[] = [];
  const sourceColumns = options.sourceColumns ?? { accounts: ['account_id', 'amount'] };
  const modelIn = (sql: string): string | undefined =>
    /(?:CREATE (?:OR REPLACE )?(?:VIEW|TABLE)|MERGE INTO) `?analytics`?\.`?(\w+)`?/i.exec(sql)?.[1];
  const missingReads = (sql: string): string[] => {
    const target = modelIn(sql);
    return RELATIONS.filter(
      (model) =>
        model !== target &&
        new RegExp(`analytics\`?\\.\`?${model}\\b`, 'i').test(sql) &&
        !tables.has(model)
    );
  };

  const run = vi.fn(async (sql: string) => {
    const target = modelIn(sql);
    events.push(`run:${target ?? sql}`);
    const missing = missingReads(sql);
    if (missing.length > 0) throw new Error(`Not found: Table analytics.${missing[0]}`);
    if (target) tables.add(target);
    return {};
  });
  const dryRun = vi.fn(async (sql: string) => {
    const target = modelIn(sql);
    events.push(`dry:${target ?? sql}`);
    if (options.dryRunFailure && target === options.dryRunFailure.model) {
      throw new Error(options.dryRunFailure.message);
    }
    const missing = missingReads(sql);
    if (missing.length > 0) {
      throw new Error(`Not found: Table test-project:analytics.${missing[0]} was not found`);
    }
  });
  const query = vi.fn(async (sql: string) => {
    if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) {
      events.push('probe:tables');
      if (options.tablesUnreadable) throw new Error('Access Denied: INFORMATION_SCHEMA.TABLES');
      const names = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      return names.filter((name) => tables.has(name)).map((name) => ({ table_name: name }));
    }
    if (/INFORMATION_SCHEMA\.VIEWS/i.test(sql)) {
      const name = /table_name = '([^']+)'/.exec(sql)?.[1];
      return name && tables.has(name) ? [{ table_name: name }] : [];
    }
    const table = /table_name = '([^']+)'/.exec(sql)?.[1] ?? '';
    if (RELATIONS.includes(table)) {
      return tables.has(table) ? [{ column_name: 'account_id' }, { column_name: 'total' }] : [];
    }
    return (sourceColumns[table] ?? []).map((column) => ({ column_name: column }));
  });
  const customRunners = new CustomRunnerRegistry();
  customRunners.register('bigquery', 'adc', async () => ({ run, dryRun, query }));
  return { customRunners, run, dryRun, query, events, tables };
}

function modelEvents(events: string[]): string[] {
  return events.filter((event) => /^(dry|run):(stg|account)_/.test(event));
}

function results(result: Awaited<ReturnType<typeof runProject>>): string[] {
  return (result.byIntegration[0]?.executionResults ?? []).map(
    (entry) => `${entry.modelName}:${entry.status}`
  );
}

describe('BigQuery preflight in DAG order', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobsled-model-spec-bq-dag-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('builds a fresh DAG by dry-running derived models just before they execute', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();
    const info: string[] = [];

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
      onInfo: (message) => info.push(message),
    });

    expect(result.ok).toBe(true);
    expect(modelEvents(warehouse.events)).toEqual([
      'dry:stg_accounts',
      'run:stg_accounts',
      'dry:account_rollup',
      'run:account_rollup',
      'dry:account_daily_report',
      'run:account_daily_report',
      'dry:account_top',
      'run:account_top',
    ]);
    expect(info.join('\n')).toContain(
      'account_rollup reads stg_accounts, built earlier in this run'
    );
    expect(info.join('\n')).toContain('account_top reads account_rollup');
    // The ephemeral step is inlined, so the report reads stg_accounts directly.
    expect(info.join('\n')).toContain('account_daily_report reads stg_accounts');
  });

  it('reports the deferred models on the integration result', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.byIntegration[0]?.deferredModels).toEqual([
      'account_rollup',
      'account_daily_report',
      'account_top',
    ]);
    const rerun = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: result.state,
    });
    expect(rerun.ok).toBe(true);
    expect(rerun.byIntegration[0]?.deferredModels).toBeUndefined();
  });

  it('dry-runs every model up front when its inputs already exist', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({ existing: MODELS });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    const events = modelEvents(warehouse.events);
    const firstRun = events.findIndex((event) => event.startsWith('run:'));
    expect(events.slice(0, firstRun).sort()).toEqual(MODELS.map((model) => `dry:${model}`).sort());
    expect(events.slice(firstRun).every((event) => event.startsWith('run:'))).toBe(true);
  });

  it('applies the dry-run guard to every model before that model runs', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    const events = modelEvents(warehouse.events);
    for (const model of MODELS) {
      const ran = events.indexOf(`run:${model}`);
      expect(ran).toBeGreaterThan(-1);
      expect(events.indexOf(`dry:${model}`)).toBeGreaterThan(-1);
      expect(events.indexOf(`dry:${model}`)).toBeLessThan(ran);
    }
    expect(warehouse.dryRun).toHaveBeenCalledTimes(MODELS.length);
  });

  it('stops a derived model whose deferred dry run fails and skips its dependents', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({
      dryRunFailure: { model: 'account_rollup', message: 'Query exceeded limit for bytes billed' },
    });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(false);
    expect(warehouse.events).not.toContain('run:account_rollup');
    expect(warehouse.events).not.toContain('run:account_top');
    expect(warehouse.events).not.toContain('dry:account_top');
    expect(results(result)).toEqual([
      'stg_accounts:success',
      'account_rollup:failed',
      'account_daily_report:success',
      'account_top:skipped',
    ]);
    const failure = result.byIntegration[0]?.executionResults?.find(
      (entry) => entry.modelName === 'account_rollup'
    );
    expect(failure?.error).toBe(
      'BigQuery dry run failed before execution: Query exceeded limit for bytes billed'
    );
    expect(failure?.exitCode).toBe(2);
    expect(result.state.models['bq.account_rollup']).toBeUndefined();
    expect(result.state.models['bq.stg_accounts']).toBeDefined();
  });

  it('fails an up-front dry run before any model executes', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({
      dryRunFailure: { model: 'stg_accounts', message: 'Syntax error' },
    });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(false);
    expect(warehouse.events.filter((event) => event.startsWith('run:'))).toEqual([
      'run:CREATE SCHEMA IF NOT EXISTS `analytics`',
    ]);
    expect(result.byIntegration[0]?.error).toBe('1 model(s) failed BigQuery preflight.');
  });

  it('names a missing source table before any model SQL is dry-run or executed', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({ sourceColumns: {} });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(false);
    expect(warehouse.dryRun).not.toHaveBeenCalled();
    expect(modelEvents(warehouse.events)).toEqual([]);
    const error = result.byIntegration[0]?.executionResults?.[0]?.error ?? '';
    expect(error).toContain('source table raw.accounts (bq.raw_accounts) was not found');
  });

  it('requires an upstream outside the selection to exist already', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    const result = await runProject(projectDir, {
      integration: 'bq',
      models: ['account_rollup'],
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(false);
    expect(warehouse.dryRun).not.toHaveBeenCalled();
    expect(modelEvents(warehouse.events)).toEqual([]);
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'upstream model stg_accounts (analytics.stg_accounts) does not exist and this run does not build it'
    );
  });

  it('dry-runs a selected model up front when its unselected upstream exists', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({ existing: ['stg_accounts'] });

    const result = await runProject(projectDir, {
      integration: 'bq',
      models: ['account_rollup'],
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    expect(modelEvents(warehouse.events)).toEqual(['dry:account_rollup', 'run:account_rollup']);
  });

  it('defers only the selected models whose upstream is built by the selection', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    const result = await runProject(projectDir, {
      integration: 'bq',
      models: ['+account_top'],
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    expect(modelEvents(warehouse.events)).toEqual([
      'dry:stg_accounts',
      'run:stg_accounts',
      'dry:account_rollup',
      'run:account_rollup',
      'dry:account_top',
      'run:account_top',
    ]);
  });

  it('resumes after a crash with existing upstream checked up front', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({ existing: ['stg_accounts', 'account_daily_report'] });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    const events = modelEvents(warehouse.events);
    // account_rollup reads an existing relation, so it is checked before anything runs.
    expect(events.indexOf('dry:account_rollup')).toBeLessThan(events.indexOf('run:stg_accounts'));
    // account_top still waits for account_rollup.
    expect(events.indexOf('dry:account_top')).toBeGreaterThan(events.indexOf('run:account_rollup'));
  });

  it('keeps the up-front order when the catalog cannot be read', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery({ tablesUnreadable: true });
    const warnings: string[] = [];

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
      onWarn: (message) => warnings.push(message),
    });

    expect(result.ok).toBe(false);
    expect(warnings.join('\n')).toContain('could not read analytics.INFORMATION_SCHEMA.TABLES');
    expect(modelEvents(warehouse.events).some((event) => event.startsWith('run:'))).toBe(false);
    // Every model was dry-run up front, as before this change.
    expect(warehouse.dryRun).toHaveBeenCalledTimes(MODELS.length);
    const failures = result.byIntegration[0]?.executionResults ?? [];
    expect(failures.map((entry) => entry.modelName).sort()).toEqual([
      'account_daily_report',
      'account_rollup',
      'account_top',
    ]);
    expect(failures.find((entry) => entry.modelName === 'account_rollup')?.error).toContain(
      'BigQuery dry run failed before execution: Not found: Table test-project:analytics.stg_accounts'
    );
  });

  it('does not query the catalog for models without upstream models', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    const result = await runProject(projectDir, {
      integration: 'bq',
      models: ['stg_accounts'],
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    expect(warehouse.events).not.toContain('probe:tables');
  });

  it('leaves non-BigQuery runs unchanged: no dry run and no catalog probe', async () => {
    const projectDir = await writeDagProject();
    await writeFile(
      path.join(projectDir, 'integrations', 'bq.yml'),
      `spec_version: '1'
type: integration
name: bq
source_type: duckdb
connection:
  schema: analytics
auth:
  type: file
  path: ${JSON.stringify(path.join(projectDir, 'db.duckdb'))}
`
    );
    const run = vi.fn(async () => ({}));
    const dryRun = vi.fn(async () => undefined);
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('duckdb', 'file', async () => ({ run, dryRun }));

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(true);
    expect(dryRun).not.toHaveBeenCalled();
    expect(results(result)).toEqual(MODELS_IN_ORDER.map((model) => `${model}:success`));
  });

  async function writeSourceOverModel(
    projectDir: string,
    source: string,
    table: string,
    model: string
  ): Promise<void> {
    await writeFile(
      path.join(projectDir, 'sources', `${source}.yml`),
      `spec_version: '0.2'
name: ${source}
type: source
source_type: warehouse_table
connection: bq
table: analytics.${table}
schema:
  columns:
    - { name: account_id, type: STRING }
`
    );
    await writeFile(
      path.join(projectDir, 'models', `${model}.yml`),
      `spec_version: '0.2'
name: ${model}
type: model
description: Reads a table built by this run through a source.
grain: account_id
source:
  ref: bq.${source}
columns:
  - { name: account_id, expr: bq.${source}.account_id, type: STRING }
materialization:
  type: table
`
    );
  }

  it('orders a source over an in-run table after its producer when the producer runs first', async () => {
    const projectDir = await writeDagProject();
    await writeSourceOverModel(projectDir, 'staged_copy', 'stg_accounts', 'stg_mirror');
    const warehouse = makeFakeBigQuery();
    const warnings: string[] = [];

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
      onWarn: (message) => warnings.push(message),
    });

    expect(result.ok).toBe(true);
    const events = modelEvents(warehouse.events);
    expect(events.indexOf('run:stg_accounts')).toBeLessThan(events.indexOf('dry:stg_mirror'));
    expect(events.indexOf('dry:stg_mirror')).toBeLessThan(events.indexOf('run:stg_mirror'));
    expect(warnings.join('\n')).not.toContain('use `ref:');
  });

  it('keeps a source checked up front when its producer runs after the reader', async () => {
    const projectDir = await writeDagProject();
    await writeSourceOverModel(projectDir, 'rollup_copy', 'account_rollup', 'mirror');
    const warehouse = makeFakeBigQuery();
    const warnings: string[] = [];
    const info: string[] = [];

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
      onWarn: (message) => warnings.push(message),
      onInfo: (message) => info.push(message),
    });

    expect(result.ok).toBe(false);
    expect(warnings.join('\n')).toContain(
      'Source bq.rollup_copy reads the table built by model account_rollup, which runs after mirror; use `ref: account_rollup`'
    );
    expect(info.join('\n')).not.toContain('mirror reads account_rollup');
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'source table analytics.account_rollup (bq.rollup_copy) was not found'
    );
    expect(modelEvents(warehouse.events).some((event) => event.startsWith('run:'))).toBe(false);
  });

  it('defers an incremental model on the first run and checks its merge up front later', async () => {
    const projectDir = await writeDagProject();
    await writeFile(
      path.join(projectDir, 'models', 'account_incremental.yml'),
      `spec_version: '0.2'
name: account_incremental
type: model
description: Incremental totals.
grain: account_id
source:
  ref: account_rollup
columns:
  - { name: account_id, expr: account_id, type: STRING }
  - { name: total, expr: total, type: FLOAT }
materialization:
  type: incremental
  strategy: merge
  unique_key: account_id
`
    );
    const warehouse = makeFakeBigQuery();

    const first = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
    });
    expect(first.ok).toBe(true);
    expect(first.byIntegration[0]?.deferredModels).toContain('account_incremental');
    const firstEvents = modelEvents(warehouse.events);
    expect(firstEvents.indexOf('run:account_rollup')).toBeLessThan(
      firstEvents.indexOf('dry:account_incremental')
    );

    warehouse.events.length = 0;
    const second = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: first.state,
    });
    expect(second.ok).toBe(true);
    expect(second.byIntegration[0]?.deferredModels).toBeUndefined();
    const merge = warehouse.dryRun.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => /MERGE INTO/i.test(sql));
    expect(merge.length).toBeGreaterThan(0);
    const events = modelEvents(warehouse.events);
    const firstRun = events.findIndex((event) => event.startsWith('run:'));
    expect(events.slice(firstRun).every((event) => event.startsWith('run:'))).toBe(true);
  });

  it('reports cancellation during a deferred dry run without advancing that model', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();
    const controller = new AbortController();
    const baseDryRun = warehouse.dryRun.getMockImplementation()!;
    warehouse.dryRun.mockImplementation(async (sql: string) => {
      if (/analytics`?\.`?account_rollup`? /i.test(sql) && /CREATE/i.test(sql)) {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return baseDryRun(sql);
    });

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: {} },
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(warehouse.events).not.toContain('run:account_rollup');
    expect(result.state.models['bq.stg_accounts']).toBeDefined();
    expect(result.state.models['bq.account_rollup']).toBeUndefined();
  });

  it('explains an upstream that failed to plan', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();

    const result = await runProject(projectDir, {
      integration: 'bq',
      customRunners: warehouse.customRunners,
      state: { models: { 'bq.stg_accounts': { materialization: 'snapshot' } } } as never,
    });

    expect(result.ok).toBe(false);
    const rollup = result.byIntegration[0]?.executionResults?.find(
      (entry) => entry.modelName === 'account_rollup'
    );
    expect(rollup?.error).toContain('upstream model stg_accounts');
    expect(rollup?.error).toContain('failed to plan in this run');
    expect(modelEvents(warehouse.events).some((event) => event.startsWith('run:'))).toBe(false);
  });

  it('still requires external upstreams to exist when the runner has no dry run', async () => {
    const projectDir = await writeDagProject();
    const warehouse = makeFakeBigQuery();
    const customRunners = new CustomRunnerRegistry();
    customRunners.register('bigquery', 'adc', async () => ({
      run: warehouse.run,
      query: warehouse.query,
    }));

    const result = await runProject(projectDir, {
      integration: 'bq',
      models: ['account_rollup'],
      customRunners,
      state: { models: {} },
    });

    expect(result.ok).toBe(false);
    expect(warehouse.events).toContain('probe:tables');
    expect(result.byIntegration[0]?.executionResults?.[0]?.error).toContain(
      'upstream model stg_accounts (analytics.stg_accounts) does not exist'
    );
  });
});

describe('missingUpstreamMessage', () => {
  it('names the right next step for each kind of upstream', () => {
    expect(missingUpstreamMessage('m', 'u', 'ds.u', {})).toContain(
      'include it in the selection (for example +m)'
    );
    expect(missingUpstreamMessage('m', 'u', 'ds.u', { publishedModels: ['U'] })).toContain(
      "published after this integration's local SQL runs, so build it in a previous run (bobsled model run u) before m"
    );
    expect(missingUpstreamMessage('m', 'u', 'ds.u', { planFailedModels: ['u'] })).toContain(
      'failed to plan in this run'
    );
  });
});
