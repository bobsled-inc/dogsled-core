import { PROTOCOL_VERSION } from '@bobsled-inc/protocol';
import type { ProtocolVersion } from '@bobsled-inc/protocol';
import type { ActivationErrorCode } from './retry.js';

export interface ActivationResult {
  entity_id: string;
  cluster_id: string | number;
  status: 'succeeded' | 'failed' | 'skipped';
  idempotency_key: string;
  action: string;
  sync_name: string;
  projection_ref: string;
  error?: {
    code: ActivationErrorCode;
    message: string;
    retryable: boolean;
  };
  duration_ms: number;
  attempted_at: string;
}

export interface ActivationRecord {
  entity_id: string;
  cluster_id: string | number;
  entity_trust_score: number;
  trust_tier: string;
  [key: string]: unknown;
}

interface ActivationRecordMessage {
  type: 'RECORD';
  _v: ProtocolVersion;
  stream: string;
  record: Record<string, unknown>;
  time_extracted: string;
}

interface ActivationMetricMessage {
  type: 'METRIC';
  _v: ProtocolVersion;
  stream: string;
  metrics: {
    activation_succeeded: number;
    activation_failed: number;
    activation_skipped: number;
    activation_total: number;
  };
  time: string;
}

export function emitActivationRecord(result: ActivationResult): void {
  const message: ActivationRecordMessage = {
    type: 'RECORD',
    _v: PROTOCOL_VERSION,
    stream: 'activation_results',
    record: {
      entity_id: result.entity_id,
      cluster_id: result.cluster_id,
      status: result.status,
      idempotency_key: result.idempotency_key,
      action: result.action,
      sync_name: result.sync_name,
      projection_ref: result.projection_ref,
      duration_ms: result.duration_ms,
      attempted_at: result.attempted_at,
      error_code: result.error?.code ?? null,
      error_message: result.error?.message ?? null,
    },
    time_extracted: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(message) + '\n');
}

export function emitActivationMetric(metric: {
  succeeded: number;
  failed: number;
  skipped: number;
  total: number;
  sync_name: string;
}): void {
  const message: ActivationMetricMessage = {
    type: 'METRIC',
    _v: PROTOCOL_VERSION,
    stream: `activation_results.${metric.sync_name}`,
    metrics: {
      activation_succeeded: metric.succeeded,
      activation_failed: metric.failed,
      activation_skipped: metric.skipped,
      activation_total: metric.total,
    },
    time: new Date().toISOString(),
  };
  process.stderr.write(JSON.stringify(message) + '\n');
}
