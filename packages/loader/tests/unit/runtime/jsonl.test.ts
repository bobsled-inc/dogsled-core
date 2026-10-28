import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readJsonlRecords } from '../../../src/runtime/jsonl.js';

vi.mock('node:fs', () => ({ createReadStream: vi.fn() }));

function mockFileChunks(chunks: string[]): void {
  vi.mocked(fs.createReadStream).mockImplementation(
    () => Readable.from(chunks) as ReturnType<typeof fs.createReadStream>
  );
}

async function collectRecords(filePath: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for await (const record of readJsonlRecords(filePath)) {
    records.push(record);
  }
  return records;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readJsonlRecords', () => {
  it('parses records across chunk boundaries and ignores blank lines', async () => {
    mockFileChunks(['{"id":1}\n{"id', '":2}\r\n\n', '{"id":3}']);

    await expect(collectRecords('/tmp/records.jsonl')).resolves.toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  });

  it('reports the source line for malformed JSON', async () => {
    mockFileChunks(['{"id":1}\n\nnot-json\n']);

    await expect(collectRecords('/tmp/records.jsonl')).rejects.toThrow(
      /Invalid JSON on JSONL line 3/
    );
  });

  it('rejects non-object JSON records', async () => {
    mockFileChunks(['[1, 2, 3]\n']);

    await expect(collectRecords('/tmp/records.jsonl')).rejects.toThrow(
      /Invalid JSON record on JSONL line 1: expected object/
    );
  });
});
