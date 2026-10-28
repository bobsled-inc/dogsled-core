import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, jsonLine } from '../../src/output.js';

describe('JSON output of warehouse values', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes bigint values as strings instead of throwing', () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });

    json({ rows: [{ id: 42n }] });
    jsonLine({ id: 7n });

    expect(JSON.parse(chunks[0]!)).toEqual({ rows: [{ id: '42' }] });
    expect(JSON.parse(chunks[1]!)).toEqual({ id: '7' });
  });
});
