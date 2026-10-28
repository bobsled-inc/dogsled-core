import { describe, expect, it, vi } from 'vitest';

import { discoverWarehouseTables } from '../../src/runtime/warehouse-discovery.js';

import type { WarehouseClient } from '../../src/runtime/warehouse-client.js';

describe('discoverWarehouseTables — ClickHouse', () => {
  it('uses ClickHouse primary-key metadata and suggests a cursor field', async () => {
    const client = {
      dialect: 'clickhouse',
      introspect: vi.fn().mockResolvedValue([
        {
          tableName: 'Events',
          database: 'analytics',
          schema: 'default',
          columns: [
            {
              name: 'event_id',
              sourceType: 'UInt64',
              nullable: false,
              isPrimaryKey: true,
            },
            {
              name: 'updated_at',
              sourceType: 'DateTime64(3)',
              nullable: false,
              isPrimaryKey: false,
            },
          ],
        },
      ]),
    } as unknown as WarehouseClient;

    const resources = await discoverWarehouseTables(client, 'analytics', 'default');

    expect(client.introspect).toHaveBeenCalledWith('analytics', 'default');
    expect(resources).toEqual([
      {
        name: 'events',
        table: 'Events',
        database: 'analytics',
        schema: 'default',
        columns: [
          { name: 'event_id', type: 'UInt64', nullable: false },
          { name: 'updated_at', type: 'DateTime64(3)', nullable: false },
        ],
        suggestedPrimaryKey: ['event_id'],
        suggestedCursorField: 'updated_at',
      },
    ]);
  });
});
