import { describe, expect, it, vi } from 'vitest';
import { insertDuckDbPublicationRows } from '../../../src/agentic/duckdb-publisher.js';
import type { Db } from '../../../src/agentic/duckdb-publication-storage.js';
import type { AgenticColumn } from '../../../src/agentic/model.js';

describe('DuckDB publication batches', () => {
  const columns: AgenticColumn[] = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'detail', type: 'object', nullable: true },
  ];
  function database() {
    return { run: vi.fn<Db['run']>(), query: vi.fn<Db['query']>().mockResolvedValue([]) };
  }
  it('binds all values in order across row batches, including JSON and nulls', async () => {
    const db = database();
    const rows = Array.from({ length: 257 }, (_, id) => ({
      id,
      detail: id === 0 ? null : { text: "O'Brien; DROP TABLE target" },
    }));
    await insertDuckDbPublicationRows(db, '"stage"', columns, rows);
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls.map(([, params]) => params?.length)).toEqual([256, 256, 2]);
    expect(db.query.mock.calls.flatMap(([, params]) => params)).toEqual(
      rows.flatMap((row) => [row.id, row.detail === null ? null : JSON.stringify(row.detail)])
    );
    for (const [sql, params] of db.query.mock.calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql.match(/\?/g)).toHaveLength(params!.length);
    }
  });
  it('caps parameter count for wide schemas', async () => {
    const db = database();
    const wide: AgenticColumn[] = Array.from({ length: 256 }, (_, index) => ({
      name: `column_${index}`,
      type: 'integer',
      nullable: false,
    }));
    const row = Object.fromEntries(wide.map((column, index) => [column.name, index]));
    await insertDuckDbPublicationRows(
      db,
      '"stage"',
      wide,
      Array.from({ length: 33 }, () => row)
    );
    expect(db.query.mock.calls.map(([, params]) => params?.length)).toEqual([4096, 4096, 256]);
  });
  it('starts no next batch after cancellation and lets the owner roll back', async () => {
    const db = database();
    const controller = new AbortController();
    db.query.mockImplementation(async () => {
      controller.abort();
      return [];
    });
    await expect(
      insertDuckDbPublicationRows(
        db,
        '"stage"',
        columns,
        Array.from({ length: 129 }, (_, id) => ({ id, detail: null })),
        controller.signal
      )
    ).rejects.toThrow();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.run).not.toHaveBeenCalled();
  });
  it('propagates a failed batch without submitting remaining rows or committing', async () => {
    const db = database();
    db.query.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      insertDuckDbPublicationRows(
        db,
        '"stage"',
        columns,
        Array.from({ length: 129 }, (_, id) => ({ id, detail: null }))
      )
    ).rejects.toThrow('write failed');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.run).not.toHaveBeenCalled();
  });
  it('does not submit an insert for empty input', async () => {
    const db = database();
    await insertDuckDbPublicationRows(db, '"stage"', columns, []);
    expect(db.query).not.toHaveBeenCalled();
  });
});
