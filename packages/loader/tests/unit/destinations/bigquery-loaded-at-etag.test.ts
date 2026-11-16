import { describe, expect, it, vi } from 'vitest';

import { BigQueryDestination } from '../../../src/runtime/destinations/bigquery.js';
import type {
  BigQueryClientLike,
  BigQueryDatasetLike,
  BigQueryTableLike,
} from '../../../src/runtime/destinations/bigquery.js';

// Generic test: an earlier loaded-at name stands in, so it passes before and after the rename.
vi.mock('../../../src/runtime/legacy-names.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LEGACY_LOADED_AT_COLUMNS: ['_legacy_loaded_at'],
}));

describe('BigQuery loaded-at takeover and table metadata', () => {
  it('updates clustering with metadata read after the takeover renamed the column', async () => {
    const fields = (loadedAt: string) => [
      { name: 'id', type: 'INT64' },
      { name: 'title', type: 'STRING' },
      { name: '_time_extracted', type: 'TIMESTAMP' },
      { name: loadedAt, type: 'TIMESTAMP' },
    ];
    let etag = 'before-rename';
    let loadedAt = '_legacy_loaded_at';
    const table: BigQueryTableLike = {
      exists: vi.fn().mockResolvedValue([true]),
      load: vi.fn().mockResolvedValue([{ status: {} }]),
      getMetadata: vi.fn(async () => [{ schema: { fields: fields(loadedAt) }, etag }]),
      setMetadata: vi.fn(async (metadata: Record<string, unknown>) => {
        if (metadata['etag'] !== etag) throw new Error('Precondition check failed.');
      }),
    };
    const job = { getQueryResults: vi.fn().mockResolvedValue([[]]) };
    const createQueryJob = vi.fn(async ({ query }: { query: string }) => {
      if (query.includes('RENAME COLUMN')) {
        loadedAt = query.match(/RENAME COLUMN `[^`]+` TO `([^`]+)`/)![1]!;
        etag = 'after-rename';
      }
      return [job];
    });
    const dataset: BigQueryDatasetLike = {
      exists: vi.fn().mockResolvedValue([true]),
      create: vi.fn(),
      table: vi.fn(() => table),
      createQueryJob,
    };
    const client: BigQueryClientLike = { dataset: vi.fn(() => dataset), createQueryJob };
    const dest = new BigQueryDestination({ datasetId: 'ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();

    await dest.ensureTable(
      'ds',
      'accounts',
      [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'title', type: 'string' },
      ],
      { keyProperties: ['id'] }
    );

    expect(etag).toBe('after-rename');
    expect(table.setMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ etag: 'after-rename', clustering: { fields: ['id'] } })
    );
  });

  function destinationWith(fields: Array<{ name: string; type: string; description?: string }>) {
    const table: BigQueryTableLike = {
      exists: vi.fn().mockResolvedValue([true]),
      load: vi.fn().mockResolvedValue([{ status: {} }]),
      getMetadata: vi.fn(async () => [{ schema: { fields } }]),
      setMetadata: vi.fn().mockResolvedValue(undefined),
    };
    const job = { getQueryResults: vi.fn().mockResolvedValue([[]]) };
    const queries: string[] = [];
    const createQueryJob = vi.fn(async ({ query }: { query: string }) => {
      queries.push(query);
      // A table with a search index or row access policy refuses the rename.
      if (query.includes('RENAME COLUMN')) throw new Error('Cannot rename column on this table');
      return [job];
    });
    const dataset: BigQueryDatasetLike = {
      exists: vi.fn().mockResolvedValue([true]),
      create: vi.fn(),
      table: vi.fn(() => table),
      createQueryJob,
    };
    const client: BigQueryClientLike = { dataset: vi.fn(() => dataset), createQueryJob };
    const dest = new BigQueryDestination({ datasetId: 'ds', client, stagingFormat: 'jsonl' });
    return { dest, queries };
  }

  it('adds the current column, copies into it, then marks the copy when the rename is refused', async () => {
    const { dest, queries } = destinationWith([
      { name: 'id', type: 'INT64' },
      { name: '_time_extracted', type: 'TIMESTAMP' },
      { name: '_legacy_loaded_at', type: 'TIMESTAMP' },
    ]);
    await dest.initialize();

    await dest.ensureTable('ds', 'accounts', [{ name: 'id', type: 'integer', primary_key: true }]);

    expect(queries).toEqual([
      'ALTER TABLE `ds`.`accounts` RENAME COLUMN `_legacy_loaded_at` TO `_bobsled_loaded_at`',
      'ALTER TABLE `ds`.`accounts` ADD COLUMN `_bobsled_loaded_at` TIMESTAMP',
      'UPDATE `ds`.`accounts` SET `_bobsled_loaded_at` = `_legacy_loaded_at` ' +
        'WHERE `_bobsled_loaded_at` IS NULL AND `_legacy_loaded_at` IS NOT NULL',
      'ALTER TABLE `ds`.`accounts` ALTER COLUMN `_legacy_loaded_at` ' +
        "SET OPTIONS (description = 'Core copied this column into _bobsled_loaded_at')",
    ]);
  });

  it('fails a widening BigQuery rejects before the takeover renames anything', async () => {
    const { dest, queries } = destinationWith([
      { name: 'id', type: 'INT64' },
      { name: 'code', type: 'INT64' },
      { name: '_time_extracted', type: 'TIMESTAMP' },
      { name: '_legacy_loaded_at', type: 'TIMESTAMP' },
    ]);
    await dest.initialize();

    await expect(
      dest.ensureTable('ds', 'accounts', [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'code', type: 'string' },
      ])
    ).rejects.toThrow('BigQuery cannot change existing type INT64 to STRING');
    expect(queries).toEqual([]);
  });
});
