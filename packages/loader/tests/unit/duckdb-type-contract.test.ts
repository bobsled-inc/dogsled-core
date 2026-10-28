import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DuckDbDestination } from '../../src/runtime/destinations/duckdb.js';
import { queryPersistentDb } from '../helpers/duckdb.js';
import { writeJsonl } from '../helpers/jsonl.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

/**
 * Type-contract characterization tests for the DuckDB destination.
 *
 * These tests pin down the exact JS shape of every protocol ColumnType after a
 * round-trip through the loader and a raw readback via `queryPersistentDb`
 * (which uses the underlying duckdb driver's callback `conn.all()` directly —
 * no runtime normalization).
 *
 * They exist to de-risk the in-progress migration from `duckdb` (deprecated
 * node bindings) to `@duckdb/node-api`. The assertions below document the
 * current behavior on `duckdb@1.4.4`. After the migration, this suite either
 * stays green (migration is behavior-preserving) or fails with a precise diff
 * pointing at exactly which value needs normalization in the new primitives.
 */
describe('DuckDB destination — type contract', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-type-contract-'));
    dbPath = path.join(tempDir, 'test.duckdb');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function loadAndReadBack<T = Record<string, unknown>>(
    columns: SchemaColumn[],
    record: Record<string, unknown>,
    selectSql: string
  ): Promise<T[]> {
    const dest = new DuckDbDestination({ dbPath });
    await dest.initialize();
    await dest.ensureTable('main', 'vals', columns);

    const jsonlPath = path.join(tempDir, 'batch.jsonl');
    await writeJsonl(jsonlPath, [record]);

    await dest.loadAndFinalize('main', 'vals', jsonlPath, columns, 'append', []);
    await dest.close();

    return (await queryPersistentDb(dbPath, selectSql)) as T[];
  }

  describe('integer (→ BIGINT)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'integer' }];

    it('returns bigint for values within safe integer range', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: 42, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: BigInt(42) }]);
      expect(typeof rows[0]!['v']).toBe('bigint');
    });

    it('returns bigint at MAX_SAFE_INTEGER', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: Number.MAX_SAFE_INTEGER, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: BigInt(Number.MAX_SAFE_INTEGER) }]);
    });

    it('returns bigint for values beyond MAX_SAFE_INTEGER (via SQL literal)', async () => {
      const dest = new DuckDbDestination({ dbPath });
      await dest.initialize();
      await dest.ensureTable('main', 'vals', columns);
      await dest.close();

      // DuckDB BIGINT max is 9223372036854775807. Use a value above
      // Number.MAX_SAFE_INTEGER but below BIGINT max, inserted via SQL literal
      // so we sidestep JSON number-precision limits.
      const big = BigInt('9007199254740993'); // MAX_SAFE_INTEGER + 2

      const rows = await queryPersistentDb(dbPath, `SELECT ${big.toString()}::BIGINT AS v`);
      expect(rows).toEqual([{ v: big }]);
      expect(typeof rows[0]!['v']).toBe('bigint');
    });

    it('returns bigint for negative values', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: -12345, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: BigInt(-12345) }]);
    });

    it('returns null for NULL integer', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: null, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: null }]);
    });
  });

  describe('number (→ DOUBLE)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'number' }];

    it('returns JS number for decimals', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: 3.14159, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: 3.14159 }]);
      expect(typeof rows[0]!['v']).toBe('number');
    });

    it('returns JS number for large values', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: 1.7976931348623157e308, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows[0]!['v']).toBe(1.7976931348623157e308);
    });

    it('returns null for NULL number', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: null, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: null }]);
    });
  });

  describe('boolean (→ BOOLEAN)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'boolean' }];

    it('returns true as boolean', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: true, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: true }]);
      expect(typeof rows[0]!['v']).toBe('boolean');
    });

    it('returns false as boolean', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: false, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: false }]);
    });

    it('returns null for NULL boolean', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: null, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: null }]);
    });
  });

  describe('string (→ VARCHAR)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'string' }];

    it('returns ASCII string unchanged', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: 'hello', _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: 'hello' }]);
      expect(typeof rows[0]!['v']).toBe('string');
    });

    it('returns unicode string unchanged', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: 'héllo 🦆 世界', _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: 'héllo 🦆 世界' }]);
    });

    it('returns empty string as empty string (not null)', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: '', _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: '' }]);
    });

    it('returns null for NULL string', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: null, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: null }]);
    });
  });

  describe('timestamp (→ TIMESTAMP)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'timestamp' }];

    it('returns a JS Date for UTC ISO-8601 input (millisecond precision)', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: '2026-04-17T12:34:56.789Z', _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toHaveLength(1);
      const v = rows[0]!['v'];
      expect(v).toBeInstanceOf(Date);
      expect((v as Date).toISOString()).toBe('2026-04-17T12:34:56.789Z');
    });

    it('returns null for NULL timestamp', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: null, _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: null }]);
    });
  });

  describe('array (→ VARCHAR — stringified JSON)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'array' }];

    it('round-trips a pre-stringified JSON array as a VARCHAR string', async () => {
      const rows = await loadAndReadBack(
        columns,
        { v: '["a","b","c"]', _time_extracted: '2026-04-17T00:00:00Z' },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: '["a","b","c"]' }]);
      expect(typeof rows[0]!['v']).toBe('string');
    });
  });

  describe('object (→ VARCHAR — stringified JSON)', () => {
    const columns: SchemaColumn[] = [{ name: 'v', type: 'object' }];

    it('round-trips a pre-stringified JSON object as a VARCHAR string', async () => {
      const rows = await loadAndReadBack(
        columns,
        {
          v: '{"key":"val","n":1}',
          _time_extracted: '2026-04-17T00:00:00Z',
        },
        'SELECT v FROM main.vals'
      );
      expect(rows).toEqual([{ v: '{"key":"val","n":1}' }]);
      expect(typeof rows[0]!['v']).toBe('string');
    });
  });

  describe('aggregates', () => {
    it('COUNT(*) returns a bigint', async () => {
      const columns: SchemaColumn[] = [{ name: 'v', type: 'integer' }];
      const dest = new DuckDbDestination({ dbPath });
      await dest.initialize();
      await dest.ensureTable('main', 'vals', columns);

      const jsonlPath = path.join(tempDir, 'batch.jsonl');
      await writeJsonl(jsonlPath, [
        { v: 1, _time_extracted: '2026-04-17T00:00:00Z' },
        { v: 2, _time_extracted: '2026-04-17T00:00:01Z' },
        { v: 3, _time_extracted: '2026-04-17T00:00:02Z' },
      ]);
      await dest.loadAndFinalize('main', 'vals', jsonlPath, columns, 'append', []);
      await dest.close();

      const rows = await queryPersistentDb(dbPath, 'SELECT COUNT(*) AS c FROM main.vals');
      expect(rows).toEqual([{ c: BigInt(3) }]);
      expect(typeof rows[0]!['c']).toBe('bigint');
    });
  });
});
