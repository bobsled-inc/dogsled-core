import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_READY, makeProject, parseJsonStdout, readRunnerLog, run } from './helpers.js';

function writeProfilerRunner(projectDir: string): { logPath: string; runnerPath: string } {
  const logPath = path.join(projectDir, 'profile-runner-log.jsonl');
  const runnerPath = path.join(projectDir, 'profile-runner.mjs');
  fs.writeFileSync(
    runnerPath,
    `import * as fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
function append(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n');
}
export default async function run(sql) {
  append({ type: 'run', sql });
  return { rowCount: 1 };
}
export async function query(sql) {
  append({ type: 'query', sql });
  if (/COUNT\\(\\*\\)/i.test(sql)) return [{ row_count: 3 }];
  if (/fct_orders/i.test(sql)) {
    return [
      { ORDER_ID: 'o1', CUSTOMER_ID: 'c1', TOTAL: 10, ORDER_DATE: '2026-04-01', STATUS: 'paid' },
      { ORDER_ID: 'o2', CUSTOMER_ID: 'c2', TOTAL: 20, ORDER_DATE: '2026-04-02', STATUS: 'paid' },
      { ORDER_ID: 'o3', CUSTOMER_ID: 'c3', TOTAL: 30, ORDER_DATE: '2026-04-03', STATUS: 'open' }
    ];
  }
  if (/stg_customers/i.test(sql)) {
    return [
      { CUSTOMER_ID: 'c1', CUSTOMER_NAME: 'Acme Inc.', EMAIL: 'founder@acme.com.example.com' },
      { CUSTOMER_ID: 'c2', CUSTOMER_NAME: 'Example LLC', EMAIL: 'ops@example.com' },
      { CUSTOMER_ID: 'c3', CUSTOMER_NAME: 'Test Corporation', EMAIL: 'hello@test.co.example.com' }
    ];
  }
  return [
    { ID: 1, NAME: 'Acme Inc.', EMAIL: 'FOUNDER@ACME.COM.example.com ' },
    { ID: 2, NAME: 'Example LLC', EMAIL: 'ops@example.com' },
    { ID: 3, NAME: 'Test Corporation', EMAIL: 'bad-email' }
  ];
}
`,
    'utf-8'
  );
  return { logPath, runnerPath };
}

function writeRunOnlyRunner(projectDir: string): string {
  const runnerPath = path.join(projectDir, 'run-only-runner.mjs');
  fs.writeFileSync(
    runnerPath,
    `export default async function run() {
  return { rowCount: 1 };
}
`,
    'utf-8'
  );
  return runnerPath;
}

function makeEmptyProject(tmpDir: string): string {
  const projectDir = path.join(tmpDir, 'empty-project');
  for (const dir of ['sources', 'models', 'integrations', 'metrics', 'relationships', 'vqs']) {
    fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }
  return projectDir;
}

describe.skipIf(!CLI_READY)('model profile CLI (e2e)', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-profile-cli-'));
    projectDir = makeProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns confidence-scored JSON for a source ref', () => {
    const { logPath, runnerPath } = writeProfilerRunner(projectDir);
    const r = run(
      [
        'profile',
        'ecom.raw_customers',
        '--runner',
        runnerPath,
        '--integration',
        'ecom',
        '--json',
        '--quiet',
      ],
      projectDir
    );

    expect(r.exitCode).toBe(0);
    const payload = parseJsonStdout<{
      command: string;
      ok: boolean;
      report: {
        table: string;
        rowCount: number;
        columns: Array<{
          name: string;
          typeInference: { confidence: number } | null;
          semanticRoleInference: { kind: string | null; confidence: number } | null;
        }>;
        cleaningSuggestions: Array<{ column: string; confidence: number }>;
      };
    }>(r);
    expect(payload.command).toBe('model.profile');
    expect(payload.ok).toBe(true);
    expect(payload.report.table).toBe('RAW.RAW_CUSTOMERS');
    expect(payload.report.rowCount).toBe(3);
    expect(payload.report.columns.find((column) => column.name === 'EMAIL')?.typeInference).toEqual(
      expect.objectContaining({ confidence: expect.any(Number) })
    );
    expect(payload.report.cleaningSuggestions.length).toBeGreaterThan(0);

    const log = readRunnerLog(logPath);
    expect(log.some((entry) => /COUNT\(\*\)/i.test(entry.sql))).toBe(true);
    expect(log.some((entry) => /LIMIT 500/.test(entry.sql))).toBe(true);
  });

  it('threads target samples into foreign-key inference for model references', () => {
    const { logPath, runnerPath } = writeProfilerRunner(projectDir);
    const r = run(
      [
        'profile',
        'fct_orders',
        '--runner',
        runnerPath,
        '--integration',
        'ecom',
        '--json',
        '--quiet',
      ],
      projectDir
    );

    expect(r.exitCode).toBe(0);
    const payload = parseJsonStdout<{
      report: {
        fkCandidates: Array<{
          from: string;
          toTable: string;
          toColumn: string;
          hitRate: number;
        }>;
      };
    }>(r);
    expect(payload.report.fkCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'CUSTOMER_ID',
          toTable: 'stg_customers',
          toColumn: 'CUSTOMER_ID',
          hitRate: 1,
        }),
      ])
    );

    const log = readRunnerLog(logPath);
    expect(log.some((entry) => /stg_customers/i.test(entry.sql))).toBe(true);
  });

  it('filters profile suggestions by confidence', () => {
    const { runnerPath } = writeProfilerRunner(projectDir);
    const r = run(
      [
        'profile',
        'suggest',
        'cleaning',
        'raw_customers',
        '--runner',
        runnerPath,
        '--integration',
        'ecom',
        '--confidence-min',
        '0.9',
        '--json',
        '--quiet',
      ],
      projectDir
    );

    expect(r.exitCode).toBe(0);
    const payload = parseJsonStdout<{
      command: string;
      suggestions: Array<{ confidence: number }>;
    }>(r);
    expect(payload.command).toBe('model.profile.suggest.cleaning');
    expect(payload.suggestions.every((suggestion) => suggestion.confidence >= 0.9)).toBe(true);
  });

  it('honors auto JSON output for profile commands', () => {
    const { runnerPath } = writeProfilerRunner(projectDir);
    const r = run(
      ['profile', 'ecom.raw_customers', '--runner', runnerPath, '--integration', 'ecom'],
      projectDir,
      { DOGSLED_OUTPUT_FORMAT: 'json' }
    );

    expect(r.exitCode).toBe(0);
    const payload = parseJsonStdout<{ command: string; ok: boolean }>(r);
    expect(payload).toMatchObject({
      command: 'model.profile',
      ok: true,
    });
    expect(r.stderr).not.toContain('Profiled');
  });

  it('reports a clear error when the project has no integrations', () => {
    const emptyProject = makeEmptyProject(tmpDir);
    const r = run(['profile', 'raw.customers', '--quiet'], emptyProject);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('No integrations found. Add a YAML file with type: integration');
  });

  it('rejects runners that cannot query', () => {
    const runnerPath = writeRunOnlyRunner(projectDir);
    const r = run(
      ['profile', 'raw_customers', '--runner', runnerPath, '--integration', 'ecom', '--quiet'],
      projectDir
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('query(sql)');
  });
});
