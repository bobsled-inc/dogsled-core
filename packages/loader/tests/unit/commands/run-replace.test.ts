import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDatabaseLoader } from '../../../src/commands/run.js';
import { DuckDbDestination } from '../../../src/runtime/destinations/duckdb.js';
import { BufferingWritable } from '../../helpers/stream.js';
import { queryPersistentDb } from '../../helpers/duckdb.js';

const STREAM = 'docs__chunks';
const at = '2026-01-01T00:00:00.000Z';

function line(message: Record<string, unknown>): string {
  return `${JSON.stringify({ _v: 1, ...message })}\n`;
}
const schema = line({
  type: 'SCHEMA',
  stream: STREAM,
  schema: {
    columns: [
      { name: 'document_id', type: 'string' },
      { name: 'chunk_index', type: 'integer' },
      { name: 'text', type: 'string' },
    ],
  },
  key_properties: [],
  load_strategy: 'append',
});
const replace = (...values: string[]) =>
  line({ type: 'REPLACE', stream: STREAM, key: 'document_id', values });
const chunks = (documentId: string, count: number, tag: string) =>
  Array.from({ length: count }, (_, index) =>
    line({
      type: 'RECORD',
      stream: STREAM,
      record: { document_id: documentId, chunk_index: index, text: `${tag}-${index}` },
      time_extracted: at,
    })
  );
const state = line({ type: 'STATE', stream: STREAM, value: { record_count: 0 } });

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-replace-'));
  dbPath = path.join(dir, 'replace.duckdb');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function load(lines: string[], bufferSize = 1000): Promise<void> {
  await runDatabaseLoader(
    {
      dest: 'duckdb',
      dbPath,
      targetSchema: 'main',
      bufferSize,
      logFormat: 'text',
      maxConcurrentLoads: 4,
    },
    {
      createDatabaseDestination: () => new DuckDbDestination({ dbPath }),
      input: Readable.from(lines),
      stdout: new BufferingWritable(),
      stderr: new BufferingWritable(),
    }
  );
}

async function counts(): Promise<Record<string, number>> {
  const rows = await queryPersistentDb(
    dbPath,
    `SELECT document_id, count(*) AS n FROM main.${STREAM} GROUP BY 1 ORDER BY 1`
  );
  return Object.fromEntries(rows.map((row) => [String(row['document_id']), Number(row['n'])]));
}

describe('runDatabaseLoader: REPLACE', () => {
  it('replaces a shrinking slice without stale rows and keeps other slices', async () => {
    await load([
      schema,
      replace('a'),
      ...chunks('a', 12, 'v1'),
      replace('b'),
      ...chunks('b', 3, 'v1'),
      state,
    ]);
    expect(await counts()).toEqual({ a: 12, b: 3 });

    await load([schema, replace('a'), ...chunks('a', 10, 'v2'), state]);
    expect(await counts()).toEqual({ a: 10, b: 3 });
    const stale = await queryPersistentDb(
      dbPath,
      `SELECT count(*) AS n FROM main.${STREAM} WHERE document_id = 'a' AND text LIKE 'v1-%'`
    );
    expect(Number(stale[0]?.['n'])).toBe(0);
  });

  it('empties a slice that is replaced by no rows', async () => {
    await load([
      schema,
      replace('a', 'b'),
      ...chunks('a', 2, 'v1'),
      ...chunks('b', 2, 'v1'),
      state,
    ]);
    await load([schema, replace('b'), state]);
    expect(await counts()).toEqual({ a: 2 });
    await load([schema, replace('a')]);
    expect(await counts()).toEqual({});
  });

  it('finishes a delete-only replacement before it forwards STATE', async () => {
    await load([schema, replace('a'), ...chunks('a', 2, 'v1'), state]);
    const events: string[] = [];
    const destination = new DuckDbDestination({ dbPath });
    const deleteRows = destination.deleteRows.bind(destination);
    destination.deleteRows = async (...args) => {
      await deleteRows(...args);
      events.push('delete');
    };
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, done) {
        if (chunk.toString().includes('"STATE"')) events.push('state');
        done();
      },
    });
    await runDatabaseLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 1000,
        logFormat: 'text',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => destination,
        input: Readable.from([schema, replace('a'), state]),
        stdout,
        stderr: new BufferingWritable(),
      }
    );
    expect(events).toEqual(['delete', 'state']);
  });

  it('keeps every row of a slice whose rows span several loads', async () => {
    await load([schema, replace('a'), ...chunks('a', 5, 'v1'), state]);
    await load([schema, replace('a'), ...chunks('a', 7, 'v2'), state], 2);
    expect(await counts()).toEqual({ a: 7 });
  });

  it('runs a slow delete before later loads of the same stream', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const destination = {
      async initialize() {},
      async ensureTable() {},
      async loadAndFinalize(_s: string, _t: string, filePath: string) {
        const text = await fs.readFile(filePath, 'utf8');
        const batch = text
          .trim()
          .split('\n')
          .map((row) => JSON.parse(row));
        rows.push(...batch);
        return { rowsAffected: batch.length };
      },
      async deleteRows(_s: string, _t: string, column: string, values: string[]) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (values.includes(String(rows[i]?.[column]))) rows.splice(i, 1);
        }
      },
      async close() {},
      getTruncatedTables: () => new Set<string>(),
      setTruncatedTables() {},
    };
    await runDatabaseLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 2,
        logFormat: 'text',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => destination,
        input: Readable.from([schema, replace('a'), ...chunks('a', 7, 'v2'), state]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );
    expect(rows).toHaveLength(7);
  });

  it('rejects REPLACE before SCHEMA and keys that are not columns', async () => {
    await expect(load([replace('a')])).rejects.toThrow('before SCHEMA');
    await expect(
      load([schema, line({ type: 'REPLACE', stream: STREAM, key: 'missing', values: ['a'] })])
    ).rejects.toThrow('is not a column');
  });
});
