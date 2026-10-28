import { createHash } from 'node:crypto';

export interface IdempotencyKeyInput {
  action: string;
  targetRecordKey: string;
  projectionRef: string;
  namespace?: string;
}

/**
 * Deterministic idempotency key for an activation dispatch.
 * Same inputs always produce the same key; any field change produces a different key.
 */
export function computeIdempotencyKey(input: IdempotencyKeyInput): string {
  const payload = JSON.stringify([
    input.action,
    input.targetRecordKey,
    input.projectionRef,
    input.namespace ?? '',
  ]);
  return createHash('sha256').update(payload).digest('hex');
}
