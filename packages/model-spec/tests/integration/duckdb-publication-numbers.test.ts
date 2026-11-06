import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { dbFor } from '../../src/agentic/duckdb-publication-storage.js';
import { insertDuckDbPublicationRows } from '../../src/agentic/duckdb-publisher.js';

const duckdbAvailable = await (async () => {
  try {
    await import('@duckdb/node-api');
    return true;
  } catch {
    return false;
  }
})();

it.skipIf(!duckdbAvailable)(
  'publishes whole numbers outside the 32-bit range unchanged',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'publication-numbers-'));
    const runner = await buildDuckDbRunner({
      spec_version: '1',
      type: 'integration',
      name: 'target',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'file', path: join(directory, 'target.duckdb'), read_only: false },
    });
    try {
      await runner.run('CREATE TABLE published (quantity BIGINT, amount DOUBLE)');
      await insertDuckDbPublicationRows(
        dbFor(runner),
        'published',
        [
          { name: 'quantity', type: 'integer', nullable: false },
          { name: 'amount', type: 'number', nullable: false },
        ],
        [{ quantity: 3_000_000_000, amount: 5_000_000_000 }]
      );
      expect(await runner.query!('SELECT * FROM published')).toEqual([
        { quantity: 3_000_000_000n, amount: 5_000_000_000 },
      ]);
    } finally {
      await runner.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
