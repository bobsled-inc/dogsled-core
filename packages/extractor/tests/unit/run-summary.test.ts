import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUN_SUMMARY_VERSION } from '@bobsled-inc/protocol';
import { buildRunSummary } from '../../src/runtime/run-summary.js';

describe('buildRunSummary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a versioned success summary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:05:00.000Z'));

    const summary = buildRunSummary('github', new Date('2026-04-15T16:00:00.000Z'), [
      {
        resource: 'issues',
        status: 'success',
        records_emitted: 3,
        api_calls: 2,
        duration_ms: 120,
        cursor_value: '2026-04-15T16:00:00.000Z',
      },
      {
        resource: 'pull_requests',
        status: 'skipped',
        records_emitted: 0,
        api_calls: 0,
        duration_ms: 5,
      },
    ]);

    expect(summary).toEqual({
      _v: RUN_SUMMARY_VERSION,
      type: 'RUN_SUMMARY',
      integration: 'github',
      started_at: '2026-04-15T16:00:00.000Z',
      completed_at: '2026-04-15T16:05:00.000Z',
      elapsed_ms: 300000,
      status: 'success',
      totals: {
        resources_total: 2,
        resources_succeeded: 1,
        resources_failed: 0,
        resources_skipped: 1,
        records_emitted: 3,
        api_calls: 2,
      },
      resources: {
        issues: {
          status: 'success',
          records_emitted: 3,
          api_calls: 2,
          duration_ms: 120,
          cursor_value: '2026-04-15T16:00:00.000Z',
        },
        pull_requests: {
          status: 'skipped',
          records_emitted: 0,
          api_calls: 0,
          duration_ms: 5,
        },
      },
    });

    vi.useRealTimers();
  });

  it('surfaces partial_success and the first failure reason', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:02:00.000Z'));

    const summary = buildRunSummary('github', new Date('2026-04-15T16:00:00.000Z'), [
      {
        resource: 'issues',
        status: 'success',
        records_emitted: 5,
        api_calls: 2,
        duration_ms: 100,
      },
      {
        resource: 'audit_logs',
        status: 'error',
        records_emitted: 0,
        api_calls: 1,
        duration_ms: 80,
        error: 'boom',
        failure_reason: 'rate_limit_exhausted',
      },
    ]);

    expect(summary.status).toBe('partial_success');
    expect(summary.failure_reason).toBe('rate_limit_exhausted');
    expect(summary.resources['audit_logs']).toMatchObject({
      status: 'error',
      error: 'boom',
      failure_reason: 'rate_limit_exhausted',
    });

    vi.useRealTimers();
  });

  it('carries per-output-field coverage into the resource entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:01:00.000Z'));

    const summary = buildRunSummary('notion', new Date('2026-04-15T16:00:00.000Z'), [
      {
        resource: 'blocks',
        status: 'success',
        records_emitted: 4,
        api_calls: 1,
        duration_ms: 60,
        field_coverage: {
          id: { matched: 4, total: 4 },
          rich_text: { matched: 0, total: 4 },
        },
      },
    ]);

    expect(summary.resources['blocks']).toMatchObject({
      status: 'success',
      field_coverage: {
        id: { matched: 4, total: 4 },
        rich_text: { matched: 0, total: 4 },
      },
    });

    vi.useRealTimers();
  });

  it('carries the runtime error code into the resource entry', () => {
    const summary = buildRunSummary('sftp', new Date(), [
      {
        resource: 'events',
        status: 'error',
        records_emitted: 0,
        api_calls: 0,
        duration_ms: 5,
        error: 'The provider could not complete the operation.',
        error_code: 'SFTP_CONNECTION_LOST',
        failure_reason: 'transient_error',
      },
    ]);
    expect(summary.resources.events).toMatchObject({ error_code: 'SFTP_CONNECTION_LOST' });
  });

  it('omits field_coverage when none is reported', () => {
    const summary = buildRunSummary('github', new Date('2026-04-15T16:00:00.000Z'), [
      { resource: 'issues', status: 'success', records_emitted: 1, api_calls: 1, duration_ms: 10 },
    ]);
    expect(summary.resources['issues']).not.toHaveProperty('field_coverage');
  });

  it('reports failure when every attempted resource fails', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T16:03:00.000Z'));

    const summary = buildRunSummary('github', new Date('2026-04-15T16:00:00.000Z'), [
      {
        resource: 'issues',
        status: 'error',
        records_emitted: 0,
        api_calls: 1,
        duration_ms: 50,
        error: 'boom',
        failure_reason: 'transient_error',
      },
      {
        resource: 'audit_logs',
        status: 'circuit_breaker',
        records_emitted: 0,
        api_calls: 0,
        duration_ms: 5,
        failure_reason: 'circuit_breaker',
      },
    ]);

    expect(summary.status).toBe('failure');
    expect(summary.failure_reason).toBe('transient_error');
    expect(summary.totals).toMatchObject({
      resources_total: 2,
      resources_succeeded: 0,
      resources_failed: 2,
      resources_skipped: 0,
    });

    vi.useRealTimers();
  });
});
