import { DuckDBInstance } from '@duckdb/node-api';

export async function queryPersistentDb(
  dbPath: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();

  try {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}
