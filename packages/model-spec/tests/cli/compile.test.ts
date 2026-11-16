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

import { CLI_READY, makeProject, makeWritableProject, run } from './helpers.js';

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

  describe('model --help', () => {
    it('prints usage and exits 0', () => {
      const r = run(['--help'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Usage:');
      expect(r.stdout).toContain('compile');
      expect(r.stdout).toContain('models');
      expect(r.stdout).toContain('validate');
      expect(r.stdout).toContain('lineage');
    });
  });

  describe('model compile', () => {
    it(
      'compiles all models to stdout',
      {
        // CI can run this subprocess-heavy compile under enough contention
        // that it exceeds the default per-test timeout even when the command
        // itself succeeds well within the spawnSync timeout.
        timeout: CLI_SUITE_TIMEOUT_MS,
      },
      () => {
        const r = run(['compile', '--quiet', '--integration', 'snowflake'], projectDir);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('CREATE OR REPLACE VIEW');
        expect(r.stdout).toContain('STG_ORDERS');
        expect(r.stdout).toContain('FCT_ORDERS');
      }
    );

    it('compiles a single model by name', () => {
      const r = run(['compile', 'stg_orders', '--quiet', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('STG_ORDERS');
      expect(r.stdout).not.toContain('FCT_ORDERS');
    });

    it('writes SQL files under <outDir>/<integration>/', () => {
      const outDir = path.join(tmpDir, 'sql-out');
      const r = run(
        ['compile', '--quiet', '--integration', 'snowflake', '--output', outDir],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      // Output layout reserves one directory per integration so a future
      // multi-integration compile can write sibling folders without a
      // breaking change.
      expect(fs.existsSync(path.join(outDir, 'snowflake', 'STG_ORDERS.sql'))).toBe(true);
      expect(fs.existsSync(path.join(outDir, 'snowflake', 'FCT_ORDERS.sql'))).toBe(true);

      const sql = fs.readFileSync(path.join(outDir, 'snowflake', 'STG_ORDERS.sql'), 'utf-8');
      expect(sql).toContain('CREATE OR REPLACE VIEW');
    });

    it('emits metrics/relationships/vqs JSON when --include-metadata is set', () => {
      const outDir = path.join(tmpDir, 'sql-meta');
      const r = run(
        [
          'compile',
          '--quiet',
          '--integration',
          'snowflake',
          '--output',
          outDir,
          '--include-metadata',
        ],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      // Metadata lives at the output root — not scoped under an integration —
      // because the Data Estate UI reads it once per deploy regardless of how
      // many integrations the project declares.
      const metricsPath = path.join(outDir, 'metrics.json');
      const relationshipsPath = path.join(outDir, 'relationships.json');
      const entityRelationshipsPath = path.join(outDir, 'entity-relationships.json');
      const vqsPath = path.join(outDir, 'vqs.json');
      expect(fs.existsSync(metricsPath)).toBe(true);
      expect(fs.existsSync(relationshipsPath)).toBe(true);
      expect(fs.existsSync(entityRelationshipsPath)).toBe(true);
      expect(fs.existsSync(vqsPath)).toBe(true);

      const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as Array<{
        name: string;
      }>;
      expect(metrics.map((m) => m.name)).toEqual(['orders_total']);

      const relationships = JSON.parse(fs.readFileSync(relationshipsPath, 'utf-8')) as Array<{
        name: string;
      }>;
      expect(relationships.map((r) => r.name)).toEqual(['orders_to_customers']);

      const entityRelationships = JSON.parse(
        fs.readFileSync(entityRelationshipsPath, 'utf-8')
      ) as Array<{ name: string }>;
      expect(entityRelationships.map((r) => r.name)).toEqual(['works_at']);

      const vqs = JSON.parse(fs.readFileSync(vqsPath, 'utf-8')) as Array<{ name: string }>;
      expect(vqs.map((v) => v.name)).toEqual(['top_customers']);
    });

    it('rejects --include-metadata without --output', () => {
      const r = run(
        ['compile', '--quiet', '--integration', 'snowflake', '--include-metadata'],
        projectDir
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--include-metadata requires --output');
    });

    it('supports every V0 dialect via integration handles', { timeout: 90_000 }, () => {
      // Coverage limited to dialects the shared @bobsled-inc/connections package
      // ships in V0 (D8 in the plan). redshift / pgvector / mysql stay in the
      // extractor's schema until the follow-up consolidation PR.
      for (const handle of ['snowflake', 'bigquery', 'postgres', 'databricks', 'duckdb'] as const) {
        const r = run(['compile', 'stg_orders', '--quiet', '--integration', handle], projectDir);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
      }
    });

    it('exits 2 for unknown model name', () => {
      const r = run(['compile', 'nonexistent_model', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(2);
    });

    it('exits 2 when no models/ directory exists', () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const r = run(['compile'], emptyDir);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/No (models\/ directory found|integrations found\.)/);
    });

    it(
      'uses the integration-declared schema name in DDL',
      {
        // Same CI-contention rationale as the `compiles all models to stdout`
        // test above — subprocess spawn + compile occasionally exceeds the
        // default 10s test timeout on busy CI runners.
        timeout: CLI_SUITE_TIMEOUT_MS,
      },
      () => {
        const r = run(
          ['compile', 'stg_orders', '--quiet', '--integration', 'snowflake_analytics'],
          projectDir
        );
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('ANALYTICS');
      }
    );

    it('resolves env-template target database before rendering DDL identifiers', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'compile-env-db'));
      fs.writeFileSync(
        path.join(writable, 'integrations', 'snowflake.yml'),
        `spec_version: '1'
auth_env_vars: [BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE]
type: integration
name: snowflake
source_type: snowflake
connection:
  account_identifier: xt00000
  warehouse: COMPUTE_WH
  role: BMS_TEST_ROLE
  database: \${{ env.BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE }}
auth:
  type: pat
  token: tok-placeholder
`,
        'utf-8'
      );

      const r = run(['compile', 'stg_orders', '--quiet', '--integration', 'snowflake'], writable, {
        BOBSLED_CORE_MODEL_SPEC_TEST_DATABASE: 'DEMO_DB',
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"DEMO_DB"."PUBLIC"."STG_ORDERS"');
      expect(r.stdout).not.toContain('${{');
    });

    it('uses the Snowflake integration warehouse for dynamic table DDL by default', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'compile-dynamic-table'));
      fs.writeFileSync(
        path.join(writable, 'models', 'hot_orders.yml'),
        `spec_version: '0.2'
name: hot_orders
type: model
description: Dynamic table over staged orders.
grain: ORDER_ID
source:
  ref: stg_orders
columns:
  - { name: ORDER_ID, expr: ORDER_ID }
  - { name: SUBTOTAL, expr: SUBTOTAL }
materialization:
  type: dynamic_table
`,
        'utf-8'
      );

      const r = run(['compile', 'hot_orders', '--quiet', '--integration', 'snowflake'], writable);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('CREATE OR REPLACE DYNAMIC TABLE');
      expect(r.stdout).toContain('WAREHOUSE = COMPUTE_WH');
      expect(r.stdout).not.toContain('CURRENT_WAREHOUSE()');
    });

    it('fans out without --integration, compiling the integration that owns the models and skipping the rest', () => {
      // All fixture sources have `connection: ecom`, so only the `ecom`
      // integration (source_type: duckdb) has any models. The six other
      // declared integrations emit a warning and are skipped.
      const r = run(['compile', '--quiet'], projectDir);
      expect(r.exitCode).toBe(0);
      // DuckDB dialect → lowercase identifiers.
      expect(r.stdout).toContain('stg_orders');
      expect(r.stderr).toMatch(/no models reference it/);
    });

    it('rejects model-level target_database when the active integration is Postgres', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'pg-db-override'));
      const modelPath = path.join(writable, 'models', 'stg_orders.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(modelPath, `${original}\ntarget_database: other_db\n`, 'utf-8');

      const r = run(['compile', 'stg_orders', '--integration', 'postgres'], writable);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('target_database');
      expect(r.stderr).toContain('Postgres');
    });

    it('honors model-level target_schema overrides when resolving downstream refs', () => {
      const writable = makeWritableProject(path.join(tmpDir, 'pg-schema-override'));
      const modelPath = path.join(writable, 'models', 'stg_orders.yml');
      const original = fs.readFileSync(modelPath, 'utf-8');
      fs.writeFileSync(modelPath, `${original}\ntarget_schema: staging\n`, 'utf-8');

      const r = run(['compile', '--quiet', '--integration', 'snowflake'], writable);
      expect(r.exitCode).toBe(0);
      // fct_orders references stg_orders — the resolved ref must use the
      // override schema (STAGING) instead of the integration default (PUBLIC).
      expect(r.stdout).toContain('"STAGING"."STG_ORDERS"');
    });

    it('compiles dim_products which has a source filter', () => {
      const r = run(
        ['compile', 'dim_products', '--quiet', '--integration', 'snowflake'],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('DIM_PRODUCTS');
      expect(r.stdout).toContain('IS_ACTIVE');
    });

    it('compiles order_items which has a LEFT JOIN', () => {
      const r = run(
        ['compile', 'order_items', '--quiet', '--integration', 'snowflake'],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('LEFT JOIN');
    });

    it('compiles fct_orders which joins stg_orders + stg_customers', () => {
      const r = run(['compile', 'fct_orders', '--quiet', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('LEFT JOIN');
      expect(r.stdout).toContain('FCT_ORDERS');
    });

    it('compiles models in dependency order (stg before fct)', () => {
      const r = run(['compile', '--quiet', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);

      const stgIdx = r.stdout.indexOf('STG_ORDERS');
      const fctIdx = r.stdout.indexOf('FCT_ORDERS');
      expect(stgIdx).toBeGreaterThan(-1);
      expect(fctIdx).toBeGreaterThan(-1);
      expect(stgIdx).toBeLessThan(fctIdx);
    });
  });
});
