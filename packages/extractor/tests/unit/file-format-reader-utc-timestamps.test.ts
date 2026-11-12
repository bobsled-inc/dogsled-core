import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileResourceSpec } from '../../src/types/index.js';
import { DuckDbEngine } from '../../src/runtime/duckdb-engine.js';
import { readFileRecords } from '../../src/runtime/file-format-reader.js';

function resource(): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'events',
    description: '',
    input: {},
    source: { path: '*.parquet', format: 'parquet' },
    replication: { method: 'full_refresh' },
    extract: {},
    output: {},
  };
}

describe('readFileRecords: UTC-adjusted Parquet timestamps', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'file-format-reader-utc-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])(
    'reads UTC-adjusted and plain timestamp columns as the same timestamp instants in a %s session',
    async (zone) => {
      const stagedPath = path.join(directory, 'events.parquet');
      const engine = await DuckDbEngine.create();
      try {
        await engine.queryAll(`SET TimeZone = 'UTC'`);
        await engine.queryAll(
          `COPY (SELECT 1::BIGINT AS id, TIMESTAMPTZ '2026-03-23 00:00:00+00' AS utc_at, TIMESTAMP '2026-03-23 00:00:00' AS naive_at, TIMESTAMPTZ '2026-07-04 12:30:45.25+00' AS later_utc_at) TO '${stagedPath}' (FORMAT PARQUET)`
        );
        await engine.queryAll(`SET TimeZone = '${zone}'`);

        const read = await readFileRecords(
          engine,
          {
            path: 'events.parquet',
            uri: 'file:///events.parquet',
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
          utc_at: { type: 'timestamp' },
          naive_at: { type: 'timestamp' },
          later_utc_at: { type: 'timestamp' },
        });
        expect(records).toEqual([
          {
            id: 1,
            utc_at: '2026-03-23T00:00:00.000Z',
            naive_at: '2026-03-23T00:00:00.000Z',
            later_utc_at: '2026-07-04T12:30:45.250Z',
          },
        ]);
      } finally {
        await engine.close();
      }
    }
  );
});
