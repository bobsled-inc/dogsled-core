import { RUN_SUMMARY_VERSION } from '@bobsled-inc/protocol';

import type { FieldCoverage, RunSummaryMessage } from '@bobsled-inc/protocol';
import type { FailureReason } from './errors.js';

export interface ResourceResult {
  resource: string;
  status: 'success' | 'error' | 'skipped' | 'circuit_breaker';
  records_emitted: number;
  api_calls: number;
  duration_ms: number;
  error?: string;
  error_code?: string;
  failure_reason?: FailureReason;
  cursor_value?: string;
  field_coverage?: Record<string, FieldCoverage>;
}

export function buildRunSummary(
  integration: string,
  startedAt: Date,
  results: ResourceResult[]
): RunSummaryMessage {
  const completedAt = new Date();
  const succeeded = results.filter((r) => r.status === 'success');
  const failed = results.filter((r) => r.status === 'error' || r.status === 'circuit_breaker');
  const skipped = results.filter((r) => r.status === 'skipped');

  let status: RunSummaryMessage['status'];
  if (failed.length === 0) status = 'success';
  else if (succeeded.length > 0) status = 'partial_success';
  else status = 'failure';

  const firstFailureReason = failed.find((r) => r.failure_reason)?.failure_reason;

  return {
    _v: RUN_SUMMARY_VERSION,
    type: 'RUN_SUMMARY',
    integration,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    elapsed_ms: completedAt.getTime() - startedAt.getTime(),
    status,
    ...(firstFailureReason ? { failure_reason: firstFailureReason } : {}),
    totals: {
      resources_total: results.length,
      resources_succeeded: succeeded.length,
      resources_failed: failed.length,
      resources_skipped: skipped.length,
      records_emitted: results.reduce((sum, r) => sum + r.records_emitted, 0),
      api_calls: results.reduce((sum, r) => sum + r.api_calls, 0),
    },
    resources: Object.fromEntries(
      results.map((r) => [
        r.resource,
        {
          status: r.status,
          records_emitted: r.records_emitted,
          api_calls: r.api_calls,
          duration_ms: r.duration_ms,
          ...(r.error ? { error: r.error } : {}),
          ...(r.error_code ? { error_code: r.error_code } : {}),
          ...(r.failure_reason ? { failure_reason: r.failure_reason } : {}),
          ...(r.cursor_value ? { cursor_value: r.cursor_value } : {}),
          ...(r.field_coverage ? { field_coverage: r.field_coverage } : {}),
        },
      ])
    ),
  };
}
