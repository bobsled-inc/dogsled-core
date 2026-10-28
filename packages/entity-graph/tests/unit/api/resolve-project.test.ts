import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planResolveRunMode, runResolveProject } from '../../../src/api/resolve-project.js';
import type { ResolvedResolutionSpec } from '../../../src/compiler/identity/types.js';

let tmpDir: string;
let previousRunnerLog: string | undefined;

const resolutionSpec = [
  `spec_version: '0.2'`,
  `name: company_resolution`,
  `type: resolution`,
  `description: Resolve companies.`,
  `inputs:`,
  `  - ref: raw.company`,
  `    id_fields: [id]`,
  `blocking:`,
  `  rules:`,
  `    - name: exact_name`,
  `      key: name`,
  `scoring:`,
  `  method: weighted_features`,
  `  features:`,
  `    - field: name`,
  `      algorithm: exact`,
  `      weight: 1`,
  `thresholds:`,
  `  auto_merge: 0.9`,
  `  review: 0.6`,
  `  auto_reject: 0.2`,
].join('\n');

const RESOLVED_SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'raw.company',
      fqTableName: 'raw.company',
      alias: 's0',
      idFields: ['id'],
    },
  ],
  standardize: [{ field: 'name', transforms: ['lowercase'] }],
  blocking: { rules: [{ name: 'exact_name', key: 'standardized_name' }] },
  deterministicRules: [],
  thresholds: { autoMerge: 0.9, review: 0.6, autoReject: 0.2 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
};

function writeProject(): { logPath: string; runnerPath: string } {
  const logPath = path.join(tmpDir, 'runner-log.jsonl');
  const runnerPath = path.join(tmpDir, 'runner.mjs');
  fs.mkdirSync(path.join(tmpDir, 'entity-graph'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'model-spec.yml'), `entity_graph_dir: entity-graph\n`);
  fs.writeFileSync(path.join(tmpDir, 'entity-graph/company_resolution.yml'), resolutionSpec);
  fs.writeFileSync(
    runnerPath,
    [
      `import { appendFileSync } from 'node:fs';`,
      `export async function run(sql) {`,
      `  appendFileSync(process.env.ENTITY_GRAPH_TEST_RUNNER_LOG, JSON.stringify(sql) + '\\n');`,
      `  return { rowCount: 1 };`,
      `}`,
    ].join('\n')
  );
  return { logPath, runnerPath };
}

function readExecutedSql(logPath: string): string[] {
  return fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
}

describe('resolve project API', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-resolve-project-'));
    previousRunnerLog = process.env.ENTITY_GRAPH_TEST_RUNNER_LOG;
  });

  afterEach(() => {
    if (previousRunnerLog === undefined) {
      delete process.env.ENTITY_GRAPH_TEST_RUNNER_LOG;
    } else {
      process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = previousRunnerLog;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns structured run results whose statements match runner execution order', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await runResolveProject({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
    });

    expect(result.failure).toBeUndefined();
    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0];
    expect(entity).toMatchObject({
      entity: 'company',
      name: 'company_resolution',
      dialect: 'duckdb',
      schema: 'entity_graph',
      executed: true,
      dry_run: false,
    });
    expect(entity?.statements.every((statement) => statement.status === 'success')).toBe(true);

    const expectedSql = [
      ...(entity?.preamble ? [entity.preamble.sql] : []),
      ...(entity?.statements.map((statement) => statement.sql) ?? []),
    ];
    expect(readExecutedSql(logPath)).toEqual(expectedSql);
  });

  it('direct mode plans clustering and profile statements after threshold routing', async () => {
    writeProject();

    const staged = await runResolveProject({
      cwd: tmpDir,
      dryRun: true,
      dialect: 'duckdb',
      schema: 'mdm',
      quiet: true,
    });
    const direct = await runResolveProject({
      cwd: tmpDir,
      dryRun: true,
      dialect: 'duckdb',
      schema: 'mdm',
      mode: 'direct',
      quiet: true,
    });

    const stagedStatements = staged.entities[0]?.statements ?? [];
    const directStatements = direct.entities[0]?.statements ?? [];
    expect(directStatements.length).toBeGreaterThan(stagedStatements.length);
    expect(
      directStatements.some((statement) => statement.table_created?.includes('__clusters'))
    ).toBe(true);
    expect(
      directStatements.some((statement) => statement.table_created?.includes('__entity_profile'))
    ).toBe(true);
  });

  it('falls back to full incremental planning when resolve_state is missing', async () => {
    const plan = await planResolveRunMode({
      spec: RESOLVED_SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      incrementalRequested: true,
      query: async () => {
        throw new Error('Catalog Error: Table with name company__resolve_state does not exist');
      },
    });

    expect(plan.mode).toBe('full');
    expect(plan.modeReason).toBe('resolve_state_missing');
    expect(plan.incremental).toBeUndefined();
  });
});
