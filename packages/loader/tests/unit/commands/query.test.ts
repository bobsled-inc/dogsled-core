import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runQuery } from '../../../src/commands/query.js';
import {
  closeConnection,
  closeDatabase,
  openDuckDb,
  runStatement,
} from '../../../src/runtime/duckdb-primitives.js';

describe('query command', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-query-test-'));
    dbPath = path.join(tempDir, 'test.duckdb');

    // Pre-populate the database with test data
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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('prints query results as tab-separated values', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const rows = await runQuery(dbPath, 'SELECT id, title FROM issues ORDER BY id', {
      stdout,
      stderr,
      databaseFactory: openDuckDb,
    });

    expect(rows).toHaveLength(3);

    const lines = output.trim().split('\n');
    // Header line
    expect(lines[0]).toBe('id\ttitle');
    // Data rows
    expect(lines[1]).toBe('1\tBug fix');
    expect(lines[2]).toBe('2\tFeature request');
    expect(lines[3]).toBe('3\tDocs update');
  });

  it('prints no results message for empty results', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrOutput = '';
    stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    const rows = await runQuery(dbPath, 'SELECT * FROM issues WHERE id = 999', {
      stdout,
      stderr,
      databaseFactory: openDuckDb,
    });

    expect(rows).toHaveLength(0);
    expect(stderrOutput).toContain('(no results)');
  });

  it('throws on invalid SQL', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    await expect(
      runQuery(dbPath, 'SELECT * FROM nonexistent_table', {
        stdout,
        stderr,
        databaseFactory: openDuckDb,
      })
    ).rejects.toThrow();
  });

  it('handles NULL values', async () => {
    // Insert a row with a NULL value
    const db = await openDuckDb(dbPath);
    const conn = await db.connect();
    await runStatement(conn, "INSERT INTO issues VALUES (4, NULL, 'open')");
    await closeConnection(conn);
    await closeDatabase(db);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    await runQuery(dbPath, 'SELECT id, title FROM issues WHERE id = 4', {
      stdout,
      stderr,
      databaseFactory: openDuckDb,
    });

    const lines = output.trim().split('\n');
    expect(lines[1]).toBe('4\tNULL');
  });
});
