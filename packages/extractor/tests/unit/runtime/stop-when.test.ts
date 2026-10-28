import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { StopWhenSchema } from '../../../src/framework/extractor/stop-when.js';
import { ResourceSpecSchema } from '../../../src/framework/extractor/resource.js';
import { StopWhenTracker } from '../../../src/runtime/stop-when.js';
import { makeResource } from '../../helpers/fixtures.js';

const FIXED_NOW = new Date('2026-06-08T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StopWhenTracker', () => {
  it('returns undefined when no stop_when is declared', () => {
    expect(StopWhenTracker.from(undefined, FIXED_NOW)).toBeUndefined();
  });

  it('halts when every record on a non-empty page fails the predicate', () => {
    const tracker = StopWhenTracker.from(
      {
        field: 'last_edited_time',
        lt: '2026-01-01T00:00:00Z',
        requires_sort: { field: 'last_edited_time', direction: 'desc' },
      },
      FIXED_NOW
    )!;
    expect(
      tracker.shouldHalt([
        { last_edited_time: '2026-06-01T00:00:00Z' },
        { last_edited_time: '2026-05-01T00:00:00Z' },
      ])
    ).toBe(true);
  });

  it('does not halt when at least one record matches', () => {
    const tracker = StopWhenTracker.from(
      {
        field: 'last_edited_time',
        lt: '2026-01-01T00:00:00Z',
        requires_sort: { field: 'last_edited_time', direction: 'desc' },
      },
      FIXED_NOW
    )!;
    expect(
      tracker.shouldHalt([
        { last_edited_time: '2025-12-01T00:00:00Z' },
        { last_edited_time: '2026-05-01T00:00:00Z' },
      ])
    ).toBe(false);
  });

  it('does not halt on an empty page', () => {
    const tracker = StopWhenTracker.from(
      {
        field: 'last_edited_time',
        lt: '2026-01-01T00:00:00Z',
        requires_sort: { field: 'last_edited_time', direction: 'desc' },
      },
      FIXED_NOW
    )!;
    expect(tracker.shouldHalt([])).toBe(false);
  });

  it('resolves relative-duration cutoffs against the pinned now', () => {
    // Predicate `gte -6mo` means "record is still within the last 6 months".
    // For a desc-sorted feed, pagination eventually hits pages where every
    // record has fallen below the cutoff — all fail gte → halt.
    const tracker = StopWhenTracker.from(
      {
        field: 'last_edited_time',
        gte: '-6mo' as unknown as string,
        requires_sort: { field: 'last_edited_time', direction: 'desc' },
      },
      FIXED_NOW
    )!;
    // 2026-06-08 minus 6mo (~180d) ≈ 2025-12-10. A record from 2025-01-01
    // fails gte → halt. A record from 2026-04-01 passes → don't halt.
    expect(tracker.shouldHalt([{ last_edited_time: '2025-01-01T00:00:00Z' }])).toBe(true);
    expect(tracker.shouldHalt([{ last_edited_time: '2026-04-01T00:00:00Z' }])).toBe(false);
  });
});

describe('StopWhenSchema validation', () => {
  it('rejects multiple operators on a single stop_when', () => {
    const result = StopWhenSchema.safeParse({
      field: 'f',
      eq: 'x',
      lt: 'y',
      requires_sort: { field: 'f', direction: 'desc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects no operator declared', () => {
    const result = StopWhenSchema.safeParse({
      field: 'f',
      requires_sort: { field: 'f', direction: 'desc' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a single operator with requires_sort', () => {
    const result = StopWhenSchema.safeParse({
      field: 'last_edited_time',
      lt: '-6mo',
      requires_sort: { field: 'last_edited_time', direction: 'desc' },
    });
    expect(result.success).toBe(true);
  });
});

describe('resource schema cross-validates stop_when.requires_sort', () => {
  const sortedApi = {
    method: 'POST' as const,
    endpoint: '/v1/search',
    request_body: {
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
    },
  };
  const outputs = {
    last_edited_time: { type: 'timestamp' as const, path: '$.last_edited_time' },
    id: { type: 'string' as const, path: '$.id' },
  };

  it('passes when api.request_body references the sort field', () => {
    const result = ResourceSpecSchema.safeParse(
      makeResource({
        name: 'nt_pages',
        api: sortedApi,
        output: outputs,
        extract: {
          record_path: '$.results',
          stop_when: {
            field: 'last_edited_time',
            gte: '-6mo',
            requires_sort: { field: 'last_edited_time', direction: 'desc' },
          },
        } as unknown as Record<string, unknown>,
      })
    );
    // On failure vitest prints the boolean diff; attach the zod issues to the
    // assertion message so a debugging contributor doesn't have to re-run with
    // a print added back in.
    const failureDetail = result.success
      ? ''
      : JSON.stringify((result.error as z.ZodError).issues, null, 2);
    expect(result.success, failureDetail).toBe(true);
  });

  it('fails when api has no sort directive referencing the field', () => {
    const result = ResourceSpecSchema.safeParse(
      makeResource({
        name: 'nt_pages',
        api: { method: 'GET', endpoint: '/v1/things' },
        output: outputs,
        extract: {
          record_path: '$.results',
          stop_when: {
            field: 'last_edited_time',
            gte: '-6mo',
            requires_sort: { field: 'last_edited_time', direction: 'desc' },
          },
        } as unknown as Record<string, unknown>,
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = (result.error as z.ZodError).issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('requires_sort'))).toBe(true);
    }
  });

  it('fails when stop_when.requires_sort.field is not an output field', () => {
    const result = ResourceSpecSchema.safeParse(
      makeResource({
        name: 'nt_pages',
        api: sortedApi,
        output: outputs,
        extract: {
          record_path: '$.results',
          stop_when: {
            field: 'last_edited_time',
            gte: '-6mo',
            requires_sort: { field: 'not_in_output', direction: 'desc' },
          },
        } as unknown as Record<string, unknown>,
      })
    );
    expect(result.success).toBe(false);
  });

  it('passes when api references the source field name from output.path (snake_case vs camelCase)', () => {
    // Linear-style case found by e2e: output field is `updated_at` but the
    // GraphQL request_body uses `updatedAt` (the source leaf from
    // `output.updated_at.path: $.updatedAt`). The cross-check must consult
    // both names so legitimate sort declarations don't get flagged.
    const result = ResourceSpecSchema.safeParse(
      makeResource({
        name: 'issues_graphql',
        api: {
          method: 'POST' as const,
          endpoint: '/graphql',
          request_body: {
            query: 'query { issues(first: 50, orderBy: updatedAt) { nodes { id updatedAt } } }',
          },
        },
        output: {
          id: { type: 'string' as const, path: '$.id' },
          updated_at: { type: 'timestamp' as const, path: '$.updatedAt' },
        },
        extract: {
          record_path: '$.data.issues.nodes',
          stop_when: {
            field: 'updated_at',
            gte: '-30d',
            requires_sort: { field: 'updated_at', direction: 'desc' },
          },
        } as unknown as Record<string, unknown>,
      })
    );
    // On failure vitest prints the boolean diff; attach the zod issues to the
    // assertion message so a debugging contributor doesn't have to re-run with
    // a print added back in.
    const failureDetail = result.success
      ? ''
      : JSON.stringify((result.error as z.ZodError).issues, null, 2);
    expect(result.success, failureDetail).toBe(true);
  });
});
