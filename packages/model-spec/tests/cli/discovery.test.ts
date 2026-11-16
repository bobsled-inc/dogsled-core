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

import { CLI_READY, makeProject, parseJsonStdout, run } from './helpers.js';

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

  describe('model lineage', () => {
    it('renders the full dependency graph', () => {
      const r = run(['lineage'], projectDir, { BOBSLED_CORE_OUTPUT_FORMAT: 'text' });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('stg_orders');
      expect(r.stdout).toContain('fct_orders');
    });

    it('renders lineage for a single model', () => {
      const r = run(['lineage', 'fct_orders'], projectDir, { BOBSLED_CORE_OUTPUT_FORMAT: 'text' });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('fct_orders');
    });

    it('returns lineage as a JSON envelope', () => {
      const r = run(['lineage', '--integration', 'snowflake', '--json'], projectDir);
      expect(r.exitCode).toBe(0);
      const payload = parseJsonStdout<{
        command: string;
        integrations: Array<{ handle: string; column_lineage: Array<{ model: string }> }>;
      }>(r);
      expect(payload.command).toBe('model.lineage');
      expect(payload.integrations[0]?.handle).toBe('snowflake');
      expect(
        payload.integrations[0]?.column_lineage.some((entry) => entry.model === 'stg_orders')
      ).toBe(true);
    });

    it('returns lineage as JSON in auto structured output mode', () => {
      const r = run(['lineage', '--integration', 'snowflake'], projectDir);
      expect(r.exitCode).toBe(0);
      const payload = parseJsonStdout<{
        command: string;
        integrations: Array<{ handle: string; column_lineage: Array<{ model: string }> }>;
      }>(r);
      expect(payload.command).toBe('model.lineage');
      expect(payload.integrations[0]?.handle).toBe('snowflake');
    });

    it('returns lineage as a YAML envelope', () => {
      const r = run(['lineage', '--integration', 'snowflake', '--yaml'], projectDir);
      expect(r.exitCode).toBe(0);
      const payload = parseYaml(r.stdout) as {
        command: string;
        integrations: Array<{ handle: string; column_lineage: Array<{ model: string }> }>;
      };
      expect(payload.command).toBe('model.lineage');
      expect(payload.integrations[0]?.handle).toBe('snowflake');
      expect(
        payload.integrations[0]?.column_lineage.some((entry) => entry.model === 'stg_orders')
      ).toBe(true);
    });

    it('filters JSON lineage to a single column', () => {
      const r = run(
        ['lineage', '--integration', 'snowflake', '--column', 'stg_orders.ORDER_ID', '--json'],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      const payload = parseJsonStdout<{
        integrations: Array<{
          column_lineage: Array<{
            model: string;
            column: string;
            upstream: Array<{ column: string }>;
          }>;
        }>;
      }>(r);
      expect(payload.integrations[0]?.column_lineage).toHaveLength(1);
      expect(payload.integrations[0]?.column_lineage[0]).toMatchObject({
        model: 'stg_orders',
        column: 'ORDER_ID',
        upstream: [{ column: 'ID' }],
        isComplete: true,
      });
    });

    it('filters YAML lineage to a single column', () => {
      const r = run(
        ['lineage', '--integration', 'snowflake', '--column', 'stg_orders.ORDER_ID', '--yaml'],
        projectDir
      );
      expect(r.exitCode).toBe(0);
      const payload = parseYaml(r.stdout) as {
        integrations: Array<{
          column_lineage: Array<{
            model: string;
            column: string;
            upstream: Array<{ column: string }>;
          }>;
        }>;
      };
      expect(payload.integrations[0]?.column_lineage).toHaveLength(1);
      expect(payload.integrations[0]?.column_lineage[0]).toMatchObject({
        model: 'stg_orders',
        column: 'ORDER_ID',
        upstream: [{ column: 'ID' }],
        isComplete: true,
      });
    });

    it('rejects mutually exclusive structured lineage formats', () => {
      const r = run(['lineage', '--integration', 'snowflake', '--json', '--yaml'], projectDir);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--json and --yaml cannot be used together');
    });

    it('rejects --column combined with positional model arguments', () => {
      const r = run(
        ['lineage', '--integration', 'snowflake', '--column', 'stg_orders.ORDER_ID', 'fct_orders'],
        projectDir
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--column cannot be combined with positional model arguments');
    });
  });

  describe('model init', () => {
    it('scaffolds a new project', () => {
      const initDir = path.join(tmpDir, 'new-project');
      const r = run(['init', initDir, '--quiet'], tmpDir);
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(path.join(initDir, 'sources'))).toBe(true);
      expect(fs.existsSync(path.join(initDir, 'models'))).toBe(true);
      expect(fs.existsSync(path.join(initDir, 'model-spec.yml'))).toBe(true);
      expect(fs.existsSync(path.join(initDir, '.gitignore'))).toBe(true);
    });
  });

  describe('model models', () => {
    it('lists the available prebuilt model packages', () => {
      const r = run(['models', 'list'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('stripe:');
      expect(r.stderr).toContain('salesforce:');
      expect(r.stderr).toContain('jira:');
      expect(r.stderr).toContain('pipedrive:');
      expect(r.stderr).toContain('shopify:');
      expect(r.stderr).toContain('zendesk:');
      expect(r.stderr).toContain('chargebee:');
      expect(r.stderr).toContain('freshdesk:');
      expect(r.stderr).toContain('linear:');
      expect(r.stderr).toContain('github:');
      expect(r.stderr).toContain('hubspot:');
      expect(r.stderr).toContain('vantage:');
      expect(r.stderr).toContain('vercel:');
      expect(r.stderr).toContain('smartlead:');
    });

    it('shows package details for a named model package', () => {
      const r = run(['models', 'info', 'stripe'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('Stripe (stripe)');
      expect(r.stderr).toContain('Resources:');
      expect(r.stderr).toContain('metrics:');
      expect(r.stderr).toContain('relationships:');
      expect(r.stderr).toContain('Marts:');
      expect(r.stderr).toContain('Metrics:');
      expect(r.stderr).toContain('stripe_total_charge_amount');
      expect(r.stderr).toContain('Relationships: stripe_charges_to_customers');
    });

    it('installs a package into the current project', () => {
      const installDir = path.join(tmpDir, 'installed-project');
      fs.mkdirSync(installDir, { recursive: true });

      const r = run(['models', 'install', 'github', '--schema', 'landing'], installDir);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('Installed github');

      const sourceFile = path.join(installDir, 'sources', 'github', 'raw_repos.yml');
      const modelFile = path.join(installDir, 'models', 'github', 'github__repos.yml');
      const metricFile = path.join(
        installDir,
        'metrics',
        'github',
        'github_pull_request_count.yml'
      );
      const relationshipFile = path.join(
        installDir,
        'relationships',
        'github',
        'github_deployments_to_commits.yml'
      );

      expect(fs.existsSync(sourceFile)).toBe(true);
      expect(fs.existsSync(modelFile)).toBe(true);
      expect(fs.existsSync(metricFile)).toBe(true);
      expect(fs.existsSync(relationshipFile)).toBe(true);
      expect(fs.readFileSync(sourceFile, 'utf-8')).toContain('table: landing.raw_github__repos');
    });
  });

  describe('cross-dialect output', () => {
    it('produces BigQuery-style backtick quoting', () => {
      const r = run(['compile', 'stg_orders', '--quiet', '--integration', 'bigquery'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('`');
    });

    it('produces Postgres-style lowercase quoting', () => {
      const r = run(['compile', 'stg_orders', '--quiet', '--integration', 'postgres'], projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toLowerCase()).toContain('stg_orders');
    });
  });
});
