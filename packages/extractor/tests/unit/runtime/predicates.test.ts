import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  evaluatePredicate,
  evaluateResolvedPredicate,
  resolvePredicate,
  resolvePredicateValue,
} from '../../../src/runtime/predicates.js';

const FIXED_NOW = new Date('2026-06-08T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolvePredicateValue', () => {
  it('passes through ISO strings, numbers, and booleans untouched', () => {
    expect(resolvePredicateValue('2026-01-01T00:00:00Z', FIXED_NOW)).toBe('2026-01-01T00:00:00Z');
    expect(resolvePredicateValue(42, FIXED_NOW)).toBe(42);
    expect(resolvePredicateValue(false, FIXED_NOW)).toBe(false);
  });

  it('resolves relative durations against the given now', () => {
    // 6 months ≈ 180 days. Resolved value should be 180 days before FIXED_NOW.
    const expected = new Date(FIXED_NOW.getTime() - 86_400_000 * 30 * 6).toISOString();
    expect(resolvePredicateValue('-6mo', FIXED_NOW)).toBe(expected);
  });

  it('treats unsigned and signed relative durations identically', () => {
    expect(resolvePredicateValue('6mo', FIXED_NOW)).toBe(resolvePredicateValue('-6mo', FIXED_NOW));
  });

  it('supports m/h/d/w/mo/y unit shorthands', () => {
    const sixHours = new Date(FIXED_NOW.getTime() - 6 * 3_600_000).toISOString();
    expect(resolvePredicateValue('6h', FIXED_NOW)).toBe(sixHours);
    const sevenDays = new Date(FIXED_NOW.getTime() - 7 * 86_400_000).toISOString();
    expect(resolvePredicateValue('7d', FIXED_NOW)).toBe(sevenDays);
    const oneWeek = new Date(FIXED_NOW.getTime() - 7 * 86_400_000).toISOString();
    expect(resolvePredicateValue('1w', FIXED_NOW)).toBe(oneWeek);
    const oneYear = new Date(FIXED_NOW.getTime() - 365 * 86_400_000).toISOString();
    expect(resolvePredicateValue('1y', FIXED_NOW)).toBe(oneYear);
  });

  it('resolves array values element-wise', () => {
    expect(resolvePredicateValue(['a', 'b'], FIXED_NOW)).toEqual(['a', 'b']);
  });
});

describe('evaluatePredicate / evaluateResolvedPredicate', () => {
  it('eq matches on value equality and coerces across number/string', () => {
    expect(evaluatePredicate({ field: 'status', eq: 'open' }, { status: 'open' }, FIXED_NOW)).toBe(
      false
    );
    // record / predicate signature is (record, predicate, now)
    expect(evaluatePredicate({ status: 'open' }, { field: 'status', eq: 'open' }, FIXED_NOW)).toBe(
      true
    );
    expect(evaluatePredicate({ count: 7 }, { field: 'count', eq: '7' }, FIXED_NOW)).toBe(true);
  });

  it('neq inverts eq', () => {
    expect(
      evaluatePredicate({ status: 'open' }, { field: 'status', neq: 'closed' }, FIXED_NOW)
    ).toBe(true);
    expect(evaluatePredicate({ status: 'open' }, { field: 'status', neq: 'open' }, FIXED_NOW)).toBe(
      false
    );
  });

  it('gt/gte/lt/lte compare numerics numerically and strings lexically', () => {
    expect(evaluatePredicate({ n: 10 }, { field: 'n', gt: 5 }, FIXED_NOW)).toBe(true);
    expect(evaluatePredicate({ n: 5 }, { field: 'n', gt: 5 }, FIXED_NOW)).toBe(false);
    expect(evaluatePredicate({ n: 5 }, { field: 'n', gte: 5 }, FIXED_NOW)).toBe(true);
    expect(evaluatePredicate({ n: 4 }, { field: 'n', lt: 5 }, FIXED_NOW)).toBe(true);
    expect(evaluatePredicate({ n: 5 }, { field: 'n', lte: 5 }, FIXED_NOW)).toBe(true);
  });

  it('gte against a resolved relative duration compares ISO 8601 lexically', () => {
    // last_edited_time = 2026-06-01, predicate gte: -6mo (≈ 2025-12-10)
    const record = { last_edited_time: '2026-06-01T00:00:00Z' };
    const predicate = { field: 'last_edited_time', gte: '-6mo' as const };
    expect(evaluatePredicate(record, predicate, FIXED_NOW)).toBe(true);
  });

  it('gte resolves the predicate value before comparing, so older records fail', () => {
    const record = { last_edited_time: '2025-01-01T00:00:00Z' };
    const predicate = { field: 'last_edited_time', gte: '-6mo' as const };
    expect(evaluatePredicate(record, predicate, FIXED_NOW)).toBe(false);
  });

  it('in matches when any candidate equals the record value', () => {
    expect(
      evaluatePredicate({ status: 'open' }, { field: 'status', in: ['open', 'closed'] }, FIXED_NOW)
    ).toBe(true);
    expect(
      evaluatePredicate(
        { status: 'merged' },
        { field: 'status', in: ['open', 'closed'] },
        FIXED_NOW
      )
    ).toBe(false);
  });

  it('contains requires both sides to be strings', () => {
    expect(
      evaluatePredicate({ name: 'lakehouse' }, { field: 'name', contains: 'lake' }, FIXED_NOW)
    ).toBe(true);
    expect(evaluatePredicate({ n: 5 }, { field: 'n', contains: '5' }, FIXED_NOW)).toBe(false);
  });

  it('missing record fields fail every operator', () => {
    expect(evaluatePredicate({}, { field: 'missing', gt: 0 }, FIXED_NOW)).toBe(false);
    expect(evaluatePredicate({}, { field: 'missing', eq: 'x' }, FIXED_NOW)).toBe(false);
    expect(evaluatePredicate({}, { field: 'missing', neq: 'x' }, FIXED_NOW)).toBe(false);
    expect(evaluatePredicate({}, { field: 'missing', contains: 'x' }, FIXED_NOW)).toBe(false);
  });

  it('resolved predicates can be reused across many records', () => {
    const resolved = resolvePredicate({ field: 'n', gte: 5 }, FIXED_NOW);
    expect(evaluateResolvedPredicate({ n: 10 }, resolved)).toBe(true);
    expect(evaluateResolvedPredicate({ n: 5 }, resolved)).toBe(true);
    expect(evaluateResolvedPredicate({ n: 4 }, resolved)).toBe(false);
  });
});
