import { describe, expect, it, vi } from 'vitest';

import {
  PgCompatibleWarehouseClient,
  parsePgCompatibleConfig,
  type PgCompatibleConfig,
} from '../../src/runtime/pg-base-client.js';

import type { ColumnDiscovery, TableDiscovery } from '../../src/runtime/warehouse-client.js';

type QueryCall =
  | string
  | {
      text: string;
      values?: unknown[];
      rowMode?: string;
    };

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

class TestPgClient extends PgCompatibleWarehouseClient {
  readonly dialect = 'postgres' as const;

  async testConnection(): Promise<void> {}

  async introspect(): Promise<TableDiscovery[]> {
    return [];
  }

  mapColumnType(_column: ColumnDiscovery): import('@bobsled-inc/protocol').ColumnType {
    return 'string';
  }
}

function createClient(
  queryImpl: (query: QueryCall, values?: unknown[]) => Promise<unknown>,
  configOverrides: Partial<PgCompatibleConfig> = {}
) {
  const client: MockClient = {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
    on: vi.fn(),
  };

  const warehouseClient = new TestPgClient(
    {
      host: 'localhost',
      port: 5432,
      database: 'analytics',
      schema: 'public',
      auth: {
        type: 'password',
        username: 'user',
        password: 'password',
      },
      ...configOverrides,
    },
    'test postgres'
  );

  (
    warehouseClient as unknown as {
      pool: typeof pool;
    }
  ).pool = pool;

  return { client, warehouseClient };
}

describe('PgCompatibleWarehouseClient.execute', () => {
  it('rolls back and closes the cursor when iteration stops early', async () => {
    const fetchBatches = [[{ id: 1 }], [{ id: 2 }], []] as Array<Record<string, unknown>[]>;
    const { client, warehouseClient } = createClient(async (query) => {
      if (typeof query === 'string' && query.startsWith('FETCH ')) {
        return { rows: fetchBatches.shift() ?? [] };
      }

      return { rows: [], rowCount: 0, fields: [] };
    });

    const iterator = warehouseClient.execute('SELECT * FROM customers');
    const firstBatch = await iterator.next();

    expect(firstBatch.value).toEqual([{ id: 1 }]);

    await iterator.return(undefined);

    expect(client.query).toHaveBeenCalledWith('CLOSE _bobsled_cursor');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('commits after fully consuming the cursor', async () => {
    const fetchBatches = [[{ id: 1 }], []] as Array<Record<string, unknown>[]>;
    const { client, warehouseClient } = createClient(async (query) => {
      if (typeof query === 'string' && query.startsWith('FETCH ')) {
        return { rows: fetchBatches.shift() ?? [] };
      }

      return { rows: [], rowCount: 0, fields: [] };
    });

    const batches: Record<string, unknown>[][] = [];
    for await (const batch of warehouseClient.execute('SELECT * FROM customers')) {
      batches.push(batch);
    }

    expect(batches).toEqual([[{ id: 1 }]]);
    expect(client.query).toHaveBeenCalledWith('CLOSE _bobsled_cursor');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('parsePgCompatibleConfig', () => {
  // The YAML/Zod connection schema marks `schema` as optional (it's a
  // "default" for unqualified table names, not a required selector). The
  // runtime parser used to require it anyway, so a valid YAML would pass
  // `dogsled extract validate` and then crash on first connect. Cover both
  // sides of the contract explicitly.
  const baseRawConfig = {
    host: 'db.example.com',
    port: 5432,
    database: 'analytics',
    auth: { type: 'password', username: 'u', password: 'p' },
  };

  it('accepts a config without `schema`', () => {
    const parsed = parsePgCompatibleConfig({ ...baseRawConfig }, 'test');
    expect(parsed.schema).toBeUndefined();
  });

  it('accepts a config where `schema` is explicitly null', () => {
    const parsed = parsePgCompatibleConfig({ ...baseRawConfig, schema: null }, 'test');
    expect(parsed.schema).toBeUndefined();
  });

  it('coerces an explicit empty `schema` to undefined', () => {
    // An empty `SET search_path TO "", public` would silently empty the
    // user's search_path; treat it the same as omitting the field.
    const parsed = parsePgCompatibleConfig({ ...baseRawConfig, schema: '' }, 'test');
    expect(parsed.schema).toBeUndefined();
  });

  it('preserves an explicit `schema` value', () => {
    const parsed = parsePgCompatibleConfig({ ...baseRawConfig, schema: 'sales' }, 'test');
    expect(parsed.schema).toBe('sales');
  });

  it('still rejects non-string `schema` values', () => {
    expect(() => parsePgCompatibleConfig({ ...baseRawConfig, schema: 7 }, 'test')).toThrow(
      /"schema" must be a string if provided/
    );
  });
});

describe('PgCompatibleWarehouseClient.configureSession (schema search_path)', () => {
  it('issues SET search_path when a default schema is configured', async () => {
    const fetchBatches = [[{ id: 1 }], []] as Array<Record<string, unknown>[]>;
    const { client, warehouseClient } = createClient(
      async (query) => {
        if (typeof query === 'string' && query.startsWith('FETCH ')) {
          return { rows: fetchBatches.shift() ?? [] };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      { schema: 'sales' }
    );

    for await (const _ of warehouseClient.execute('SELECT 1')) {
      void _;
    }

    expect(client.query).toHaveBeenCalledWith('SET search_path TO "sales", public');
  });

  it('skips SET search_path when no schema is configured', async () => {
    const fetchBatches = [[{ id: 1 }], []] as Array<Record<string, unknown>[]>;
    const { client, warehouseClient } = createClient(
      async (query) => {
        if (typeof query === 'string' && query.startsWith('FETCH ')) {
          return { rows: fetchBatches.shift() ?? [] };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      { schema: undefined }
    );

    for await (const _ of warehouseClient.execute('SELECT 1')) {
      void _;
    }

    const calls = client.query.mock.calls.map(([q]) =>
      typeof q === 'string' ? q : (q as { text: string }).text
    ) as string[];
    expect(calls.some((q) => q.startsWith('SET search_path'))).toBe(false);
  });

  it('escapes embedded double quotes in the configured schema', async () => {
    const fetchBatches = [[{ id: 1 }], []] as Array<Record<string, unknown>[]>;
    const { client, warehouseClient } = createClient(
      async (query) => {
        if (typeof query === 'string' && query.startsWith('FETCH ')) {
          return { rows: fetchBatches.shift() ?? [] };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      { schema: 'odd"name' }
    );

    for await (const _ of warehouseClient.execute('SELECT 1')) {
      void _;
    }

    expect(client.query).toHaveBeenCalledWith('SET search_path TO "odd""name", public');
  });
});
