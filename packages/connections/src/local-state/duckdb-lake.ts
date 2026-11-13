import type { LakeDataPathStore } from './local-state-dir.js';

interface DuckDbConnection {
  run(sql: string, values?: unknown[]): Promise<unknown>;
  runAndReadAll(
    sql: string,
    values?: unknown[]
  ): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }>;
  closeSync?(): void;
}
interface DuckDbDriver {
  DuckDBInstance: {
    create(path: string): Promise<{ connect(): Promise<DuckDbConnection>; closeSync?(): void }>;
  };
}

/**
 * A DuckLake catalog file is a DuckDB database whose `ducklake_metadata` table stores the
 * catalog's data path. Opened directly, without the DuckLake extension, it is read and edited
 * like any table.
 */
export function duckDbLakeDataPathStore(): LakeDataPathStore {
  const open = async <T>(catalog: string, action: (c: DuckDbConnection) => Promise<T>) => {
    const driver = (await import('@duckdb/node-api')) as unknown as DuckDbDriver;
    const instance = await driver.DuckDBInstance.create(catalog);
    const connection = await instance.connect();
    try {
      return await action(connection);
    } finally {
      connection.closeSync?.();
      instance.closeSync?.();
    }
  };
  return {
    read: (catalog) =>
      open(catalog, async (c) => {
        const rows = (
          await c.runAndReadAll(
            "SELECT value FROM ducklake_metadata WHERE key = 'data_path' AND scope IS NULL"
          )
        ).getRowObjectsJson();
        return rows.length === 1 ? String(rows[0]!['value']) : undefined;
      }),
    write: (catalog, value) =>
      open(catalog, async (c) => {
        await c.run(
          "UPDATE ducklake_metadata SET value = $1 WHERE key = 'data_path' AND scope IS NULL",
          [value]
        );
      }),
  };
}
