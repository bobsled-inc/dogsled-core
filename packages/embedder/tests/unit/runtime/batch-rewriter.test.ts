import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { rewriteBatch } from '../../../src/runtime/batch-rewriter.js';

import type { BatchMessage } from '@bobsled-inc/protocol';

const tempDirs: string[] = [];
const target = { model: 'text-embedding-3-small', dimensions: 1 };

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'embedder-batch-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonlFile(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('rewriteBatch', () => {
  it('rewrites JSONL manifests with embedding values', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [
      { id: 1, body: 'alpha' },
      { id: 2, body: 'beta' },
    ]);
    const message: BatchMessage = {
      _v: 1,
      type: 'BATCH',
      stream: 'docs',
      encoding: { format: 'jsonl' },
      manifest: [pathToFileURL(inputPath).href],
    };

    const result = await rewriteBatch({
      message,
      fields: [{ field: 'body' }],
      batchSize: 100,
      ...target,
      embedFn: vi.fn(async (texts: string[]) => ({
        vectors: texts.map((_text, index) => [index * 0.1]),
        tokensUsed: texts.length * 5,
      })),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    const rewrittenPath = new URL(result.manifest[0]!).pathname;
    const rewrittenRecords = readFileSync(rewrittenPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rewrittenRecords).toEqual([
      { id: 1, body: 'alpha', body_embedding: [0] },
      { id: 2, body: 'beta', body_embedding: [0.1] },
    ]);
  });

  it('preserves JSONL+gzip encoding', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl.gz');
    writeFileSync(
      inputPath,
      gzipSync(
        `${JSON.stringify({ id: 1, body: 'hello' })}\n${JSON.stringify({ id: 2, body: 'world' })}\n`
      )
    );
    const message: BatchMessage = {
      _v: 1,
      type: 'BATCH',
      stream: 'docs',
      encoding: { format: 'jsonl', compression: 'gzip' },
      manifest: [pathToFileURL(inputPath).href],
    };

    const result = await rewriteBatch({
      message,
      fields: [{ field: 'body', as: 'embedding' }],
      batchSize: 100,
      ...target,
      embedFn: async (texts: string[]) => ({
        vectors: texts.map(() => [0.5]),
        tokensUsed: 0,
      }),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    const rewrittenPath = new URL(result.manifest[0]!).pathname;
    const records = gunzipSync(readFileSync(rewrittenPath))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ id: 1, body: 'hello', embedding: [0.5] });
    expect(records[1]).toEqual({ id: 2, body: 'world', embedding: [0.5] });
  });

  it('rejects Parquet with actionable guidance', async () => {
    const message: BatchMessage = {
      _v: 1,
      type: 'BATCH',
      stream: 'docs',
      encoding: { format: 'parquet' },
      manifest: ['file:///tmp/docs.parquet'],
    };

    await expect(
      rewriteBatch({
        message,
        fields: [{ field: 'body' }],
        batchSize: 100,
        ...target,
        embedFn: async () => ({ vectors: [], tokensUsed: 0 }),
        onTruncation: () => {},
        onApiCall: () => {},
        onRecord: () => {},
      })
    ).rejects.toThrow(/Parquet BATCH encoding is not yet supported/);
  });

  it('rejects batches when a single record exceeds the configured batch size', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [{ id: 1, title: 'alpha', body: 'beta' }]);
    const embedFn = vi.fn(async () => ({
      vectors: [],
      tokensUsed: 0,
    }));

    await expect(
      rewriteBatch({
        message: {
          _v: 1,
          type: 'BATCH',
          stream: 'docs',
          encoding: { format: 'jsonl' },
          manifest: [pathToFileURL(inputPath).href],
        },
        fields: [{ field: 'title' }, { field: 'body' }],
        batchSize: 1,
        ...target,
        embedFn,
        tmpDir: dir,
        onTruncation: () => {},
        onApiCall: () => {},
        onRecord: () => {},
      })
    ).rejects.toThrow(/batch-size 1 is too small/i);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('uses unique rewritten filenames across separate rewrites for the same stream', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [{ id: 1, body: 'alpha' }]);
    const message: BatchMessage = {
      _v: 1,
      type: 'BATCH',
      stream: 'docs',
      encoding: { format: 'jsonl' },
      manifest: [pathToFileURL(inputPath).href],
    };
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_717_171_717_171);

    const first = await rewriteBatch({
      message,
      fields: [{ field: 'body' }],
      batchSize: 100,
      ...target,
      embedFn: async () => ({
        vectors: [[0.1]],
        tokensUsed: 0,
      }),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    const second = await rewriteBatch({
      message,
      fields: [{ field: 'body' }],
      batchSize: 100,
      ...target,
      embedFn: async () => ({
        vectors: [[0.9]],
        tokensUsed: 0,
      }),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    dateNow.mockRestore();

    const firstPath = new URL(first.manifest[0]!).pathname;
    const secondPath = new URL(second.manifest[0]!).pathname;

    expect(firstPath).not.toBe(secondPath);
    expect(readFileSync(firstPath, 'utf8')).toContain('"body_embedding":[0.1]');
    expect(readFileSync(secondPath, 'utf8')).toContain('"body_embedding":[0.9]');
  });

  it('sanitizes stream names before using them as filesystem path segments', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [{ id: 1, body: 'alpha' }]);

    const result = await rewriteBatch({
      message: {
        _v: 1,
        type: 'BATCH',
        stream: '../docs/..\\\\nested',
        encoding: { format: 'jsonl' },
        manifest: [pathToFileURL(inputPath).href],
      },
      fields: [{ field: 'body' }],
      batchSize: 100,
      ...target,
      embedFn: async () => ({
        vectors: [[0.1]],
        tokensUsed: 0,
      }),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    const rewrittenPath = new URL(result.manifest[0]!).pathname;
    expect(rewrittenPath.startsWith(dir)).toBe(true);
    expect(path.basename(path.dirname(rewrittenPath))).toBe('docs_nested');
  });

  it('flushes pending records when a sparse record has no embedding requests', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [
      { id: 1, body: 'alpha' },
      { id: 2, body: '' },
      { id: 3, body: 'beta' },
    ]);
    const embedFn = vi.fn(async (texts: string[]) => ({
      vectors: texts.map((text) => [text.length]),
      tokensUsed: texts.length,
    }));

    const result = await rewriteBatch({
      message: {
        _v: 1,
        type: 'BATCH',
        stream: 'docs',
        encoding: { format: 'jsonl' },
        manifest: [pathToFileURL(inputPath).href],
      },
      fields: [{ field: 'body' }],
      batchSize: 100,
      ...target,
      embedFn,
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });

    expect(embedFn).toHaveBeenCalledTimes(2);
    expect(embedFn).toHaveBeenNthCalledWith(1, ['alpha']);
    expect(embedFn).toHaveBeenNthCalledWith(2, ['beta']);

    const rewrittenPath = new URL(result.manifest[0]!).pathname;
    const rewrittenRecords = readFileSync(rewrittenPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rewrittenRecords).toEqual([
      { id: 1, body: 'alpha', body_embedding: [5] },
      { id: 2, body: '', body_embedding: null },
      { id: 3, body: 'beta', body_embedding: [4] },
    ]);
  });
});

describe('vectors that do not fit the column', () => {
  it.each([
    [[[1, 2]], 'returned a vector of 2 numbers for stream "docs", expected 3.'],
    [[[1, 2, NaN]], 'a value that is not a finite number for stream "docs".'],
    [[[1, 2, 3], [4]], 'Expected 1 embeddings for stream "docs", received 2'],
  ])('refuses %j in a BATCH', async (vectors, message) => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [{ id: 1, body: 'quiet kennel' }]);
    const rewritten = rewriteBatch({
      message: {
        _v: 1,
        type: 'BATCH',
        stream: 'docs',
        encoding: { format: 'jsonl' },
        manifest: [pathToFileURL(inputPath).href],
      },
      fields: [{ field: 'body' }],
      batchSize: 100,
      model: 'text-embedding-3-small',
      dimensions: 3,
      embedFn: async () => ({ vectors, tokensUsed: 0 }),
      tmpDir: dir,
      onTruncation: () => {},
      onApiCall: () => {},
      onRecord: () => {},
    });
    await expect(rewritten).rejects.toThrow(message);
    await expect(rewritten).rejects.not.toThrow('quiet kennel');
  });

  it('writes null where the provider refused a text, and reports what it cut', async () => {
    const dir = createTempDir();
    const inputPath = path.join(dir, 'docs-0.jsonl');
    writeJsonlFile(inputPath, [
      { id: 1, body: 'alpha' },
      { id: 2, body: 'be' },
    ]);
    const onTruncation = vi.fn();
    const result = await rewriteBatch({
      message: {
        _v: 1,
        type: 'BATCH',
        stream: 'docs',
        encoding: { format: 'jsonl' },
        manifest: [pathToFileURL(inputPath).href],
      },
      fields: [{ field: 'body' }],
      batchSize: 100,
      model: 'acme-embed-1',
      dimensions: 1,
      hostText: { maxCharacters: 3 },
      embedFn: async (texts) => ({
        vectors: texts.map((text) => (text === 'be' ? null : [text.length])),
        tokensUsed: 0,
        rejections: new Map([['too_short', 1]]),
      }),
      tmpDir: dir,
      onTruncation,
      onApiCall: () => {},
      onRecord: () => {},
    });
    const rows = readFileSync(new URL(result.manifest[0]!).pathname, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toEqual([
      { id: 1, body: 'alpha', body_embedding: [3] },
      { id: 2, body: 'be', body_embedding: null },
    ]);
    expect(onTruncation.mock.calls).toEqual([
      ['docs', 'body', { unit: 'characters', limit: 3, originalLength: 5 }],
    ]);
  });
});

describe('a BATCH file that is not JSON', () => {
  it.each(['quiet kennel', '{"id":2,"body":"quiet kennel"', '{"body":"quiet kennel"} trailing'])(
    'is reported by stream and line, without the line: %j',
    async (line) => {
      const dir = createTempDir();
      const inputPath = path.join(dir, 'docs-0.jsonl');
      writeFileSync(inputPath, `${JSON.stringify({ id: 1, body: 'first' })}\n\n${line}\n`);
      const rewritten = rewriteBatch({
        message: {
          _v: 1,
          type: 'BATCH',
          stream: 'docs',
          encoding: { format: 'jsonl' },
          manifest: [pathToFileURL(inputPath).href],
        },
        fields: [{ field: 'body' }],
        batchSize: 100,
        ...target,
        embedFn: async (texts) => ({ vectors: texts.map(() => [0]), tokensUsed: 0 }),
        tmpDir: dir,
        onTruncation: () => {},
        onApiCall: () => {},
        onRecord: () => {},
      });
      const error = await rewritten.catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({
        message: 'Line 3 of a BATCH file for stream "docs" is not valid JSON.',
        exitCode: 1,
      });
      expect((error as Error).cause).toBeUndefined();
    }
  );
});
