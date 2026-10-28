import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDuckDbWriter } from '../../src/runtime/duckdb-writer.js';
import { getFormatDef } from '../../src/runtime/formats.js';
import { readRowsFromFile, sortRowsByNumericField } from '../helpers/duckdb.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

const sourceRecords = [
  {
    id: 1,
    title: 'alpha',
    active: true,
    tags: ['a', 'b'],
    metadata: { plan: 'pro' },
    created_at: '2026-03-23T00:00:00.000Z',
  },
  {
    id: 2,
    title: 'beta',
    active: false,
    tags: ['c'],
    metadata: { plan: 'free' },
    created_at: '2026-03-24T00:00:00.000Z',
  },
];

const schemaColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
  { name: 'active', type: 'boolean' },
  { name: 'tags', type: 'array' },
  { name: 'metadata', type: 'object' },
  { name: 'created_at', type: 'timestamp' },
];

const expectedRows = [
  {
    id: 1,
    title: 'alpha',
    active: true,
    tags: '["a","b"]',
    metadata: '{"plan":"pro"}',
    created_at: '2026-03-23T00:00:00.000Z',
  },
  {
    id: 2,
    title: 'beta',
    active: false,
    tags: '["c"]',
    metadata: '{"plan":"free"}',
    created_at: '2026-03-24T00:00:00.000Z',
  },
];

async function writeJsonl(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `${sourceRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf-8'
  );
}

describe('DuckDbWriter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-writer-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(['jsonl', 'csv', 'parquet', 'arrow'] as const)(
    'converts JSONL into %s output',
    async (format) => {
      const sourcePath = path.join(tempDir, 'input.jsonl');
      const outputPath = path.join(tempDir, `output${getFormatDef(format).extension}`);
      await writeJsonl(sourcePath);

      const writer = await createDuckDbWriter();
      try {
        await writer.convertFile({
          sourcePath,
          outputPath,
          format,
          columns: schemaColumns,
        });
      } finally {
        await writer.close();
      }

      const rows = await readRowsFromFile(outputPath, format);
      expect(sortRowsByNumericField(rows, 'id')).toEqual(expectedRows);
    }
  );

  it('supports gzipped JSONL input', async () => {
    const sourcePath = path.join(tempDir, 'input.jsonl.gz');
    const outputPath = path.join(tempDir, 'output.csv');
    const payload = `${sourceRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await fs.writeFile(sourcePath, zlib.gzipSync(Buffer.from(payload, 'utf-8')));

    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({
        sourcePath,
        outputPath,
        format: 'csv',
        columns: schemaColumns,
      });
    } finally {
      await writer.close();
    }

    const rows = await readRowsFromFile(outputPath, 'csv');
    expect(sortRowsByNumericField(rows, 'id')).toEqual(expectedRows);
  });

  it('encodes vector columns with mixed null/populated rows as Parquet LIST (no over-materialization)', async () => {
    // Regression: with the prior `FLOAT[N]` (fixed-size ARRAY) mapping,
    // DuckDB's Parquet writer materialized N element slots for every NULL row
    // (def=0, rep=1), which BigQuery's strict reader rejects under
    // `parquetOptions.enableListInference`. The current `FLOAT[]` (LIST)
    // mapping encodes each NULL row as a single def-level marker instead.
    const dim = 4;
    const populated = [
      { id: 1, body_embedding: [0.1, 0.2, 0.3, 0.4] },
      { id: 2, body_embedding: null },
      { id: 3, body_embedding: [0.5, 0.6, 0.7, 0.8] },
      { id: 4, body_embedding: null },
      { id: 5, body_embedding: [0.9, 1.0, 1.1, 1.2] },
    ];
    const sourcePath = path.join(tempDir, 'input.jsonl');
    const outputPath = path.join(tempDir, 'output.parquet');
    await fs.writeFile(sourcePath, populated.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({
        sourcePath,
        outputPath,
        format: 'parquet',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'body_embedding', type: 'vector', dimension: dim },
        ],
      });
    } finally {
      await writer.close();
    }

    // Use DuckDB directly to inspect the on-disk Parquet column-chunk metadata.
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();

    try {
      const escapedPath = outputPath.replaceAll("'", "''");
      const metadataReader = await conn.runAndReadAll(
        `SELECT path_in_schema, num_values FROM parquet_metadata('${escapedPath}') WHERE path_in_schema LIKE '%element%'`
      );
      const metadataRows = metadataReader.getRowObjectsJS() as Array<{
        path_in_schema: string;
        num_values: bigint;
      }>;
      expect(metadataRows).toHaveLength(1);
      const populatedCount = populated.filter((r) => r.body_embedding !== null).length;
      const nullCount = populated.length - populatedCount;
      // LIST encoding: populated_rows × dim element values + 1 def-level marker per null row.
      expect(Number(metadataRows[0]!.num_values)).toBe(populatedCount * dim + nullCount);

      // Round-trip values to confirm DuckDB still reads them correctly.
      const dataReader = await conn.runAndReadAll(
        `SELECT id, body_embedding FROM read_parquet('${escapedPath}') ORDER BY id`
      );
      const dataRows = dataReader.getRowObjectsJS() as Array<{
        id: bigint;
        body_embedding: number[] | null;
      }>;
      expect(dataRows).toHaveLength(populated.length);
      for (const [index, source] of populated.entries()) {
        const round = dataRows[index]!;
        expect(Number(round.id)).toBe(source.id);
        if (source.body_embedding === null) {
          expect(round.body_embedding).toBeNull();
        } else {
          expect(round.body_embedding).toEqual(
            source.body_embedding.map((v) => expect.closeTo(v, 5))
          );
        }
      }
    } finally {
      // Avoid leaking handles in vitest teardown.
      conn.disconnectSync();
      instance.closeSync();
    }
  });

  it('supports parquet input when sourceEncoding is parquet', async () => {
    const jsonlPath = path.join(tempDir, 'input.jsonl');
    const parquetPath = path.join(tempDir, 'input.parquet');
    const outputPath = path.join(tempDir, 'output.jsonl');
    await writeJsonl(jsonlPath);

    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({
        sourcePath: jsonlPath,
        outputPath: parquetPath,
        format: 'parquet',
        columns: schemaColumns,
      });
      await writer.convertFile({
        sourcePath: parquetPath,
        outputPath,
        format: 'jsonl',
        sourceEncoding: { format: 'parquet' },
      });
    } finally {
      await writer.close();
    }

    const rows = await readRowsFromFile(outputPath, 'jsonl');
    expect(sortRowsByNumericField(rows, 'id')).toEqual(expectedRows);
  });
});
