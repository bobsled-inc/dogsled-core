import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { formatRelative } from '../src/lib/format-relative';

const NOW = new Date('2026-01-01T01:00:00.000Z').getTime();

function withFixedNow(run: () => void): void {
  mock.method(Date, 'now', () => NOW);
  try {
    run();
  } finally {
    mock.restoreAll();
  }
}

test('returns the input unchanged for invalid dates', () => {
  assert.equal(formatRelative('not-a-date'), 'not-a-date');
  assert.equal(formatRelative(''), '');
});

test('returns seconds for sub-minute diffs', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 30_000).toISOString()), '30s ago');
  });
});

test('returns 59s ago just before the 1-minute boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 59_000).toISOString()), '59s ago');
  });
});

test('returns 1m ago at the 1-minute boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 60_000).toISOString()), '1m ago');
  });
});

test('returns 59m ago just before the 1-hour boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 59 * 60_000).toISOString()), '59m ago');
  });
});

test('returns 1h ago at the 1-hour boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 60 * 60_000).toISOString()), '1h ago');
  });
});

test('returns 23h ago just before the 1-day boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 23 * 3600_000).toISOString()), '23h ago');
  });
});

test('returns 1d ago at the 1-day boundary', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 24 * 3600_000).toISOString()), '1d ago');
  });
});

test('returns 7d ago for multi-day diffs', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW - 7 * 24 * 3600_000).toISOString()), '7d ago');
  });
});

test('clamps future timestamps to 0s ago', () => {
  withFixedNow(() => {
    assert.equal(formatRelative(new Date(NOW + 5000).toISOString()), '0s ago');
  });
});
