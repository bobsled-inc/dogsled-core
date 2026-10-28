import { CommandError } from '@bobsled-inc/protocol';

import type { ModelExecutionResult, SupportedDialect } from '@bobsled-inc/model-spec';
import type { DecisionInputFormat } from '../compiler/identity/review-apply.js';
import { emitEntityGraphPayload, type EntityGraphOutputFormat } from './utils.js';

export interface ReviewApplyErrorDetail {
  path: string;
  message: string;
}

export interface ReviewApplyErrorPayload {
  valid: false;
  errorCode: string;
  errors: ReviewApplyErrorDetail[];
}

/** Per-statement execution details included in a review-apply receipt. */
export interface ReviewApplyStatementReceipt {
  name: string;
  sql: string;
  status?: ModelExecutionResult['status'];
  error?: string;
  rows_affected?: number;
}

/** Canonical machine-readable success receipt for `entity-graph review apply`. */
export interface ReviewApplyReceipt {
  command: 'review.apply';
  entity: string;
  dialect: SupportedDialect;
  schema: string;
  input_path: string;
  input_format: DecisionInputFormat;
  executed: boolean;
  decision_batch_id: string;
  content_hash: string;
  decision_source: 'human' | 'agent' | 'system';
  total_decisions: number;
  persisted_count: number | null;
  applied_count: number;
  merge_count: number;
  not_match_count: number;
  deferred_count: number;
  proposed_count: number;
  materialize_mode: 'none' | 'incremental';
  materialized_merge_count: number;
  statements: ReviewApplyStatementReceipt[];
}

/** Build a controlled review-apply error with a stable machine-readable payload. */
export function reviewApplyError(
  message: string,
  exitCode: 1 | 2,
  errorCode: string,
  errors: ReviewApplyErrorDetail[]
): CommandError {
  const payload: ReviewApplyErrorPayload = { valid: false, errorCode, errors };
  return new CommandError(message, exitCode, payload);
}

/** Emit the canonical apply receipt as JSON or YAML. */
export function emitReviewApplyStructured(
  format: EntityGraphOutputFormat,
  payload: ReviewApplyReceipt
): void {
  emitEntityGraphPayload(payload, format, () => '');
}
