import type { AgenticCursorStore } from './cursor.js';
/** Immutable publication contracts. Runtime ownership stays outside saved state. */
import { z } from 'zod';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgenticRunKeySchema, digestAgenticState } from './state.js';
import type { AgenticRunSnapshot } from './state.js';
import type { AgenticProbeContext, ExperimentalAgenticProbe } from './probe.js';

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
    signal?: AbortSignal
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
            _dogsled_run_id: run.key.id,
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
