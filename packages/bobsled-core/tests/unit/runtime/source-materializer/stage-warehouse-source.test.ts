import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stageWarehouseSourceIntoDuckDb } from '../../../../src/runtime/source-materializer/stage-warehouse-source.js';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { DatabaseDestination } from '@bobsled-inc/loader';
import type { SourceRegistryEntry } from '@bobsled-inc/model-spec';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-wh-'));
});
afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('stageWarehouseSourceIntoDuckDb', () => {
  it('preserves BIGINT precision through the JSONL hop (no Number() narrowing)', async () => {
    // Above 2^53 - 1, so JS `Number()` would corrupt it (…992 instead of …993).
    const bigId = 9007199254740993n;

    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: bigId, name: 'acme' }]),
      close: vi.fn(),
    };

    // Capture the JSONL file the loader is asked to read so we can inspect the
    // serialized BIGINT without touching a real database.
    let stagedJsonl = '';
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(async (_schema, _table, filePath: string) => {
        stagedJsonl = await fs.readFile(filePath, 'utf8');
        return { rowsAffected: 1 };
      }),
    } as unknown as DatabaseDestination;

    const entry = {
      kind: 'warehouse_table',
      fqRef: 'main.accounts',
      connection: 'crm',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'string' },
      ],
    } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

    const result = await stageWarehouseSourceIntoDuckDb({
      entry,
      sourceName: 'accounts',
      schema: 'sources',
      database,
      sourceRunner,
      dialect: 'duckdb',
      tempDir: tmpDir,
    });

    expect(result.rowsAffected).toBe(1);
    // The full-precision value survives as a string; it must NOT be the lossy
    // Number() form (9007199254740992).
    expect(stagedJsonl).toContain('9007199254740993');
    expect(stagedJsonl).not.toContain('9007199254740992');
  });

  const wideEntry = {
    kind: 'warehouse_table',
    fqRef: 'main.accounts',
    connection: 'crm',
    columns: [{ name: 'id', type: 'integer' }],
  } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

  it('bounds the read with LIMIT maxRows+1 and aborts when the leaf exceeds the ceiling', async () => {
    // The runner returns 3 rows for a ceiling of 2 (the brick asked for LIMIT 3).
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: 1n }, { id: 2n }, { id: 3n }]),
      close: vi.fn(),
    };
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(),
    } as unknown as DatabaseDestination;

    await expect(
      stageWarehouseSourceIntoDuckDb({
        entry: wideEntry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        sourceRunner,
        dialect: 'duckdb',
        tempDir: tmpDir,
        maxRows: 2,
      })
    ).rejects.toThrow(/exceeds the staging row ceiling of 2 rows/);

    // The read was bounded (LIMIT 3) and nothing was written — abort before the
    // in-memory buffer / JSONL hop.
    expect(sourceRunner.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 3'));
    expect(database.loadAndFinalize).not.toHaveBeenCalled();
  });

  it('stages normally when the row count is within the ceiling', async () => {
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: 1n }, { id: 2n }]),
      close: vi.fn(),
    };
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(async () => ({ rowsAffected: 2 })),
    } as unknown as DatabaseDestination;

    const result = await stageWarehouseSourceIntoDuckDb({
      entry: wideEntry,
      sourceName: 'accounts',
      schema: 'sources',
      database,
      sourceRunner,
      dialect: 'duckdb',
      tempDir: tmpDir,
      maxRows: 5,
    });

    expect(result.rowsAffected).toBe(2);
    expect(sourceRunner.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 6'));
    expect(database.loadAndFinalize).toHaveBeenCalledTimes(1);
  });

  it('rejects a negative or non-integer ceiling', async () => {
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn(),
      close: vi.fn(),
    };
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(),
    } as unknown as DatabaseDestination;

    await expect(
      stageWarehouseSourceIntoDuckDb({
        entry: wideEntry,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        sourceRunner,
        dialect: 'duckdb',
        tempDir: tmpDir,
        maxRows: -1,
      })
    ).rejects.toThrow(/must be a non-negative integer/);
    expect(sourceRunner.query).not.toHaveBeenCalled();
  });

  it('rejects a fqRef that is not a plain dotted identifier path (SQL injection guard)', async () => {
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn(),
      close: vi.fn(),
    };
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(),
    } as unknown as DatabaseDestination;

    const injected = {
      kind: 'warehouse_table',
      fqRef: 'accounts; DROP TABLE users; --',
      connection: 'crm',
      columns: [{ name: 'id', type: 'integer' }],
    } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

    await expect(
      stageWarehouseSourceIntoDuckDb({
        entry: injected,
        sourceName: 'accounts',
        schema: 'sources',
        database,
        sourceRunner,
        dialect: 'duckdb',
        tempDir: tmpDir,
      })
    ).rejects.toThrow(/Unsafe warehouse table reference/);
    expect(sourceRunner.query).not.toHaveBeenCalled();
  });

  it('accepts a multi-segment, hyphenated fqRef (e.g. a BigQuery project ref)', async () => {
    const sourceRunner: SqlRunnerModule = {
      run: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: 1n }]),
      close: vi.fn(),
    };
    const database = {
      ensureTable: vi.fn(),
      loadAndFinalize: vi.fn(async () => ({ rowsAffected: 1 })),
    } as unknown as DatabaseDestination;

    const bqEntry = {
      kind: 'warehouse_table',
      fqRef: 'my-project.analytics.accounts',
      connection: 'bq',
      columns: [{ name: 'id', type: 'integer' }],
    } as unknown as Extract<SourceRegistryEntry, { kind: 'warehouse_table' }>;

    const result = await stageWarehouseSourceIntoDuckDb({
      entry: bqEntry,
      sourceName: 'accounts',
      schema: 'sources',
      database,
      sourceRunner,
      dialect: 'bigquery',
      tempDir: tmpDir,
    });

    expect(result.rowsAffected).toBe(1);
    expect(sourceRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM my-project.analytics.accounts')
    );
  });
});
