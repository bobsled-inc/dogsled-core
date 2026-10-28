import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';

import { applyReviewDecisions } from '../../../src/api/apply-decisions.js';
import type { AgentDecisionBundleV1 } from '../../../src/compiler/agent/types.js';

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
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'string') {
        throw new Error(`Expected string in runner log, got ${typeof parsed}`);
      }
      return parsed;
    });
}

function makeBundle(overrides: Partial<AgentDecisionBundleV1> = {}): AgentDecisionBundleV1 {
  return {
    version: 'entity_graph_decision_bundle.v1',
    entity: 'company',
    mode: 'apply',
    decision_source: 'agent',
    threshold_bands: ['review'],
    decisions: [
      // confidence >= auto_apply_threshold (0.75) → applied
      { pair_id: 'p1', decision: 'merge', confidence: 0.95, reason: 'same company' },
      // merge/not_match below threshold → proposed (pending human confirmation)
      { pair_id: 'p2', decision: 'not_match', confidence: 0.5, reason: 'different' },
      // agent deferred → deferred (pending)
      { pair_id: 'p3', decision: 'defer', confidence: 0.6, reason: 'unsure' },
    ],
    ...overrides,
  };
}

describe('applyReviewDecisions API', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-apply-decisions-'));
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

  it('confidence-gates decisions into applied / proposed / deferred and executes apply SQL', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });

    expect(result).toMatchObject({
      entity: 'company',
      name: 'company_resolution',
      dialect: 'duckdb',
      schema: 'entity_graph',
      executed: true,
      dry_run: false,
      applied_count: 1,
      proposed_count: 1,
      deferred_count: 1,
      merge_count: 1,
      not_match_count: 0,
    });
    expect(result.failure).toBeUndefined();
    expect(result.statement_count).toBeGreaterThan(0);
    expect(result.statements.every((statement) => statement.status === 'success')).toBe(true);

    // The runner actually executed the generated statements, in order.
    const executed = readExecutedSql(logPath);
    expect(executed).toEqual(result.statements.map((statement) => statement.sql));

    // p2 (not_match @ 0.5) fell below the 0.75 auto-apply floor → proposed,
    // which the gate surfaces as a warning.
    expect(
      result.warnings.some((warning) => /below their apply confidence floor/i.test(warning))
    ).toBe(true);
  });

  it('dry run gates without resolving a runner or executing', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dryRun: true,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });

    expect(result.executed).toBe(false);
    expect(result.dry_run).toBe(true);
    expect(result.applied_count).toBe(1);
    expect(result.statements.every((statement) => statement.status === undefined)).toBe(true);
    expect(readExecutedSql(logPath)).toEqual([]);
  });

  it('re-applying the same bundle is idempotent (identical batch id + SQL)', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const first = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });
    const firstSql = readExecutedSql(logPath);

    fs.writeFileSync(logPath, '');
    const second = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });
    const secondSql = readExecutedSql(logPath);

    expect(second.decision_batch_id).toBe(first.decision_batch_id);
    expect(secondSql).toEqual(firstSql);
  });

  it('handles an empty bundle without executing actionable writes', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle({ decisions: [] }),
    });

    expect(result.applied_count).toBe(0);
    expect(result.proposed_count).toBe(0);
    expect(result.deferred_count).toBe(0);
    expect(result.failure).toBeUndefined();
  });

  it('defaults to materialize none — no incremental statements, additive result fields', async () => {
    const { runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = path.join(tmpDir, 'runner-log.jsonl');

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });

    expect(result.materialize_mode).toBe('none');
    expect(result.materialized_merge_count).toBe(0);
    expect(result.materialized_entity_ids).toEqual([]);
    expect(result.updated_golden_rows).toEqual([]);
    expect(result.statements.some((s) => s.name.startsWith('materialize_merge_'))).toBe(false);
  });

  it('materialize incremental appends entity-scoped statements for applied merges only', async () => {
    const { runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = path.join(tmpDir, 'runner-log.jsonl');

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      materialize: 'incremental',
      bundle: makeBundle(),
    });

    // p1 (merge @ 0.95 → applied) materializes; p2/p3 stay record-only.
    expect(result.materialize_mode).toBe('incremental');
    expect(result.materialized_merge_count).toBe(1);
    const materializeNames = result.statements
      .map((s) => s.name)
      .filter((name) => name.startsWith('materialize_merge_'));
    expect(materializeNames[0]).toBe('materialize_merge_1_union_clusters');
    expect(materializeNames).toContain('materialize_merge_1_golden_insert');
    expect(materializeNames).toContain('materialize_merge_1_crosswalks_insert');
    // The logging runner has no query() — surfaced as a warning, not a failure.
    expect(result.failure).toBeUndefined();
    expect(result.warnings.some((w) => /does not support query\(\)/.test(w))).toBe(true);
  });

  it('materialize incremental with only proposed/deferred decisions is record-only', async () => {
    const { runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = path.join(tmpDir, 'runner-log.jsonl');

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      materialize: 'incremental',
      bundle: makeBundle({
        decisions: [
          // below the 0.75 floor → proposed
          { pair_id: 'p1', decision: 'merge', confidence: 0.5, reason: 'unsure' },
          { pair_id: 'p3', decision: 'defer', confidence: 0.6, reason: 'unsure' },
        ],
      }),
    });

    expect(result.materialized_merge_count).toBe(0);
    expect(result.statements.some((s) => s.name.startsWith('materialize_merge_'))).toBe(false);
  });

  it('materialize incremental warns that applied not_match decisions do not unmerge', async () => {
    const { runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = path.join(tmpDir, 'runner-log.jsonl');

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      materialize: 'incremental',
      bundle: makeBundle({
        decisions: [{ pair_id: 'p2', decision: 'not_match', confidence: 0.95, reason: 'differs' }],
      }),
    });

    expect(result.materialized_merge_count).toBe(0);
    expect(result.warnings.some((w) => /not split incrementally/.test(w))).toBe(true);
  });

  it('materialize incremental reflects touched entities and golden rows via runner query()', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;
    fs.writeFileSync(
      runnerPath,
      [
        `import { appendFileSync } from 'node:fs';`,
        `export async function run(sql) {`,
        `  appendFileSync(process.env.ENTITY_GRAPH_TEST_RUNNER_LOG, JSON.stringify(sql) + '\\n');`,
        `  return { rowCount: 1 };`,
        `}`,
        `export async function query(sql) {`,
        // Warehouse-style uppercase labels (e.g. Snowflake) must be normalized
        // back to lowercase keys in the result.
        `  if (sql.includes('__golden" g')) {`,
        `    return [{ ENTITY_ID: 'a', NAME: 'Acme', CLUSTER_SIZE: 2 }];`,
        `  }`,
        `  return [{ ENTITY_ID: 'a' }];`,
        `}`,
      ].join('\n')
    );

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      materialize: 'incremental',
      bundle: makeBundle(),
    });

    expect(result.failure).toBeUndefined();
    expect(result.materialized_entity_ids).toEqual(['a']);
    expect(result.updated_golden_rows).toEqual([{ entity_id: 'a', name: 'Acme', cluster_size: 2 }]);
  });

  it('rejects a malformed bundle with a machine-parseable CommandError', async () => {
    writeProject();
    const error = await applyReviewDecisions({
      cwd: tmpDir,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      // missing version/decisions → not a valid v1 bundle
      bundle: { entity: 'company' } as unknown as AgentDecisionBundleV1,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    const commandError = error as CommandError;
    expect(commandError.exitCode).toBe(2);
    expect(commandError.payload).toMatchObject({
      valid: false,
      errorCode: 'INVALID_AGENT_DECISION_BUNDLE',
    });
  });

  it('surfaces statement execution failures via result.failure', async () => {
    const { runnerPath } = writeProject();
    // Replace the logging runner with one that fails every statement.
    fs.writeFileSync(
      runnerPath,
      [`export async function run() {`, `  throw new Error('forced apply failure');`, `}`].join(
        '\n'
      )
    );

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    });

    expect(result.executed).toBe(true);
    expect(result.failure).toBeDefined();
    expect(result.failure?.failedCount).toBeGreaterThan(0);
    expect(result.statements.some((statement) => statement.status === 'failed')).toBe(true);

    // Enriched failure carries per-statement diagnostics: the statement name
    // and the verbatim runner error.
    const firstFailed = result.failure?.failedStatements?.[0];
    expect(firstFailed).toBeDefined();
    expect(firstFailed?.name).toBeTruthy();
    expect(firstFailed?.error).toContain('forced apply failure');
  });

  it('throws when no runner resolves and dryRun is not set', async () => {
    // A project with no integration + no runner path + local fallback off →
    // resolveEntityGraphRunner returns undefined; we must fail loud, not
    // silently downgrade to a dry run.
    writeProject();
    const error = await applyReviewDecisions({
      cwd: tmpDir,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandError);
    const commandError = error as CommandError;
    expect(commandError.exitCode).toBe(1);
    expect(commandError.payload).toMatchObject({
      valid: false,
      errorCode: 'NO_RUNNER_RESOLVED',
    });
  });

  it('persists the decision trace into the warehouse audit_log on the apply path', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle({ learning_context: 'cited prior merge on p1' }),
      decisionTrace: {
        policyVersion: 'pol-abc123',
        configSnapshot: { spec: 'company_resolution', auto_apply_threshold: 0.75 },
        langsmithTraceId: 'ls-trace-xyz',
        precedentRefs: ['batch-0', 'batch-1'],
      },
    });

    const names = result.statements.map((statement) => statement.name);
    // The programmatic API now emits the audit_log DDL + the review_apply audit
    // row (previously only the CLI did) — this is the warehouse decision trace.
    expect(names).toContain('ddl_audit_log');
    expect(names).toContain('audit_review_apply');
    // Audit precedes the per-pair writes so the payload `skipped` EXISTS-check
    // reflects pre-insert state (idempotent replay detection).
    expect(names.indexOf('audit_review_apply')).toBeLessThan(
      names.indexOf('apply_review_decisions')
    );

    const auditSql = result.statements.find((s) => s.name === 'audit_review_apply')?.sql ?? '';
    expect(auditSql).toContain('policy_version');
    expect(auditSql).toContain('pol-abc123');
    expect(auditSql).toContain('langsmith_trace_id');
    expect(auditSql).toContain('ls-trace-xyz');
    expect(auditSql).toContain('config_snapshot');
    expect(auditSql).toContain('auto_apply_threshold');
    expect(auditSql).toContain('precedent_refs');
    expect(auditSql).toContain('batch-0');
    // learning_context lands in the audit row's `reason` column.
    expect(auditSql).toContain('cited prior merge on p1');
  });

  it('falls back to the bundle precedent_refs when decisionTrace omits them', async () => {
    const { logPath, runnerPath } = writeProject();
    process.env.ENTITY_GRAPH_TEST_RUNNER_LOG = logPath;

    const result = await applyReviewDecisions({
      cwd: tmpDir,
      runner: runnerPath,
      dialect: 'duckdb',
      schema: 'entity_graph',
      quiet: true,
      bundle: makeBundle({ precedent_refs: ['bundle-ref-1'] }),
      // decisionTrace is present but omits precedentRefs — exercises the
      // `trace?.precedentRefs ?? bundle.precedent_refs` fallback specifically.
      decisionTrace: { policyVersion: 'pol-fallback-check' },
    });

    const auditSql = result.statements.find((s) => s.name === 'audit_review_apply')?.sql ?? '';
    expect(auditSql).toContain('precedent_refs');
    expect(auditSql).toContain('bundle-ref-1');
    expect(auditSql).toContain('pol-fallback-check');
  });
});
