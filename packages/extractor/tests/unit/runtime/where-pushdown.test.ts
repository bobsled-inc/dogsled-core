import { describe, expect, it } from 'vitest';

import type { Predicate } from '../../../src/framework/extractor/predicate.js';
import type { QuerySpec } from '../../../src/framework/extractor/resource.js';
import { splitWherePushdown } from '../../../src/runtime/where-pushdown.js';

function makeQuery(filters: NonNullable<QuerySpec['filters']>): QuerySpec {
  return { filters } as QuerySpec;
}

function resolvedValueMap(predicates: ReadonlyArray<Predicate>): Map<number, unknown> {
  // Test helper — mirrors what WhereTracker.from does in production, but
  // keeps the resolver deterministic (no relative-duration math).
  return new Map(
    predicates.map((predicate, index) => {
      const op = Object.keys(predicate).find((k) => k !== 'field')!;
      return [index, (predicate as Record<string, unknown>)[op]];
    })
  );
}

describe('splitWherePushdown', () => {
  it('leaves predicates with no matching query.filters binding in remaining', () => {
    const predicates: Predicate[] = [{ field: 'status', eq: 'open' }];
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      undefined,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({});
    expect(remaining).toEqual(predicates);
  });

  it('pushes http_query mode predicates into pushedParams via compile.param', () => {
    const predicates: Predicate[] = [{ field: 'last_edited_time', gte: '2026-01-01T00:00:00Z' }];
    const query = makeQuery({
      last_edited_time: {
        operators: ['gte'],
        compile: { gte: { mode: 'http_query', param: 'updated_since' } },
        bind: { gte: { input: 'since' } },
      },
    });
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      query,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({ updated_since: '2026-01-01T00:00:00Z' });
    expect(remaining).toEqual([]);
  });

  it('falls back to bind[op].input when compile.param is omitted', () => {
    const predicates: Predicate[] = [{ field: 'last_edited_time', gte: '2026-01-01T00:00:00Z' }];
    const query = makeQuery({
      last_edited_time: {
        operators: ['gte'],
        compile: { gte: { mode: 'http_query' } },
        bind: { gte: { input: 'since' } },
      },
    });
    const { pushedParams } = splitWherePushdown(predicates, query, resolvedValueMap(predicates));
    expect(pushedParams).toEqual({ since: '2026-01-01T00:00:00Z' });
  });

  it('pushes direct_arg via compile.argument', () => {
    const predicates: Predicate[] = [{ field: 'status', eq: 'open' }];
    const query = makeQuery({
      status: {
        operators: ['eq'],
        compile: { eq: { mode: 'direct_arg', argument: 'statusFilter' } },
        bind: { eq: { input: 'status' } },
      },
    });
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      query,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({ statusFilter: 'open' });
    expect(remaining).toEqual([]);
  });

  it('splits a mix of pushable + remainder predicates', () => {
    const predicates: Predicate[] = [
      { field: 'last_edited_time', gte: '2026-01-01T00:00:00Z' },
      { field: 'archived', eq: false },
    ];
    const query = makeQuery({
      last_edited_time: {
        operators: ['gte'],
        compile: { gte: { mode: 'http_query', param: 'updated_since' } },
        bind: { gte: { input: 'since' } },
      },
    });
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      query,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({ updated_since: '2026-01-01T00:00:00Z' });
    expect(remaining).toEqual([{ field: 'archived', eq: false }]);
  });

  it('refuses to push `in` and `neq` even when a binding exists', () => {
    const predicates: Predicate[] = [
      { field: 'status', in: ['open', 'closed'] },
      { field: 'status', neq: 'merged' },
    ];
    const query = makeQuery({
      status: {
        operators: ['in', 'ne'],
        compile: { in: { mode: 'http_query' }, ne: { mode: 'http_query' } },
        bind: { in: { input: 'status' }, ne: { input: 'status_ne' } },
      },
    });
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      query,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({});
    expect(remaining).toHaveLength(2);
  });

  it('ignores predicates whose operator is absent from operators[]', () => {
    const predicates: Predicate[] = [{ field: 'status', gt: 0 }];
    const query = makeQuery({
      status: {
        operators: ['eq'],
        compile: { eq: { mode: 'http_query' } },
        bind: { eq: { input: 'status' } },
      },
    });
    const { pushedParams, remaining } = splitWherePushdown(
      predicates,
      query,
      resolvedValueMap(predicates)
    );
    expect(pushedParams).toEqual({});
    expect(remaining).toEqual(predicates);
  });
});
