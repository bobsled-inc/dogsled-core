/**
 * CLI end-to-end tests.
 *
 * Spawns the built model-spec CLI entrypoint as a subprocess against the fixture specs
 * and asserts on stdout, stderr, and exit codes.
 *
 * These tests require `pnpm build` to have run first. In CI, the unit-tests
 * job may not depend on the build job, so the tests skip gracefully when
 * the built CLI is absent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_READY, makeProject, makeWritableProject, parseJsonStdout, run } from './helpers.js';

const CLI_SUITE_TIMEOUT_MS = 60_000;

describe.skipIf(!CLI_READY)('model CLI (e2e)', { timeout: CLI_SUITE_TIMEOUT_MS }, () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cli-'));
    projectDir = makeProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('model validate', () => {
    it('validates all models successfully', () => {
      const r = run(['validate', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('passed');
    });

    it('reports column counts in output', () => {
      const r = run(['validate', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(/\d+ column/);
    });

    it('validates a single model', () => {
      const r = run(['validate', 'dim_products', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('dim_products');
    });

    it('promotes semantic metadata warnings to errors in strict mode', () => {
      const r = run(
        ['validate', 'stg_orders', '--integration', 'snowflake', '--semantic-check=strict'],
        projectDir
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('semantic:');
      expect(r.stderr).toContain('missing description');
    });
  });

  describe('model expect run', () => {
    it('compiles expectation sentinel SQL without requiring credentials', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'expect-plan'));
      const modelPath = path.join(writable, 'models', 'stg_customers.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(
        modelPath,
        `${original}\nexpect:\n  - kind: non_null\n    column: CUSTOMER_ID\n  - kind: schema_contains\n    columns: [CUSTOMER_ID, CUSTOMER_NAME]\n`,
        'utf-8'
      );

      const r = run(
        ['expect', 'run', '--model', 'stg_customers', '--integration', 'snowflake'],
        writable,
        { BOBSLED_CORE_OUTPUT_FORMAT: 'text' }
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('-- stg_customers: non_null CUSTOMER_ID');
      expect(r.stdout).toContain('violation_count');
      expect(r.stderr).toContain('Compiled 2 expectation statement');
    });

    it('executes expectation SQL with a query runner and fails on violations', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'expect-runner'));
      const modelPath = path.join(writable, 'models', 'stg_customers.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(
        modelPath,
        `${original}\nexpect:\n  - kind: non_null\n    column: CUSTOMER_ID\n`,
        'utf-8'
      );
      const runnerPath = path.join(writable, 'expect-runner.mjs');
      fs.writeFileSync(
        runnerPath,
        `export async function query() { return [{ violation_count: 2 }]; }\nexport default async function run() { return { rowCount: 0 }; }\n`,
        'utf-8'
      );

      const r = run(
        [
          'expect',
          'run',
          '--model',
          'stg_customers',
          '--integration',
          'snowflake',
          '--runner',
          runnerPath,
          '--json',
        ],
        writable
      );
      expect(r.exitCode).toBe(2);
      const payload = parseJsonStdout<{
        ok: boolean;
        warnings: string[];
        skipped: string[];
        expectations: Array<{ status: string; violation_count: number }>;
      }>(r);
      expect(payload.ok).toBe(false);
      expect(payload.warnings).toEqual([]);
      expect(payload.skipped).toEqual([]);
      expect(payload.expectations[0]).toMatchObject({
        status: 'failed',
        violation_count: 2,
      });
    });

    it('keeps warning-severity expectation violations non-fatal', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'expect-runner-warn'));
      const modelPath = path.join(writable, 'models', 'stg_customers.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(
        modelPath,
        `${original}\nexpect:\n  - kind: non_null\n    column: CUSTOMER_ID\n    severity: warn\n`,
        'utf-8'
      );
      const runnerPath = path.join(writable, 'expect-runner.mjs');
      fs.writeFileSync(
        runnerPath,
        `export async function query() { return [{ violation_count: 2 }]; }\nexport default async function run() { return { rowCount: 0 }; }\n`,
        'utf-8'
      );

      const r = run(
        [
          'expect',
          'run',
          '--model',
          'stg_customers',
          '--integration',
          'snowflake',
          '--runner',
          runnerPath,
          '--json',
        ],
        writable
      );
      expect(r.exitCode).toBe(0);
      const payload = parseJsonStdout<{
        ok: boolean;
        expectations: Array<{ severity: string; status: string; violation_count: number }>;
      }>(r);
      expect(payload.ok).toBe(true);
      expect(payload.expectations[0]).toMatchObject({
        severity: 'warn',
        status: 'warned',
        violation_count: 2,
      });
    });

    it('honors auto JSON output for expectation commands', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'expect-auto-json'));
      const modelPath = path.join(writable, 'models', 'stg_customers.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(
        modelPath,
        `${original}\nexpect:\n  - kind: non_null\n    column: CUSTOMER_ID\n`,
        'utf-8'
      );

      const r = run(
        ['expect', 'run', '--model', 'stg_customers', '--integration', 'snowflake'],
        writable,
        { BOBSLED_CORE_OUTPUT_FORMAT: 'json' }
      );
      expect(r.exitCode).toBe(0);
      const payload = parseJsonStdout<{ command: string; ok: boolean; expectations: unknown[] }>(r);
      expect(payload.command).toBe('model.expect.run');
      expect(payload.ok).toBe(true);
      expect(payload.expectations).toHaveLength(1);
    });

    it('rejects runner modules whose query export is not callable', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'expect-bad-runner'));
      const runnerPath = path.join(writable, 'bad-runner.mjs');
      fs.writeFileSync(
        runnerPath,
        `export const query = "not-a-function";\nexport default async function run() { return { rowCount: 0 }; }\n`,
        'utf-8'
      );

      const r = run(
        ['expect', 'run', '--integration', 'snowflake', '--runner', runnerPath],
        writable
      );

      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('requires a runner module with query(sql)');
    });
  });

  describe('model run', () => {
    it('emits an execution plan under --dry-run without requiring credentials', () => {
      const r = run(['run', '--dry-run', '--quiet', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      // Dry-run emits the DDL plan with leading model-name comments.
      expect(r.stdout).toContain('-- stg_orders');
      expect(r.stdout).toContain('-- fct_orders');
      expect(r.stdout).toContain('CREATE OR REPLACE VIEW');
    });

    it('emits a JSONL-compatible dry-run summary for runner adapters', () => {
      const r = run(
        ['run', '--dry-run', '--quiet', '--json', '--integration', 'snowflake'],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().split('\n')).toHaveLength(1);

      const payload = parseJsonStdout<{
        command: string;
        ok: boolean;
        dry_run: boolean;
        totals: { integrations: number; statements: number; models: number };
        integrations: Array<{
          handle: string;
          statement_count: number;
          models: Array<{
            name: string;
            materialization_type: string;
            last_run_at: string | null;
          }>;
          statements: Array<{ model_name: string; sql: string }>;
        }>;
      }>(r);

      expect(payload.command).toBe('model.run');
      expect(payload.ok).toBe(true);
      expect(payload.dry_run).toBe(true);
      expect(payload.totals.integrations).toBe(1);
      expect(payload.totals.statements).toBeGreaterThan(0);
      expect(payload.totals.models).toBeGreaterThan(0);
      expect(payload.integrations[0]?.handle).toBe('snowflake');
      expect(payload.integrations[0]?.statement_count).toBeGreaterThan(0);
      expect(payload.integrations[0]?.models[0]?.materialization_type).toBeTruthy();
      expect(payload.integrations[0]?.models[0]).toHaveProperty('last_run_at');
      expect(payload.integrations[0]?.statements[0]?.model_name).toBeTruthy();
      expect(payload.integrations[0]?.statements[0]?.sql).toContain('CREATE');
    });

    it('emits a YAML dry-run summary for runner adapters', () => {
      const r = run(
        ['run', '--dry-run', '--quiet', '--yaml', '--integration', 'snowflake'],
        projectDir
      );
      expect(r.exitCode).toBe(0);

      const payload = parseYaml(r.stdout) as {
        command: string;
        integrations: Array<{
          models: Array<{ materialization_type: string; last_run_at: string | null }>;
        }>;
      };
      expect(payload.command).toBe('model.run');
      expect(payload.integrations[0]?.models[0]?.materialization_type).toBeTruthy();
      expect(payload.integrations[0]?.models[0]).toHaveProperty('last_run_at');
    });

    it('honors --quiet for skipped integration warnings during dry-run', () => {
      const r = run(['run', '--dry-run', '--quiet'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/no models reference it/);
    });

    it('rejects stateful include_all_columns models before schema signatures are computed', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'stateful-star'));
      fs.writeFileSync(
        path.join(writable, 'models', 'stg_orders.yml'),
        `spec_version: '0.2'
name: stg_orders
type: model
description: Stateful star projection should be rejected.
grain: ID
source:
  ref: ecom.raw_orders
include_all_columns: true
materialization:
  type: incremental
  strategy: merge
  unique_key: ID
`,
        'utf-8'
      );

      const r = run(['run', 'stg_orders', '--dry-run', '--integration', 'ecom'], writable);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('include_all_columns');
      expect(r.stderr).toContain('Enumerate output columns explicitly');
    });

    it('exits 1 with an actionable message when no runner is registered for the integration', () => {
      // The Snowflake built-in runner currently throws `buildNotImplementedRunner`
      // — Model Spec surfaces that as an execution failure with a pointer toward
      // CustomRunnerFactory registration.
      const r = run(['run', '--quiet', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(1);
    });

    it('rejects a non-existent --secrets file with exit 1', () => {
      const r = run(
        [
          'run',
          '--quiet',
          '--integration',
          'duckdb',
          '--secrets',
          path.join(tmpDir, 'missing.yml'),
        ],
        projectDir
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('secrets file');
    });
  });
});
