import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeLoadAssert, runLoadAssertCommand } from '../../../src/commands/assert.js';
import {
  closeConnection,
  closeDatabase,
  openDuckDb,
  runStatement,
} from '../../../src/runtime/duckdb-primitives.js';

function collect(stream: PassThrough): () => string {
  let output = '';
  stream.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

describe('load assert command', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    process.exitCode = undefined;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-assert-test-'));
    dbPath = path.join(tempDir, 'test.duckdb');

    const db = await openDuckDb(dbPath);
    const conn = await db.connect();
    await runStatement(conn, 'CREATE TABLE issues (id INTEGER, title VARCHAR, status VARCHAR)');
    await runStatement(conn, "INSERT INTO issues VALUES (1, 'Bug fix', 'open')");
    await runStatement(conn, "INSERT INTO issues VALUES (2, 'Feature request', 'closed')");
    await runStatement(conn, "INSERT INTO issues VALUES (3, 'Docs update', 'open')");
    await closeConnection(conn);
    await closeDatabase(db);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('passes DuckDB checks and normalizes BIGINT counts to numbers', async () => {
    const checksPath = path.join(tempDir, 'checks.yml');
    await fs.writeFile(
      checksPath,
      [
        'checks:',
        '  - name: issues_loaded',
        '    sql: SELECT COUNT(*) AS count FROM issues',
        '    expect:',
        '      count:',
        '        min: 3',
        '        max: 3',
        '        equals: 3',
      ].join('\n')
    );

    const result = await executeLoadAssert({ checks: checksPath, dbPath });

    expect(result.valid).toBe(true);
    expect(result.summary).toEqual({ total: 1, passed: 1, failed: 0 });
    expect(result.checks[0]?.assertions.map((assertion) => assertion.actual)).toEqual([3, 3, 3]);
  });

  it('sets validation exit code 2 when an assertion fails', async () => {
    const checksPath = path.join(tempDir, 'checks.yml');
    await fs.writeFile(
      checksPath,
      [
        'checks:',
        '  - name: too_many_required',
        '    sql: SELECT COUNT(*) AS count FROM issues',
        '    expect:',
        '      count:',
        '        min: 4',
      ].join('\n')
    );

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOutput = collect(stdout);

    await runLoadAssertCommand({ checks: checksPath, dbPath, json: true }, { stdout, stderr });

    expect(process.exitCode).toBe(2);
    const payload = JSON.parse(getOutput()) as {
      valid: boolean;
      checks: Array<{ assertions: Array<{ message: string }> }>;
    };
    expect(payload.valid).toBe(false);
    expect(payload.checks[0]?.assertions[0]?.message).toContain('expected >= 4');
  });

  it('emits YAML output for agents that prefer YAML artifacts', async () => {
    const checksPath = path.join(tempDir, 'checks.yml');
    await fs.writeFile(
      checksPath,
      [
        '- name: open_issues',
        "  sql: SELECT COUNT(*) AS count FROM issues WHERE status = 'open'",
        '  expect:',
        '    count:',
        '      equals: 2',
      ].join('\n')
    );

    const stdout = new PassThrough();
    const getOutput = collect(stdout);

    await runLoadAssertCommand({ checks: checksPath, dbPath, yaml: true }, { stdout });

    expect(process.exitCode).toBeUndefined();
    expect(getOutput()).toContain('valid: true');
    expect(getOutput()).toContain('actual: 2');
  });

  it('rejects invalid check files with exit code 2', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const getOutput = collect(stdout);

    await runLoadAssertCommand(
      { checks: 'bad.yml', dbPath, json: true, cwd: tempDir },
      {
        stdout,
        stderr,
        readFile: async () => 'checks:\n  - name: missing_sql\n',
      }
    );

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(getOutput())).toMatchObject({
      valid: false,
      exit_code: 2,
    });
  });

  it('runs BigQuery checks through the destination query adapter', async () => {
    const checksPath = path.join(tempDir, 'checks.yml');
    await fs.writeFile(
      checksPath,
      [
        'checks:',
        '  - name: bq_rows',
        '    sql: SELECT 5 AS count',
        '    expect:',
        '      count:',
        '        min: 5',
      ].join('\n')
    );
    let capturedSql = '';
    let capturedProject: string | undefined;

    const result = await executeLoadAssert(
      {
        checks: checksPath,
        dest: 'bigquery',
        projectId: 'analytics-prod',
        location: 'US',
      },
      {
        runBigQueryQuery: async (sql, options) => {
          capturedSql = sql;
          capturedProject = options.projectId;
          return [{ count: '5' }];
        },
      }
    );

    expect(result.valid).toBe(true);
    expect(capturedSql).toBe('SELECT 5 AS count');
    expect(capturedProject).toBe('analytics-prod');
  });
});
