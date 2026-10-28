import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BatchWriter } from '../../src/runtime/batch-writer.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { Writable } from 'node:stream';

describe('BatchWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-writer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes raw JSON records to JSONL files (not RECORD envelopes)', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'none',
    });

    await writer.addRecord({ id: 1, name: 'alpha' });
    await writer.addRecord({ id: 2, name: 'beta' });
    const finalized = await writer.flush();

    expect(finalized).not.toBeNull();
    expect(finalized!.recordCount).toBe(2);
    expect(finalized!.encoding).toEqual({ format: 'jsonl' });

    const content = fs.readFileSync(finalized!.filePath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
    // Verify no RECORD envelope
    expect(lines[0]).not.toHaveProperty('type');
    expect(lines[0]).not.toHaveProperty('_v');
  });

  it('finalizes batch at maxRecords and returns FinalizedBatch', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 3,
      compression: 'none',
    });

    expect(await writer.addRecord({ id: 1 })).toBeNull();
    expect(await writer.addRecord({ id: 2 })).toBeNull();
    const finalized = await writer.addRecord({ id: 3 });

    expect(finalized).not.toBeNull();
    expect(finalized!.recordCount).toBe(3);
    expect(finalized!.filePath).toContain('items-0.jsonl');
  });

  it('flush returns null when empty', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'none',
    });

    expect(await writer.flush()).toBeNull();
  });

  it('flush finalizes partial batch', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 100,
      compression: 'none',
    });

    await writer.addRecord({ id: 1 });
    const finalized = await writer.flush();

    expect(finalized).not.toBeNull();
    expect(finalized!.recordCount).toBe(1);
  });

  it('produces valid gzip output', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'gzip',
    });

    await writer.addRecord({ id: 1, name: 'alpha' });
    await writer.addRecord({ id: 2, name: 'beta' });
    const finalized = await writer.flush();

    expect(finalized).not.toBeNull();
    expect(finalized!.encoding).toEqual({ format: 'jsonl', compression: 'gzip' });
    expect(finalized!.filePath.endsWith('.jsonl.gz')).toBe(true);

    const compressed = fs.readFileSync(finalized!.filePath);
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');
    const lines = decompressed
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('converts scratch JSONL into Parquet batches and deletes the scratch file', async () => {
    const scratchSnapshots: string[] = [];
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'none',
      format: 'parquet',
      columns: [{ name: 'id', type: 'integer' }],
      convertJsonlToParquet: async ({ sourcePath, outputPath }) => {
        scratchSnapshots.push(fs.readFileSync(sourcePath, 'utf-8'));
        fs.writeFileSync(outputPath, 'PARQUET');
      },
    });

    await writer.addRecord({ id: 1 });
    await writer.addRecord({ id: 2 });
    const finalized = await writer.flush();

    expect(finalized).not.toBeNull();
    expect(finalized!.encoding).toEqual({ format: 'parquet' });
    expect(finalized!.filePath.endsWith('.parquet')).toBe(true);
    expect(scratchSnapshots).toEqual(['{"id":1}\n{"id":2}\n']);
    expect(fs.existsSync(finalized!.filePath)).toBe(true);
    expect(fs.existsSync(finalized!.filePath.replace(/\.parquet$/, '.scratch.jsonl'))).toBe(false);
  });

  it('increments file index across multiple batches', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 2,
      compression: 'none',
    });

    await writer.addRecord({ id: 1 });
    const batch0 = await writer.addRecord({ id: 2 });
    await writer.addRecord({ id: 3 });
    const batch1 = await writer.addRecord({ id: 4 });

    expect(batch0).not.toBeNull();
    expect(batch1).not.toBeNull();
    expect(batch0!.filePath).toContain('items-0.jsonl');
    expect(batch1!.filePath).toContain('items-1.jsonl');
  });

  it('rejects path traversal in stream name', () => {
    expect(
      () =>
        new BatchWriter({
          batchDir: tmpDir,
          stream: '../escape',
          maxRecords: 10,
          compression: 'none',
        })
    ).toThrow('path traversal');
  });

  it('tracks byte size accurately', async () => {
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'none',
    });

    const record = { id: 1, name: 'test' };
    await writer.addRecord(record);
    const finalized = await writer.flush();

    const expectedLine = JSON.stringify(record) + '\n';
    expect(finalized!.byteSize).toBe(Buffer.byteLength(expectedLine, 'utf-8'));
  });

  it('uses DI createWriteStream for testing', async () => {
    const fakeStream = new FakeWritable();
    const writer = new BatchWriter({
      batchDir: tmpDir,
      stream: 'items',
      maxRecords: 10,
      compression: 'none',
      createWriteStream: () => fakeStream as unknown as Writable,
    });

    await writer.addRecord({ id: 1 });
    await writer.flush();

    expect(fakeStream.chunks).toHaveLength(1);
    expect(JSON.parse(fakeStream.chunks[0]!.trim())).toEqual({ id: 1 });
  });
});
