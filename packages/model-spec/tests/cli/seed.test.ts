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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLI_READY,
  PKG_ROOT,
  makeProject,
  makeWritableProject,
  parseJsonStdout,
  readRunnerLog,
  run,
  writeRunner,
} from './helpers.js';

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

  describe('seed workflow', () => {
    it('executes seed load with a runner', () => {
      const { logPath, runnerPath } = writeRunner(projectDir);
      const r = run(['seed', 'load', '--runner', runnerPath, '--dialect', 'snowflake'], projectDir);

      expect(r.exitCode).toBe(0);
      const log = readRunnerLog(logPath);
      expect(log.some((entry) => entry.sql.includes('"BMS_SEEDS"."LEGAL_SUFFIXES"'))).toBe(true);
    });

    it('returns structured JSON for seed validate, load, and diff', () => {
      const validateResult = run(['seed', 'validate', '--json', '--quiet'], projectDir);
      expect(validateResult.exitCode).toBe(0);
      const validateJson = parseJsonStdout<{
        command: string;
        seed_count: number;
        seeds: Array<{ name: string; status: string }>;
      }>(validateResult);
      expect(validateJson.command).toBe('seed.validate');
      expect(validateJson.seed_count).toBeGreaterThan(0);
      expect(validateJson.seeds.every((seed) => seed.status === 'valid')).toBe(true);

      const { logPath, runnerPath } = writeRunner(projectDir);
      const loadResult = run(
        ['seed', 'load', '--runner', runnerPath, '--json', '--quiet', '--dialect', 'snowflake'],
        projectDir
      );
      expect(loadResult.exitCode).toBe(0);
      const loadJson = parseJsonStdout<{
        command: string;
        schema: string;
        seeds: Array<{ name: string; schema: string; executed: boolean; rows_loaded: number }>;
      }>(loadResult);
      expect(loadJson.command).toBe('seed.load');
      expect(loadJson.schema).toBe('PUBLIC');
      expect(loadJson.seeds[0]?.schema).toBe('bms_seeds');
      expect(loadJson.seeds.every((seed) => seed.executed)).toBe(true);
      expect(loadJson.seeds[0]?.rows_loaded).toBeGreaterThan(0);

      const diffResult = run(['seed', 'diff', '--json', '--quiet'], projectDir);
      expect(diffResult.exitCode).toBe(2);
      const diffJson = parseJsonStdout<{
        command: string;
        implemented: boolean;
        requires_runner: boolean;
      }>(diffResult);
      expect(diffJson.command).toBe('seed.diff');
      expect(diffJson.implemented).toBe(false);
      expect(diffJson.requires_runner).toBe(true);

      const log = readRunnerLog(logPath);
      expect(log.some((entry) => entry.sql.includes('"BMS_SEEDS"."LEGAL_SUFFIXES"'))).toBe(true);
    });

    it('returns validation exit code 2 for invalid seed validate input', () => {
      const invalidProjectDir = makeWritableProject(
        path.join(tmpDir, 'invalid-seed-validate-project')
      );
      fs.writeFileSync(
        path.join(invalidProjectDir, 'seeds', 'data', 'legal_suffixes.csv'),
        ['suffix,normalized_form', 'LLC,'].join('\n'),
        'utf-8'
      );

      const result = run(['seed', 'validate', '--json', '--quiet'], invalidProjectDir);

      expect(result.exitCode).toBe(2);
      const validateJson = parseJsonStdout<{
        command: string;
        error_count: number;
        seeds: Array<{ name: string; status: string; error?: string }>;
      }>(result);
      expect(validateJson.command).toBe('seed.validate');
      expect(validateJson.error_count).toBe(1);
      expect(validateJson.seeds[0]?.name).toBe('legal_suffixes');
      expect(validateJson.seeds[0]?.status).toBe('invalid');
      expect(validateJson.seeds[0]?.error).toContain('required column "normalized_form" is blank');
    });

    it('fails seed diff when warehouse rows contain duplicate unique keys', () => {
      const runnerPath = path.join(projectDir, 'seed-duplicate-runner.mjs');
      fs.writeFileSync(
        runnerPath,
        `export default async function run() {
  return { rowCount: 1 };
}
export async function query(sql) {
  return [
    { suffix: 'LLC', normalized_form: 'llc' },
    { suffix: 'LLC', normalized_form: 'llc' }
  ];
}
`,
        'utf-8'
      );

      const result = run(
        ['seed', 'diff', '--runner', runnerPath, '--dialect', 'snowflake'],
        projectDir
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('duplicate unique key');
    });

    it('returns a JSON envelope when seed load fails before runner execution', () => {
      const invalidProjectDir = makeWritableProject(path.join(tmpDir, 'invalid-seed-project'));
      fs.writeFileSync(
        path.join(invalidProjectDir, 'seeds', 'data', 'legal_suffixes.csv'),
        ['suffix', 'llc'].join('\n'),
        'utf-8'
      );

      const { runnerPath } = writeRunner(invalidProjectDir);
      const result = run(
        ['seed', 'load', '--runner', runnerPath, '--json', '--quiet', '--dialect', 'snowflake'],
        invalidProjectDir
      );

      expect(result.exitCode).toBe(1);
      const loadJson = parseJsonStdout<{
        command: string;
        schema: string;
        seeds: Array<{
          name: string;
          schema: string;
          executed: boolean;
          rows_loaded: number;
          error?: string;
        }>;
      }>(result);
      expect(loadJson.command).toBe('seed.load');
      expect(loadJson.seeds).toHaveLength(1);
      expect(loadJson.seeds[0]?.name).toBe('legal_suffixes');
      expect(loadJson.seeds[0]?.executed).toBe(false);
      expect(loadJson.seeds[0]?.rows_loaded).toBe(0);
      expect(loadJson.seeds[0]?.error).toContain('Expected column "normalized_form" not found');
    });
  });
});

const MULTI_FIXTURES = path.join(PKG_ROOT, 'tests', 'fixtures', 'specs-multi');

function makeMultiProject(tmpDir: string): string {
  const projectDir = path.join(tmpDir, 'project-multi');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(path.join(MULTI_FIXTURES, 'sources'), path.join(projectDir, 'sources'), {
    recursive: true,
  });
  fs.cpSync(path.join(MULTI_FIXTURES, 'models'), path.join(projectDir, 'models'), {
    recursive: true,
  });
  fs.cpSync(path.join(MULTI_FIXTURES, 'integrations'), path.join(projectDir, 'integrations'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(MULTI_FIXTURES, 'model-spec.yml'),
    path.join(projectDir, 'model-spec.yml')
  );
  return projectDir;
}

describe.skipIf(!CLI_READY)(
  'model CLI (e2e) multi-integration fan-out',
  { timeout: CLI_SUITE_TIMEOUT_MS },
  () => {
    let tmpDir: string;
    let projectDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cli-multi-'));
      projectDir = makeMultiProject(tmpDir);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('compiles every declared integration without --integration', () => {
      const r = run(['compile', '--quiet'], projectDir);
      expect(r.exitCode).toBe(0);
      // Snowflake-dialect model (UPPER case + double-quoted identifiers)
      expect(r.stdout).toContain('STG_ORDERS');
      // BigQuery-dialect model (lower case + backticks)
      expect(r.stdout).toContain('stg_events');
      // Each integration's subgraph is separated by a header
      expect(r.stdout).toContain('-- integration: analytics_bq');
      expect(r.stdout).toContain('-- integration: ecom_sf');
    });

    it('writes SQL under target/<handle>/ for each integration', () => {
      const outDir = path.join(tmpDir, 'out');
      const r = run(['compile', '--quiet', '--output', outDir], projectDir);
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(path.join(outDir, 'ecom_sf', 'STG_ORDERS.sql'))).toBe(true);
      // Emitted filenames are always uppercased via toUpperCase() in compile.ts,
      // regardless of model-name casing. Lowercase assertion would only pass on
      // case-insensitive filesystems (macOS) and silently fail on Linux CI.
      expect(fs.existsSync(path.join(outDir, 'analytics_bq', 'STG_EVENTS.sql'))).toBe(true);
    });

    it('narrows to one integration with --integration <handle> (filter, not uniform-stamp)', () => {
      // `--integration <handle>` is a filter: DAG inference runs, then only the
      // subgraph rooted at that handle's sources is compiled. Models whose
      // sources belong to a different handle are dropped, not reassigned, so
      // e.g. passing `--integration snowflake` in a multi-integration project
      // never runs BigQuery-rooted DDL through the Snowflake runner.
      const r = run(['compile', '--quiet', '--integration', 'ecom_sf'], projectDir);
      expect(r.exitCode).toBe(0);
      // Snowflake-dialect output: uppercase + double-quoted identifiers.
      expect(r.stdout).toContain('"STG_ORDERS"');
      // And the analytics_bq subgraph is NOT present.
      expect(r.stdout).not.toContain('stg_events');
    });

    it('rejects a model that mixes handles across sources with CommandError(2)', () => {
      const writable = path.join(tmpDir, 'mixed');
      fs.mkdirSync(writable, { recursive: true });
      fs.cpSync(path.join(MULTI_FIXTURES, 'sources'), path.join(writable, 'sources'), {
        recursive: true,
      });
      fs.cpSync(path.join(MULTI_FIXTURES, 'models'), path.join(writable, 'models'), {
        recursive: true,
      });
      fs.cpSync(path.join(MULTI_FIXTURES, 'integrations'), path.join(writable, 'integrations'), {
        recursive: true,
      });
      fs.copyFileSync(
        path.join(MULTI_FIXTURES, 'model-spec.yml'),
        path.join(writable, 'model-spec.yml')
      );

      fs.writeFileSync(
        path.join(writable, 'models', 'bad_mixed.yml'),
        `spec_version: '0.2'
name: bad_mixed
type: model
description: Mixes Snowflake order rows with BigQuery event rows.
grain: order_id
source:
  ref: ecom_sf.raw_orders
joins:
  - ref: analytics_bq.raw_events
    type: left
    on: 'ecom_sf.raw_orders.ID = analytics_bq.raw_events.event_id'
columns:
  - name: ORDER_ID
    expr: ID
materialization:
  type: view
`,
        'utf-8'
      );

      const r = run(['compile', '--quiet'], writable);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/mixes sources from multiple integrations/);
    });

    it('dry-runs both integrations and interleaves per-integration headers', () => {
      const r = run(['run', '--quiet', '--dry-run'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('-- integration: ecom_sf');
      expect(r.stdout).toContain('-- integration: analytics_bq');
      expect(r.stdout).toContain('-- stg_orders');
      expect(r.stdout).toContain('-- stg_events');
    });

    it('scopes lineage output per integration by default', () => {
      const r = run(['lineage'], projectDir, { BOBSLED_CORE_OUTPUT_FORMAT: 'text' });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('── integration: ecom_sf ──');
      expect(r.stdout).toContain('── integration: analytics_bq ──');
    });
  }
);
