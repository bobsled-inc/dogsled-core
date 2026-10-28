import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  inferColumns,
  generateResourceSkeleton,
  detectDrift,
} from '../../src/runtime/schema-inference.js';

describe('inferColumns', () => {
  it('infers types from sample data', () => {
    const data = {
      results: [
        { id: 1, name: 'Alice', score: 9.5, active: true, created_at: '2024-01-01T00:00:00Z' },
        { id: 2, name: 'Bob', score: 8.0, active: false, created_at: '2024-01-02T00:00:00Z' },
      ],
    };

    const columns = inferColumns(data, '$.results');

    expect(columns).toEqual([
      { name: 'id', type: 'integer', path: '$.id', primary_key: true },
      { name: 'name', type: 'string', path: '$.name' },
      { name: 'score', type: 'number', path: '$.score' },
      { name: 'active', type: 'boolean', path: '$.active' },
      { name: 'created_at', type: 'timestamp', path: '$.created_at', cursor_candidate: true },
    ]);
  });

  it('widens integer + number to number', () => {
    const data = [{ value: 1 }, { value: 1.5 }];

    const columns = inferColumns(data, '$');
    expect(columns[0]!.type).toBe('number');
  });

  it('falls back to string for null values', () => {
    const data = [{ field: null }];
    const columns = inferColumns(data, '$');
    expect(columns[0]!.type).toBe('string');
  });

  it('detects arrays and objects', () => {
    const data = [{ tags: ['a', 'b'], meta: { key: 'value' } }];
    const columns = inferColumns(data, '$');

    const tagsCol = columns.find((c) => c.name === 'tags');
    const metaCol = columns.find((c) => c.name === 'meta');

    expect(tagsCol!.type).toBe('array');
    expect(metaCol!.type).toBe('object');
  });

  it('returns empty array for empty data', () => {
    expect(inferColumns({ results: [] }, '$.results')).toEqual([]);
    expect(inferColumns(null, '$')).toEqual([]);
  });

  it('detects cursor candidates for *_date fields', () => {
    const data = [{ updated_date: '2024-06-01' }];
    const columns = inferColumns(data, '$');
    expect(columns[0]!.cursor_candidate).toBe(true);
  });

  it('limits to first 10 records', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item_${i}` }));
    const columns = inferColumns(data, '$');
    // Should still work correctly with sampled data
    expect(columns.find((c) => c.name === 'id')).toBeDefined();
  });
});

describe('generateResourceSkeleton', () => {
  it('generates valid YAML skeleton', () => {
    const columns = [
      { name: 'id', type: 'integer' as const, path: '$.id', primary_key: true },
      { name: 'name', type: 'string' as const, path: '$.name' },
      {
        name: 'updated_at',
        type: 'timestamp' as const,
        path: '$.updated_at',
        cursor_candidate: true,
      },
    ];

    const yaml = generateResourceSkeleton(columns, 'github', 'users', '/users');
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    const extract = parsed['extract'] as Record<string, unknown>;
    const table = extract['table'] as Record<string, unknown>;
    const incremental = extract['incremental'] as Record<string, unknown>;

    expect(parsed['name']).toBe('users');
    expect(parsed['integration']).toBe('github');
    expect((parsed['api'] as Record<string, unknown>)['endpoint']).toBe('/users');
    expect(table['primary_key']).toEqual(['id']);
    expect(incremental['cursor_field']).toBe('updated_at');
  });

  it('omits incremental when no cursor candidates', () => {
    const columns = [{ name: 'id', type: 'integer' as const }];
    const yaml = generateResourceSkeleton(columns, 'api', 'items', '/items');
    expect(yaml).not.toContain('incremental');
  });
});

describe('detectDrift', () => {
  it('detects new fields', () => {
    const inferred = [
      { name: 'id', type: 'integer' as const },
      { name: 'avatar_url', type: 'string' as const },
    ];
    const declared = [{ name: 'id', type: 'integer' }];

    const report = detectDrift(inferred, declared);
    expect(report.newFields).toEqual(['avatar_url']);
    expect(report.removedFields).toEqual([]);
    expect(report.typeChanges).toEqual([]);
  });

  it('detects removed fields', () => {
    const inferred = [{ name: 'id', type: 'integer' as const }];
    const declared = [
      { name: 'id', type: 'integer' },
      { name: 'legacy_field', type: 'string' },
    ];

    const report = detectDrift(inferred, declared);
    expect(report.removedFields).toEqual(['legacy_field']);
  });

  it('detects type changes', () => {
    const inferred = [{ name: 'count', type: 'string' as const }];
    const declared = [{ name: 'count', type: 'integer' }];

    const report = detectDrift(inferred, declared);
    expect(report.typeChanges).toEqual([
      { field: 'count', declared: 'integer', observed: 'string' },
    ]);
  });

  it('reports no drift when schemas match', () => {
    const columns = [
      { name: 'id', type: 'integer' as const },
      { name: 'name', type: 'string' as const },
    ];

    const report = detectDrift(columns, columns);
    expect(report.newFields).toEqual([]);
    expect(report.removedFields).toEqual([]);
    expect(report.typeChanges).toEqual([]);
  });
});
