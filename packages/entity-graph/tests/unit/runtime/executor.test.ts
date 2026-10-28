import { describe, expect, it, vi } from 'vitest';

import { createWarehouseExecutor } from '../../../src/runtime/executor/index.js';
import { encodeCursor } from '../../../src/runtime/services/cursor.js';

describe('createWarehouseExecutor', () => {
  it('implements find and get over golden entity tables', async () => {
    const runner = {
      run: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('company__golden')) {
          return [{ entity_id: 'entity-1', display_name: 'Acme', trust_score: 0.98 }];
        }
        if (sql.includes('company__entity_quality')) {
          return [{ entity_id: 'entity-1', trust_tier: 'trusted' }];
        }
        if (sql.includes('company__crosswalks')) {
          return [{ record_id: 'record-1', entity_id: 'entity-1', source_ref: 'crm.accounts' }];
        }
        return [];
      }),
    };
    const executor = createWarehouseExecutor({ runner, schema: 'entity_graph', dialect: 'duckdb' });
    const found = await executor.find<
      { entity_id: string; display_name: string },
      { entity_id?: string }
    >({
      entity: 'company',
      filter: { entity_id: 'entity-1' },
      includes: { documents: false, relationships: [] },
      limit: 1,
    });
    expect(found[0]?.profile).toMatchObject({ entity_id: 'entity-1', display_name: 'Acme' });
    await expect(executor.get({ entity: 'company', id: 'entity-1' })).resolves.toMatchObject({
      entity_id: 'entity-1',
    });
  });

  it('passes cursors through find and fetches relationship includes per entity', async () => {
    const runner = {
      run: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('company__golden') && sql.includes('COUNT(*)')) {
          return [{ row_count: 2 }];
        }
        if (sql.includes('company__golden')) {
          return [
            { entity_id: 'entity-1', display_name: 'Acme', trust_score: 0.98 },
            { entity_id: 'entity-2', display_name: 'Beta', trust_score: 0.92 },
          ];
        }
        if (sql.includes('__entity_relationship')) {
          if (sql.includes("'entity-2'")) {
            return [
              {
                relationship_id: 'rel-entity-2',
                left_entity_id: 'entity-2',
                right_entity_id: 'external-2',
                relation_type: 'competes_with',
                confidence: 0.95,
              },
            ];
          }
          return [
            {
              relationship_id: 'rel-1',
              left_entity_id: 'entity-1',
              right_entity_id: 'external-1',
              relation_type: 'competes_with',
              confidence: 0.9,
            },
          ];
        }
        return [];
      }),
    };
    const executor = createWarehouseExecutor({ runner, schema: 'entity_graph', dialect: 'duckdb' });
    const cursor = encodeCursor({ offset: 25 });

    const found = await executor.find<
      { entity_id: string; display_name: string },
      { display_name?: string }
    >({
      entity: 'company',
      filter: {},
      includes: { documents: false, relationships: ['competes_with'] },
      limit: 2,
      cursor,
    });

    const listQuery = runner.query.mock.calls.find(([sql]) => sql.includes('company__golden'))?.[0];
    const relationshipQueries = runner.query.mock.calls.filter(([sql]) =>
      sql.includes('__entity_relationship')
    );
    expect(listQuery).toContain('OFFSET 25');
    expect(relationshipQueries).toHaveLength(2);
    expect(relationshipQueries[0]?.[0]).toContain('"relation_type" = \'competes_with\'');
    expect(found[0]?.relationships['competes_with']).toHaveLength(1);
    expect(found[1]?.relationships['competes_with']).toHaveLength(1);
  });
});
