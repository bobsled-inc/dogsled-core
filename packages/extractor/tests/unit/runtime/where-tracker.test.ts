import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Predicate } from '../../../src/framework/extractor/predicate.js';
import type { QuerySpec } from '../../../src/framework/extractor/resource.js';
import { WhereTracker } from '../../../src/runtime/where-tracker.js';

const FIXED_NOW = new Date('2026-06-08T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WhereTracker', () => {
  it('matches() returns true when no predicates are declared', () => {
    const tracker = WhereTracker.from(undefined, undefined, FIXED_NOW);
    expect(tracker.matches({ anything: true })).toBe(true);
    expect(tracker.pushedParams).toEqual({});
  });

  it('ANDs every remainder predicate against the record', () => {
    const predicates: Predicate[] = [
      { field: 'archived', eq: false },
      { field: 'public', eq: true },
    ];
    const tracker = WhereTracker.from(predicates, undefined, FIXED_NOW);
    expect(tracker.matches({ archived: false, public: true })).toBe(true);
    expect(tracker.matches({ archived: false, public: false })).toBe(false);
    expect(tracker.matches({ archived: true, public: true })).toBe(false);
  });

  it('separates pushable predicates from client-side remainder', () => {
    const predicates: Predicate[] = [
      { field: 'last_edited_time', gte: '2026-01-01T00:00:00Z' },
      { field: 'archived', eq: false },
    ];
    const query: QuerySpec = {
      filters: {
        last_edited_time: {
          operators: ['gte'],
          compile: { gte: { mode: 'http_query', param: 'updated_since' } },
          bind: { gte: { input: 'since' } },
        },
      },
    } as QuerySpec;

    const tracker = WhereTracker.from(predicates, query, FIXED_NOW);
    expect(tracker.pushedParams).toEqual({ updated_since: '2026-01-01T00:00:00Z' });
    // The pushable predicate is excluded from the client-side check —
    // a record that would have failed gte still passes because the API
    // already filtered it out at the source.
    expect(tracker.matches({ archived: false, last_edited_time: '2020-01-01' })).toBe(true);
    expect(tracker.matches({ archived: true, last_edited_time: '2020-01-01' })).toBe(false);
  });

  it('emptyResultWarning surfaces when every record was rejected', () => {
    const tracker = WhereTracker.from([{ field: 'status', eq: 'open' }], undefined, FIXED_NOW);
    tracker.matches({ status: 'closed' });
    tracker.matches({ status: 'merged' });
    const warning = tracker.emptyResultWarning('issues', 1, 0);
    expect(warning).toContain('extract.where rejected 2 records');
    expect(warning).toContain('status');
  });

  it('emptyResultWarning is null when at least one record passed', () => {
    const tracker = WhereTracker.from([{ field: 'status', eq: 'open' }], undefined, FIXED_NOW);
    tracker.matches({ status: 'open' });
    expect(tracker.emptyResultWarning('issues', 1, 1)).toBeNull();
  });
});
