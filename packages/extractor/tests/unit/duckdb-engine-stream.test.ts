import { describe, expect, it } from 'vitest';

import { DuckDbEngine } from '../../src/runtime/duckdb-engine.js';

describe('DuckDbEngine.query', () => {
  it('streams bounded batches without materializing the complete result', async () => {
    const engine = await DuckDbEngine.create();
    try {
      const batches: Record<string, unknown>[][] = [];
      for await (const batch of engine.query(
        "SELECT i, CASE WHEN i % 2 = 0 THEN NULL ELSE '' END AS value FROM range(25001) AS rows(i)"
      )) {
        batches.push(batch);
      }

      expect(batches.map((batch) => batch.length)).toEqual([10_000, 10_000, 5_001]);
      expect(batches[0]?.[0]).toEqual({ i: 0n, value: null });
      expect(batches.at(-1)?.at(-1)).toEqual({ i: 25_000n, value: null });
    } finally {
      await engine.close();
    }
  });

  it('interrupts an active stream and preserves the abort reason', async () => {
    const engine = await DuckDbEngine.create();
    const controller = new AbortController();
    const reason = new Error('stop file extraction');
    let rowsSeen = 0;

    try {
      await expect(
        (async () => {
          for await (const batch of engine.query(
            'SELECT * FROM range(100000000)',
            controller.signal
          )) {
            rowsSeen += batch.length;
            controller.abort(reason);
          }
        })()
      ).rejects.toBe(reason);

      expect(rowsSeen).toBe(10_000);
      await expect(engine.queryAll('SELECT 1 AS still_usable')).resolves.toEqual([
        { still_usable: 1 },
      ]);
    } finally {
      await engine.close();
    }
  });
});
