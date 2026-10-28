import { describe, expect, it } from 'vitest';

import {
  invokeBuilder,
  listFilterBuilders,
  parseFilterExpression,
} from '../../src/framework/query/index.js';

describe('query filter builders', () => {
  it('lists contained builders without exposing arbitrary imports', () => {
    expect(listFilterBuilders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'hubspot/crm-search' }),
        expect.objectContaining({ id: 'notion/database-query' }),
      ])
    );
  });

  it('builds HubSpot filterGroups from the full predicate list', () => {
    const args = invokeBuilder(
      'hubspot/crm-search',
      {
        field_map: {
          updated_at: 'hs_lastmodifieddate',
        },
      },
      [
        { field: 'status', operator: 'eq', value: 'open' },
        { field: 'updated_at', operator: 'gte', value: '2026-03-01T00:00:00.000Z' },
      ]
    );

    expect(args).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: 'status', operator: 'EQ', value: 'open' },
            {
              propertyName: 'hs_lastmodifieddate',
              operator: 'GTE',
              value: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
  });

  it('does not double-wrap HubSpot filterGroups when the argument matches the payload key', () => {
    const args = invokeBuilder(
      'hubspot/crm-search',
      {
        argument: 'filterGroups',
      },
      [{ field: 'status', operator: 'eq', value: 'open' }]
    );

    expect(args).toEqual({
      filterGroups: [
        {
          filters: [{ propertyName: 'status', operator: 'EQ', value: 'open' }],
        },
      ],
    });
  });

  it('builds Notion filters using configured field types', () => {
    const args = invokeBuilder(
      'notion/database-query',
      {
        field_map: {
          updated_at: 'Updated at',
        },
        field_types: {
          updated_at: 'date',
        },
      },
      [{ field: 'updated_at', operator: 'gte', value: '2026-03-01' }]
    );

    expect(args).toEqual({
      filter: {
        property: 'Updated at',
        date: {
          on_or_after: '2026-03-01',
        },
      },
    });
  });

  it('rejects unsupported Notion operator and property-type pairs', () => {
    expect(() =>
      invokeBuilder(
        'notion/database-query',
        {
          field_types: {
            title: 'rich_text',
          },
        },
        [{ field: 'title', operator: 'gte', value: 'M' }]
      )
    ).toThrow('Notion rich_text filters do not support operator "gte"');
  });

  it('parses simple incremental filter expressions', () => {
    expect(
      parseFilterExpression("updated_at >= '2026-03-01T00:00:00.000Z' and status = open")
    ).toEqual([
      { field: 'updated_at', operator: 'gte', value: '2026-03-01T00:00:00.000Z' },
      { field: 'status', operator: 'eq', value: 'open' },
    ]);
  });

  it('unescapes quoted filter expression values', () => {
    expect(
      parseFilterExpression(String.raw`name = "Ada \"Lovelace\"" and note = 'line\none'`)
    ).toEqual([
      { field: 'name', operator: 'eq', value: 'Ada "Lovelace"' },
      { field: 'note', operator: 'eq', value: 'line\none' },
    ]);
  });

  it('does not split predicates or list items inside quoted values', () => {
    expect(
      parseFilterExpression(
        String.raw`name = "Research and Development" and status in ("A,B", 'C and D')`
      )
    ).toEqual([
      { field: 'name', operator: 'eq', value: 'Research and Development' },
      { field: 'status', operator: 'in', value: ['A,B', 'C and D'] },
    ]);
  });
});
