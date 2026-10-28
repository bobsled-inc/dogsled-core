import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { applyHandler } from '../../../src/commands/review-apply-command.js';
import type { ReviewApplyReceipt } from '../../../src/commands/review-apply-output.js';

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
  `agent_policy:`,
  `  enabled: true`,
  `  auto_apply_threshold: 0.8`,
].join('\n');

/** Build a mixed-confidence agent decision bundle for apply tests. */
function decisionBundle(): string {
  return JSON.stringify({
    version: 'entity_graph_decision_bundle.v1',
    entity: 'company',
    mode: 'apply',
    decision_source: 'agent',
    threshold_bands: ['review'],
    decisions: [
      { pair_id: 'high', decision: 'merge', confidence: 0.9 },
      { pair_id: 'low', decision: 'merge', confidence: 0.7 },
    ],
  });
}

/** Capture process output while an apply command executes. */
async function captureOutput(
  action: () => Promise<void>
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    await action();
    return { stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('review apply command', () => {
  let projectDir: string;
  let previousCwd: string;
  let inputPath: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-review-apply-'));
    fs.mkdirSync(path.join(projectDir, 'entity-graph'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'model-spec.yml'), `entity_graph_dir: entity-graph\n`);
    fs.writeFileSync(path.join(projectDir, 'entity-graph/company_resolution.yml'), resolutionSpec);
    inputPath = path.join(projectDir, 'decisions.json');
    fs.writeFileSync(inputPath, decisionBundle());
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('confidence-gates bundles and emits the same JSON/YAML receipt', async () => {
    const jsonOutput = await captureOutput(async () => {
      await applyHandler(
        {
          input: inputPath,
          entity: 'company',
          dialect: 'duckdb',
          materialize: 'incremental',
          json: true,
        },
        { quiet: true }
      );
    });
    const yamlOutput = await captureOutput(async () => {
      await applyHandler(
        {
          input: inputPath,
          entity: 'company',
          dialect: 'duckdb',
          materialize: 'incremental',
          yaml: true,
        },
        { quiet: true }
      );
    });

    const jsonReceipt = JSON.parse(jsonOutput.stdout) as ReviewApplyReceipt;
    const yamlReceipt = YAML.parse(yamlOutput.stdout) as ReviewApplyReceipt;
    expect(yamlReceipt).toEqual(jsonReceipt);
    const receipt = jsonReceipt;
    expect(receipt).toMatchObject({
      decision_source: 'agent',
      persisted_count: 0,
      applied_count: 1,
      proposed_count: 1,
      materialized_merge_count: 1,
    });
    expect(
      receipt.statements.find((statement) => statement.name === 'apply_review_decisions')?.sql
    ).toContain("'high'");
    expect(
      receipt.statements.find((statement) => statement.name === 'apply_review_decisions_pending')
        ?.sql
    ).toContain("'low'");
  });

  it('returns stable structured payloads for validation failures', async () => {
    const error = await applyHandler(
      {
        input: path.join(projectDir, 'missing.json'),
        entity: 'company',
      },
      { quiet: true }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      exitCode: 2,
      payload: {
        valid: false,
        errorCode: 'INPUT_FILE_NOT_FOUND',
        errors: [{ path: 'input' }],
      },
    });
  });

  it('wraps incremental spec resolution failures in the structured error contract', async () => {
    fs.mkdirSync(path.join(projectDir, 'sources'));
    fs.writeFileSync(path.join(projectDir, 'sources/invalid.yml'), '[');

    const error = await applyHandler(
      {
        input: inputPath,
        entity: 'company',
        dialect: 'duckdb',
        materialize: 'incremental',
        json: true,
      },
      { quiet: true }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      exitCode: 2,
      payload: {
        valid: false,
        errorCode: 'RESOLUTION_SPEC_RESOLVE_FAILED',
        errors: [{ path: 'entity' }],
      },
    });
  });

  it('classifies runner-load failures as runtime errors', async () => {
    const runnerPath = path.join(projectDir, 'missing-runner.mjs');

    const error = await applyHandler(
      {
        input: inputPath,
        entity: 'company',
        dialect: 'duckdb',
        runner: runnerPath,
        json: true,
      },
      { quiet: true }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      exitCode: 1,
      payload: {
        valid: false,
        errorCode: 'RUNNER_LOAD_FAILED',
        errors: [{ path: 'runner' }],
      },
    });
  });

  it('reports all decisions persisted when every apply statement succeeds', async () => {
    const runnerPath = path.join(projectDir, 'runner.mjs');
    fs.writeFileSync(
      runnerPath,
      [`export async function run() {`, `  return { rowCount: 1 };`, `}`].join('\n')
    );

    const output = await captureOutput(async () => {
      await applyHandler(
        {
          input: inputPath,
          entity: 'company',
          dialect: 'duckdb',
          runner: runnerPath,
          json: true,
        },
        { quiet: true }
      );
    });

    const receipt = JSON.parse(output.stdout) as ReviewApplyReceipt;
    expect(receipt.persisted_count).toBe(2);
  });

  it('stops after a decision-write failure and reports skipped downstream writes', async () => {
    const logPath = path.join(projectDir, 'runner-log.jsonl');
    const runnerPath = path.join(projectDir, 'runner.mjs');
    fs.writeFileSync(
      runnerPath,
      [
        `import { appendFileSync } from 'node:fs';`,
        `export async function run(sql) {`,
        `  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(sql) + '\\n');`,
        `  if (sql.startsWith('INSERT INTO') && sql.includes('company__review_decisions')) {`,
        `    throw new Error('forced decision insert failure');`,
        `  }`,
        `  return { rowCount: 1 };`,
        `}`,
      ].join('\n')
    );
    let error: unknown;
    const output = await captureOutput(async () => {
      error = await applyHandler(
        {
          input: inputPath,
          entity: 'company',
          dialect: 'duckdb',
          materialize: 'incremental',
          runner: runnerPath,
          json: true,
        },
        { quiet: true }
      ).catch((caught: unknown) => caught);
    });

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      exitCode: 1,
      payload: { valid: false, errorCode: 'REVIEW_STATEMENT_FAILED' },
    });
    const receipt = JSON.parse(output.stdout) as ReviewApplyReceipt;
    expect(receipt.persisted_count).toBeNull();
    const failedIndex = receipt.statements.findIndex((statement) => statement.status === 'failed');
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(receipt.statements.slice(failedIndex + 1).every((row) => row.status === 'skipped')).toBe(
      true
    );
    const executedSql = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(executedSql).toHaveLength(failedIndex + 1);
  });
});
