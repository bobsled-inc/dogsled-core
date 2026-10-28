import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_READY, makeProject, parseJsonStdout, run } from './helpers.js';

const SPAWN_TEST_TIMEOUT_MS = 60_000;

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

  it('returns structured JSON for forget dry-run', () => {
    const result = run(
      [
        'forget',
        '--entity',
        'company',
        '--source-ref',
        'ecom.crm_companies',
        '--pk',
        '{"salesforce_id":"sf-1"}',
        '--dry-run',
        '--json',
        '--quiet',
        '--dialect',
        'duckdb',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout<{
      command: string;
      entity: string;
      executed: boolean;
      dry_run: boolean;
      request_count: number;
      tombstone_ids: string[];
      statements: Array<{ name: string; sql: string }>;
    }>(result);
    expect(payload.command).toBe('entity-graph.forget');
    expect(payload.entity).toBe('company');
    expect(payload.executed).toBe(false);
    expect(payload.dry_run).toBe(true);
    expect(payload.request_count).toBe(1);
    const tombstoneId = payload.tombstone_ids[0];
    expect(tombstoneId).toBeDefined();
    expect(tombstoneId).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.statements.map((statement) => statement.name)).toEqual(
      expect.arrayContaining([
        'forget_tombstone_upsert',
        'forget_purge_standardized',
        `audit_erasure_${tombstoneId?.slice(0, 12)}`,
        'components',
        'entity_profile',
      ])
    );
    // --dry-run is an explicit plan preview, so it surfaces the compiled SQL.
    // (An executed run omits the SQL to avoid leaking the erased PII literals.)
    expect(payload.statements.every((statement) => typeof statement.sql === 'string')).toBe(true);
  });

  it('detects bare mapping YAML forget inputs', () => {
    const inputPath = path.join(tmpDir, 'forget-requests.yml');
    fs.writeFileSync(
      inputPath,
      [
        'requests:',
        '  - source_ref: ecom.crm_companies',
        '    pk:',
        '      salesforce_id: sf-1',
      ].join('\n')
    );

    const result = run(
      [
        'forget',
        '--entity',
        'company',
        '--input',
        inputPath,
        '--dry-run',
        '--json',
        '--quiet',
        '--dialect',
        'duckdb',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout<{
      command: string;
      input_format: string;
      request_count: number;
    }>(result);
    expect(payload.command).toBe('entity-graph.forget');
    expect(payload.input_format).toBe('yaml');
    expect(payload.request_count).toBe(1);
  });

  it('rejects contradictory survivorship flags before planning', () => {
    const result = run(
      [
        'resolve',
        'run',
        'company',
        '--dry-run',
        '--with-survivorship',
        '--without-survivorship',
        '--dialect',
        'snowflake',
      ],
      projectDir
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      '--with-survivorship and --without-survivorship are mutually exclusive.'
    );
  });
});
