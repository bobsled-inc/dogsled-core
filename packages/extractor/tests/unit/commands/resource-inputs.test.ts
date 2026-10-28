import { describe, expect, it } from 'vitest';

import {
  mergeResourceInputs,
  parseResourceInputMatrixConcurrencyJson,
  parseResourceInputMatricesJson,
  validateResourceInputMatricesOverride,
  parseResourceInputsJson,
  validateResourceInputsOverride,
} from '../../../src/commands/resource-inputs.js';

describe('parseResourceInputMatricesJson', () => {
  it('preserves scalar tuple values', () => {
    expect(
      parseResourceInputMatricesJson(
        JSON.stringify({
          historical_outrights: [
            { tour: 'pga', year: 2025, archived: false },
            { tour: 'euro', year: 2024, archived: true },
          ],
        })
      )
    ).toEqual({
      historical_outrights: [
        { tour: 'pga', year: 2025, archived: false },
        { tour: 'euro', year: 2024, archived: true },
      ],
    });
  });

  it('rejects non-array matrix entries and non-scalar tuple values', () => {
    expect(() => parseResourceInputMatricesJson('{"issues": {}}')).toThrow(/array/);
    expect(() => parseResourceInputMatricesJson('{"issues":[{"labels":[]}]}')).toThrow(
      /string, finite number, or boolean/
    );
  });

  it('rejects an empty resource name', () => {
    expect(() => parseResourceInputMatricesJson('{"": [{"mode":"compact"}]}')).toThrow(
      /empty resource name/
    );
  });

  it('rejects empty tuples', () => {
    expect(() => parseResourceInputMatricesJson('{"issues":[{}]}')).toThrow(
      /must declare at least one input/
    );
  });
});

describe('parseResourceInputMatrixConcurrencyJson', () => {
  it('parses bounded per-resource concurrency values', () => {
    expect(parseResourceInputMatrixConcurrencyJson('{"issues": 4}')).toEqual({ issues: 4 });
  });

  it('rejects values outside the runner bound', () => {
    expect(() => parseResourceInputMatrixConcurrencyJson('{"issues": 0}')).toThrow(
      /between 1 and 64/
    );
    expect(() => parseResourceInputMatrixConcurrencyJson('{"issues": 1.5}')).toThrow(
      /safe integer/
    );
  });
});

describe('validateResourceInputMatricesOverride', () => {
  it('rejects tuple inputs not declared by the selected resource', () => {
    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{ unknown: 'value' }] }, [
        {
          name: 'issues',
          input: { mode: { type: 'string' } },
          extract: { incremental: { strategy: 'full_refresh' } },
        },
      ])
    ).toThrow(/unknown input.*unknown.*issues/i);
  });

  it('rejects empty tuples supplied through the programmatic boundary', () => {
    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{}] }, [
        {
          name: 'issues',
          input: { mode: { type: 'string' } },
          extract: { incremental: { strategy: 'full_refresh' } },
        },
      ])
    ).toThrow(/tuple 1 must declare at least one input/);
  });

  it('rejects incompatible tuple values and duplicate tuples', () => {
    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{ page_size: '50' }] }, [
        {
          name: 'issues',
          input: { page_size: { type: 'integer' } },
          extract: { incremental: { strategy: 'full_refresh' } },
        },
      ])
    ).toThrow(/incompatible.*issues\.page_size/i);

    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{ page_size: 50 }, { page_size: 50 }] }, [
        {
          name: 'issues',
          input: { page_size: { type: 'integer' } },
          extract: { incremental: { strategy: 'full_refresh' } },
        },
      ])
    ).toThrow(/duplicate normalized tuple/i);
  });

  it('allows matrices only on full-refresh resources', () => {
    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{ mode: 'compact' }] }, [
        {
          name: 'issues',
          input: { mode: { type: 'string' } },
          extract: { incremental: { strategy: 'cursor' } },
        },
      ])
    ).toThrow(/full_refresh/);

    expect(() =>
      validateResourceInputMatricesOverride({ issues: [{ mode: 'compact' }] }, [
        { name: 'issues', input: { mode: { type: 'string' } } },
      ])
    ).toThrow(/full_refresh/);
  });
});

describe('parseResourceInputsJson', () => {
  it('preserves arbitrary scalar delimiters and serializes supported values', () => {
    expect(
      parseResourceInputsJson(
        JSON.stringify({
          issues: {
            mode: 'extended: full=1,',
            page_size: 50,
            include_closed: true,
            labels: ['bug', 'chore'],
          },
        })
      )
    ).toEqual({
      issues: {
        mode: 'extended: full=1,',
        page_size: '50',
        include_closed: 'true',
        labels: '["bug","chore"]',
      },
    });
  });

  it('preserves commas inside JSON-encoded array entries', () => {
    expect(
      parseResourceInputsJson(JSON.stringify({ issues: { labels: ['has,comma', 'chore'] } }))
    ).toEqual({ issues: { labels: '["has,comma","chore"]' } });
  });

  it('treats prototype-control keys as ordinary input data', () => {
    const parsed = parseResourceInputsJson(
      '{"__proto__":{"constructor":"safe"},"issues":{"__proto__":"also-safe"}}'
    );

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed['issues'])).toBeNull();
    expect(parsed['__proto__']).toEqual(expect.objectContaining({ constructor: 'safe' }));
    expect(parsed['issues']?.['__proto__']).toBe('also-safe');
    expect({}.constructor).toBe(Object);
  });

  it.each([
    ['invalid JSON', '{', /not valid JSON/],
    ['non-object root', '[]', /must be a JSON object/],
    ['empty resource name', '{"":{"mode":"x"}}', /empty resource name/],
    ['non-object resource entry', '{"issues":null}', /must be an object/],
    ['empty input name', '{"issues":{"":"x"}}', /empty input name/],
    ['null scalar', '{"issues":{"mode":null}}', /received null/],
    ['nested object', '{"issues":{"mode":{"nested":true}}}', /received object/],
    ['null array entry', '{"issues":{"labels":["bug",null]}}', /array entries.*received null/],
  ])('rejects %s', (_label, value, expected) => {
    expect(() => parseResourceInputsJson(value)).toThrow(expected);
  });
});

describe('validateResourceInputsOverride', () => {
  it('rejects an input not declared by the selected resource', () => {
    expect(() =>
      validateResourceInputsOverride({ issues: { unknown: 'value' } }, [
        { name: 'issues', input: { mode: { type: 'string' } } },
      ])
    ).toThrow(/unknown input.*unknown.*issues/i);
  });

  it('rejects overrides for resources outside the selected run', () => {
    expect(() =>
      validateResourceInputsOverride({ pull_requests: { mode: 'compact' } }, [
        { name: 'issues', input: { mode: { type: 'string' } } },
      ])
    ).toThrow(/unknown or unselected resource "pull_requests"/);
  });
});

describe('mergeResourceInputs', () => {
  it('lets the named resource override pipeline defaults without leaking to siblings', () => {
    const defaults = { org: 'bobsled-inc', mode: 'default' };
    const overrides = {
      issues: { mode: 'issues_only' },
      pull_requests: { mode: 'prs_only' },
    };

    expect(mergeResourceInputs(defaults, overrides, 'issues')).toEqual({
      org: 'bobsled-inc',
      mode: 'issues_only',
    });
    expect(mergeResourceInputs(defaults, overrides, 'pull_requests')).toEqual({
      org: 'bobsled-inc',
      mode: 'prs_only',
    });
    expect(mergeResourceInputs(defaults, overrides, 'teams')).toBe(defaults);
  });
});
