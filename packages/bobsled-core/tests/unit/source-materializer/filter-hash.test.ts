import { describe, expect, it } from 'vitest';

import { filterHash } from '../../../src/runtime/source-materializer/filter-hash.js';

describe('filterHash', () => {
  it('is deterministic', () => {
    expect(filterHash({ state: 'open', since: '2026-04-01' })).toBe(
      filterHash({ state: 'open', since: '2026-04-01' })
    );
  });

  it('is key-order independent', () => {
    expect(filterHash({ a: 1, b: 2 })).toBe(filterHash({ b: 2, a: 1 }));
  });

  it('is nested-key-order independent', () => {
    expect(filterHash({ ts: { gte: 'x', lte: 'y' } })).toBe(
      filterHash({ ts: { lte: 'y', gte: 'x' } })
    );
  });

  it('uses a stable sentinel for undefined and empty filters', () => {
    expect(filterHash(undefined)).toBe(filterHash({}));
    expect(filterHash(undefined)).toMatch(/^[a-f0-9]{32}$/);
  });

  it('differs on value change', () => {
    expect(filterHash({ state: 'open' })).not.toBe(filterHash({ state: 'closed' }));
  });

  it('differs on nested operator change', () => {
    expect(filterHash({ ts: { gte: '2026-04-01' } })).not.toBe(
      filterHash({ ts: { gte: '2026-04-02' } })
    );
  });

  it('canonicalizes bare and @now relative date shorthands the same way', () => {
    const options = { nowIso: '2026-04-22T12:05:00.000Z' };

    expect(filterHash({ created_at: { gte: '-7d' } }, options)).toBe(
      filterHash({ created_at: { gte: '@now-7d' } }, options)
    );
  });

  it('keeps relative-date hashes stable within the default one-hour bucket', () => {
    const filter = { created_at: { gte: '-1d', lte: '@now' } };

    expect(filterHash(filter, { nowIso: '2026-04-22T12:05:00.000Z' })).toBe(
      filterHash(filter, { nowIso: '2026-04-22T12:59:59.999Z' })
    );
    expect(filterHash(filter, { nowIso: '2026-04-22T12:05:00.000Z' })).not.toBe(
      filterHash(filter, { nowIso: '2026-04-22T13:00:00.000Z' })
    );
  });

  it('uses max_age as the relative-date bucket when it is larger than one hour', () => {
    const filter = { created_at: { gte: '@now-7d' } };
    const options = { maxAge: '1d' };

    expect(filterHash(filter, { ...options, nowIso: '2026-04-22T00:05:00.000Z' })).toBe(
      filterHash(filter, { ...options, nowIso: '2026-04-22T23:59:59.999Z' })
    );
    expect(filterHash(filter, { ...options, nowIso: '2026-04-22T00:05:00.000Z' })).not.toBe(
      filterHash(filter, { ...options, nowIso: '2026-04-23T00:00:00.000Z' })
    );
  });
});
