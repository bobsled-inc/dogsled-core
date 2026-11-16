import type { AgenticCursorStore } from './cursor.js';
/** Immutable publication contracts. Runtime ownership stays outside saved state. */
import { z } from 'zod';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgenticRunKeySchema, digestAgenticState } from './state.js';
import type { AgenticRunSnapshot } from './state.js';
import type { AgenticProbeContext, ExperimentalAgenticProbe } from './probe.js';
import { boundedAgenticRows } from './rows.js';
import { AgenticStateError } from './state-errors.js';
import {
  AGENTIC_DEFAULT_STORE_LIMITS,
  AGENTIC_MAX_STORE_LIMITS,
  type AgenticStoreLimits,
} from './store-limits.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const AgenticPublicationIdentitySchema = z
  .object({
    operation_id: Digest,
    run: z.lazy(() => AgenticRunKeySchema),
    definition_digest: Digest,
    target: z.string().min(1).max(1024),
    schema_digest: Digest,
    results_digest: Digest,
    processed_keys_digest: Digest,
  })
  .strict();
export const AgenticPublicationIntentSchema = z
  .object({
    identity: AgenticPublicationIdentitySchema,
    expected_version: Version,
    stage: z.string().regex(/^stage_[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (value) => value.stage === `stage_${value.identity.operation_id}`,
    'Stage must match the operation identity'
  );
export const AgenticPublicationReceiptSchema = z
  .object({
    intent: AgenticPublicationIntentSchema,
    committed_version: Version,
  })
  .strict()
  .refine(
    (value) => value.committed_version === value.intent.expected_version + 1,
    'Receipt must advance exactly one target version'
  );
export type AgenticPublicationIdentity = z.infer<typeof AgenticPublicationIdentitySchema>;
export type AgenticPublicationIntent = z.infer<typeof AgenticPublicationIntentSchema>;
export type AgenticPublicationReceipt = z.infer<typeof AgenticPublicationReceiptSchema>;
export type AgenticHost = Omit<ExperimentalAgenticProbe, 'publish'>;
export type AgenticPublicationContext = Omit<
  AgenticProbeContext,
  'signal' | 'maxRows' | 'maxBytes'
>;
type AgenticPublicationLimits = Readonly<Pick<AgenticStoreLimits, 'maxRows' | 'maxBatchBytes'>>;
export interface AgenticPublicationClaim {
  version: number;
  fence: string;
}
export interface AgenticPublisher {
  cursors?: AgenticCursorStore;
  preflight(context: AgenticPublicationContext, signal?: AbortSignal): Promise<void>;
  claim(target: string, signal?: AbortSignal): Promise<AgenticPublicationClaim>;
  prepare(
    context: AgenticPublicationContext,
    identity: AgenticPublicationIdentity,
    rows: readonly JsonValue[],
    processedKeys: readonly JsonValue[],
    claim: AgenticPublicationClaim,
    signal?: AbortSignal,
    /** The run's effective store bounds. Built-in publishers default to 1,000 rows and 1 MiB. */
    limits?: AgenticPublicationLimits
  ): Promise<AgenticPublicationIntent>;
  inspect(
    intent: AgenticPublicationIntent,
    signal?: AbortSignal
  ): Promise<AgenticPublicationReceipt | null>;
  commit(
    intent: AgenticPublicationIntent,
    claim: AgenticPublicationClaim,
    signal?: AbortSignal
  ): Promise<AgenticPublicationReceipt>;
  close(): Promise<void>;
}

/** Keep direct publisher calls within the same maximum bounds as coordinated runs. */
export function validateAgenticPublicationRows(
  rows: readonly JsonValue[],
  processedKeys: readonly JsonValue[],
  limits: AgenticPublicationLimits = AGENTIC_DEFAULT_STORE_LIMITS
): void {
  const { maxRows, maxBatchBytes } = limits;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > AGENTIC_MAX_STORE_LIMITS.maxRows ||
    !Number.isSafeInteger(maxBatchBytes) ||
    maxBatchBytes < 1 ||
    maxBatchBytes > AGENTIC_MAX_STORE_LIMITS.maxBatchBytes
  ) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_limits',
      message: 'Publication requires valid store row and byte limits.',
    });
  }
  const bounds = { maxRows, maxBatchBytes };
  boundedAgenticRows(rows, 'The rows to publish', bounds);
  boundedAgenticRows(processedKeys, 'The processed keys to publish', bounds);
}

export function agenticPublicationData(run: AgenticRunSnapshot): {
  rows: JsonValue[];
  processedKeys: JsonValue[];
} {
  const definition = run.definition as unknown as AgenticPublicationContext;
  const work = run.plan_inputs
    ? run.work.filter((item) => item.assignment.step_id === definition.resolved.model.output.from)
    : run.work;
  return {
    rows: work.flatMap((work) =>
      work.accepted && work.accepted.status !== 'failed'
        ? work.accepted.rows.map((row) => ({
            ...(row as Record<string, JsonValue>),
            _bobsled_run_id: run.key.id,
          }))
        : []
    ),
    processedKeys: work.flatMap((work) => work.assignment.processed_keys),
  };
}
export function createAgenticPublicationIdentity(
  run: AgenticRunSnapshot
): AgenticPublicationIdentity {
  if (run.status !== 'execution_complete') {
    throw new Error('Publication requires complete execution');
  }
  const definition = run.definition as unknown as AgenticPublicationContext;
  const data = agenticPublicationData(run);
  const fields = {
    run: run.key,
    definition_digest: run.identity,
    target: definition.target,
    schema_digest: digestAgenticState(definition.resolved.output_columns),
    results_digest: digestAgenticState(data.rows),
    processed_keys_digest: digestAgenticState(data.processedKeys),
  };
  return AgenticPublicationIdentitySchema.parse({
    ...fields,
    operation_id: digestAgenticState(fields),
  });
}
