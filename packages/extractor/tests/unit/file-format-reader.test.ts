import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FileResourceSpec } from '../../src/types/index.js';
import { DuckDbEngine } from '../../src/runtime/duckdb-engine.js';
import { readFileRecords } from '../../src/runtime/file-format-reader.js';

function resource(): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'customers',
    description: '',
    input: {},
    source: {
      path: '*.csv',
      format: 'csv',
      options: { header: true, null_values: ['NULL'] },
      include_file_metadata: true,
    },
    replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
    extract: {},
    output: {},
  };
}

describe('readFileRecords', () => {
  it('preserves CSV inference, nulls, empty values, quoting, newlines, and metadata while streaming', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'file-format-reader-test-'));
    const stagedPath = path.join(directory, 'customers.csv');
    await writeFile(
      stagedPath,
      'id,name,note\n1,"Ada, Lovelace","line one\nline two"\n2,,NULL\n3,"",""\n'
    );

    const engine = await DuckDbEngine.create();
    try {
      const read = await readFileRecords(
        engine,
        {
          path: 'customers.csv',
          uri: 'file:///customers.csv',
          last_modified: '2026-09-25T12:00:00.000Z',
          etag: 'etag-1',
          size: 100,
        },
        stagedPath,
        resource()
      );
      const records = [];
      for await (const record of read.records) records.push(record);
      await read.close();

      expect(read.columns).toMatchObject({
        id: { type: 'integer' },
        name: { type: 'string' },
        note: { type: 'string' },
        _file_path: { type: 'string' },
        _file_uri: { type: 'string' },
        _file_modified_at: { type: 'timestamp' },
        _file_etag: { type: 'string' },
        _file_size: { type: 'integer' },
      });
      expect(records).toEqual([
        {
          id: 1,
          name: 'Ada, Lovelace',
          note: 'line one\nline two',
          _file_path: 'customers.csv',
          _file_uri: 'file:///customers.csv',
          _file_modified_at: '2026-09-25T12:00:00.000Z',
          _file_etag: 'etag-1',
          _file_size: 100,
        },
        {
          id: 2,
          name: '',
          note: null,
          _file_path: 'customers.csv',
          _file_uri: 'file:///customers.csv',
          _file_modified_at: '2026-09-25T12:00:00.000Z',
          _file_etag: 'etag-1',
          _file_size: 100,
        },
        {
          id: 3,
          name: '',
          note: '',
          _file_path: 'customers.csv',
          _file_uri: 'file:///customers.csv',
          _file_modified_at: '2026-09-25T12:00:00.000Z',
          _file_etag: 'etag-1',
          _file_size: 100,
        },
      ]);
    } finally {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
