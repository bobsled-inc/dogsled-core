import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_READY, makeProject, parseJsonStdout, run } from './helpers.js';

const SPAWN_TEST_TIMEOUT_MS = 60_000;
const MULTI_SPAWN_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!CLI_READY)('entity-graph CLI (e2e)', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let tmpDir: string;
  let projectDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-graph-cli-'));
    projectDir = makeProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has a runnable CLI entrypoint', () => {
    expect(CLI_READY).toBe(true);
  });

  it('prints help and exits 0', () => {
    const result = run(['--help'], projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Bobsled Core Entity Graph');
    expect(result.stdout).toContain('relate');
    expect(result.stdout).toContain('object');
    expect(result.stdout).toContain('explain');
    expect(result.stdout).toContain('forget');
    expect(result.stdout).toContain('quickstart');
    expect(result.stdout).toContain('fixtures');
    expect(result.stdout).toContain('scaffold');
    expect(result.stdout).toContain('suggest');
    expect(result.stdout).toContain('diff');
  });

  it(
    'returns structured JSON for resolve validate and compile',
    () => {
      const validateResult = run(
        ['resolve', 'validate', 'company', '--json', '--quiet', '--dialect', 'snowflake'],
        projectDir
      );

      expect(validateResult.exitCode).toBe(0);
      const validateJson = parseJsonStdout<{
        command: string;
        entities: Array<{
          entity: string;
          name: string;
          target_schema: string;
        }>;
      }>(validateResult);
      expect(validateJson.command).toBe('resolve.validate');
      expect(validateJson.entities).toHaveLength(1);
      expect(validateJson.entities[0]).toMatchObject({
        entity: 'company',
        name: 'company_resolution',
        target_schema: 'entity_graph',
      });

      const compileResult = run(
        ['resolve', 'compile', 'company', '--json', '--quiet', '--dialect', 'snowflake'],
        projectDir
      );

      expect(compileResult.exitCode).toBe(0);
      const compileJson = parseJsonStdout<{
        command: string;
        entities: Array<{ entity: string; statement_count: number }>;
      }>(compileResult);
      expect(compileJson.command).toBe('resolve.compile');
      expect(compileJson.entities).toHaveLength(1);
      expect(compileJson.entities[0]?.entity).toBe('company');
      expect(compileJson.entities[0]?.statement_count).toBeGreaterThan(1);
    },
    MULTI_SPAWN_TEST_TIMEOUT_MS
  );

  it(
    'emits YAML for resolve compile',
    () => {
      const result = run(
        ['resolve', 'compile', 'company', '--yaml', '--quiet', '--dialect', 'snowflake'],
        projectDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('command: resolve.compile');
      expect(result.stdout).toContain('entities:');
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it(
    'lists maintained fixtures',
    () => {
      const result = run(['fixtures', 'list', '--json'], projectDir);

      expect(result.exitCode).toBe(0);
      const payload = parseJsonStdout<{ command: string; fixtures: Array<{ name: string }> }>(
        result
      );
      expect(payload.command).toBe('entity-graph.fixtures.list');
      expect(payload.fixtures.map((fixture) => fixture.name)).toContain('b2b-company-master');
    },
    SPAWN_TEST_TIMEOUT_MS
  );

  it('reports review export validation errors when no entity graph specs are present', () => {
    const emptyProjectDir = path.join(tmpDir, 'empty-project');
    fs.mkdirSync(emptyProjectDir, { recursive: true });

    const result = run(['review', 'export', 'company', '--dialect', 'snowflake'], emptyProjectDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('No resolution specs found in entity-graph/');
  });

  it(
    'reports resolve validation errors with validation exit codes',
    () => {
      const emptyProjectDir = path.join(tmpDir, 'empty-resolve-project');
      fs.mkdirSync(emptyProjectDir, { recursive: true });

      const missingDir = run(
        ['resolve', 'validate', 'company', '--dialect', 'snowflake'],
        emptyProjectDir
      );
      expect(missingDir.exitCode).toBe(2);
      expect(missingDir.stderr).toContain('No entity-graph/ directory found');

      const missingEntity = run(
        ['resolve', 'validate', 'missing-company', '--dialect', 'snowflake'],
        projectDir
      );
      expect(missingEntity.exitCode).toBe(2);
      expect(missingEntity.stderr).toContain('No resolution specs found matching: missing-company');
    },
    MULTI_SPAWN_TEST_TIMEOUT_MS
  );
});
