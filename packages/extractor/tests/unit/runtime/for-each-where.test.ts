import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeForEachConfig } from '../../../src/runtime/for-each.js';
import { evaluateResolvedPredicate, resolvePredicate } from '../../../src/runtime/predicates.js';
import { ResourceSpecSchema } from '../../../src/framework/extractor/resource.js';
import { makeResource } from '../../helpers/fixtures.js';

const FIXED_NOW = new Date('2026-06-08T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeForEachConfig with where', () => {
  it('surfaces where predicates on the legacy field/input shape', () => {
    const config = normalizeForEachConfig({
      resource: 'nt_pages',
      field: 'id',
      input: 'block_id',
      where: [{ field: 'archived', eq: false }],
    });
    expect(config?.where).toEqual([{ field: 'archived', eq: false }]);
    expect(config?.bindings).toEqual([{ field: 'id', input: 'block_id', source: 'output' }]);
  });

  it('surfaces where predicates on the bindings shape', () => {
    const config = normalizeForEachConfig({
      resource: 'nt_pages',
      bindings: [{ field: 'id', input: 'block_id' }],
      where: [
        { field: 'last_edited_time', gte: '-6mo' },
        { field: 'archived', eq: false },
      ],
    });
    expect(config?.where).toHaveLength(2);
  });

  it('omits where when not declared', () => {
    const config = normalizeForEachConfig({
      resource: 'nt_pages',
      field: 'id',
      input: 'block_id',
    });
    expect(config?.where).toBeUndefined();
  });
});

describe('for_each.where filters parents at extraction time', () => {
  it('drops parents whose output field fails the predicates', () => {
    // Simulate the filter loop in extract.ts to confirm the predicates apply
    // correctly to parent OUTPUT records.
    const parents = [
      { input: {}, output: { id: 'a', last_edited_time: '2026-06-01T00:00:00Z', archived: false } },
      { input: {}, output: { id: 'b', last_edited_time: '2024-01-01T00:00:00Z', archived: false } },
      { input: {}, output: { id: 'c', last_edited_time: '2026-06-01T00:00:00Z', archived: true } },
    ];
    const predicates = [
      { field: 'last_edited_time', gte: '-6mo' },
      { field: 'archived', eq: false },
    ];
    const resolved = predicates.map((p) => resolvePredicate(p, FIXED_NOW));

    const filtered = parents.filter((parent) =>
      resolved.every((predicate) => evaluateResolvedPredicate(parent.output, predicate))
    );

    expect(filtered.map((p) => p.output.id)).toEqual(['a']);
  });
});

describe('for_each.where survives schema parsing', () => {
  function makeForEachResource(forEach: Record<string, unknown>) {
    return makeResource({
      name: 'nt_blocks',
      api: { method: 'GET', endpoint: '/v1/blocks/{block_id}/children' },
      input: { block_id: { type: 'string', required: true } },
      output: { id: { type: 'string', path: '$.id' } },
      extract: {
        record_path: '$.results',
        for_each: forEach,
      } as unknown as Record<string, unknown>,
    });
  }

  it('parses where on the legacy for_each shape', () => {
    const result = ResourceSpecSchema.safeParse(
      makeForEachResource({
        resource: 'nt_pages',
        field: 'id',
        input: 'block_id',
        where: [{ field: 'archived', eq: false }],
      })
    );
    expect(result.success).toBe(true);
  });

  it('parses where on the bindings for_each shape', () => {
    const result = ResourceSpecSchema.safeParse(
      makeForEachResource({
        resource: 'nt_pages',
        bindings: [{ field: 'id', input: 'block_id' }],
        where: [{ field: 'archived', eq: false }],
      })
    );
    expect(result.success).toBe(true);
  });
});
