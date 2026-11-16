import { describe, expect, it } from 'vitest';

import { RecordFilterTracker } from '../../src/runtime/record-filters.js';
import type { RecordFilter } from '../../src/framework/extractor/record-filter.js';

const repoNameFilter: RecordFilter = {
  field: 'name',
  input: 'repo_names',
  operator: 'in',
  delimiter: ',',
};

describe('RecordFilterTracker.from + matches', () => {
  it('passes every record when filters are undefined or empty', () => {
    const tracker = RecordFilterTracker.from(undefined, {});
    expect(tracker.matches({ name: 'bobsled' })).toBe(true);
    expect(tracker.matches({ name: 'bobsled-agents' })).toBe(true);
  });

  it('skips filters whose input is missing or empty (pass-through semantics)', () => {
    expect(RecordFilterTracker.from([repoNameFilter], {}).matches({ name: 'bobsled' })).toBe(true);
    expect(
      RecordFilterTracker.from([repoNameFilter], { repo_names: '' }).matches({ name: 'bobsled' })
    ).toBe(true);
    expect(
      RecordFilterTracker.from([repoNameFilter], { repo_names: [] }).matches({ name: 'bobsled' })
    ).toBe(true);
  });

  it('matches records whose field value is in the allowed set (delimited string input)', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], {
      repo_names: 'bobsled, bobsled-agents',
    });
    expect(tracker.matches({ name: 'bobsled' })).toBe(true);
    expect(tracker.matches({ name: 'demo-repo' })).toBe(false);
  });

  it('matches records whose field value is in the allowed set (array input)', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], {
      repo_names: ['bobsled', 'demo-repo'],
    });
    expect(tracker.matches({ name: 'demo-repo' })).toBe(true);
    expect(tracker.matches({ name: 'bobsled-agents' })).toBe(false);
  });

  it('decodes JSON-array strings emitted by targeted resource inputs', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], {
      repo_names: JSON.stringify(['bobsled', 'demo-repo']),
    });
    expect(tracker.matches({ name: 'bobsled' })).toBe(true);
    expect(tracker.matches({ name: 'bobsled-agents' })).toBe(false);
  });

  it('keeps an explicitly encoded empty array as a filter that matches nothing', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: '[]' });
    expect(tracker.matches({ name: 'bobsled' })).toBe(false);
  });

  it('does not split malformed bracket-prefixed array text into unusable tokens', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: '[bobsled,other]' });
    expect(tracker.matches({ name: '[bobsled' })).toBe(true);
  });

  it('rejects records whose field is an object, array, or null (silent type mismatch)', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: 'bobsled' });
    expect(tracker.matches({ name: { value: 'bobsled' } })).toBe(false);
    expect(tracker.matches({ name: ['bobsled'] })).toBe(false);
    expect(tracker.matches({ name: null })).toBe(false);
  });

  it('combines multiple filters with AND semantics', () => {
    const filters: RecordFilter[] = [
      repoNameFilter,
      { field: 'visibility', input: 'visibility', operator: 'in', delimiter: ',' },
    ];
    const tracker = RecordFilterTracker.from(filters, {
      repo_names: 'bobsled,demo-repo',
      visibility: 'private',
    });
    expect(tracker.matches({ name: 'bobsled', visibility: 'private' })).toBe(true);
    expect(tracker.matches({ name: 'bobsled', visibility: 'public' })).toBe(false);
    expect(tracker.matches({ name: 'bobsled-agents', visibility: 'private' })).toBe(false);
  });
});

describe('RecordFilterTracker.emptyResultWarning', () => {
  it('returns null when no filters are declared', () => {
    const tracker = RecordFilterTracker.from(undefined, {});
    expect(tracker.emptyResultWarning('repos', 1, 0)).toBeNull();
  });

  it('returns null when records were emitted', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: 'bobsled' });
    tracker.matches({ name: 'bobsled' });
    expect(tracker.emptyResultWarning('repos', 1, 1)).toBeNull();
  });

  it('returns null when no API calls were made (nothing to reject)', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: 'bobsled' });
    expect(tracker.emptyResultWarning('repos', 0, 0)).toBeNull();
  });

  it('returns the warning when every record returned by the API is rejected', () => {
    const tracker = RecordFilterTracker.from([repoNameFilter], { repo_names: 'bobsled' });
    expect(tracker.matches({ name: 'bobsled-agents' })).toBe(false);
    expect(tracker.matches({ name: 'demo-repo' })).toBe(false);
    const warning = tracker.emptyResultWarning('repos', 1, 0);
    expect(warning).toContain('Resource "repos" emitted 0 records');
    expect(warning).toContain('rejected 2 records');
    expect(warning).toContain('(repo_names)');
  });
});
