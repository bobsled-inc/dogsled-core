import { z } from 'zod';
import { AgentAssignmentSchema, AgenticUsageSchema } from './assignment.js';
import { AgenticJsonSchema } from './rows.js';
import type { JsonValue } from '@bobsled-inc/protocol';
import type { AgentAssignment, AgentAssignmentOutcome, AgenticUsage } from './assignment.js';

export const AgenticTokenReservationSchema = z
  .object({
    id: z.string().min(1).max(1024),
    attempt_id: z.string().min(1).max(1024),
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();
export type AgenticTokenReservation = z.infer<typeof AgenticTokenReservationSchema>;

/** Host-owned, persisted accounting. Reserve before each call; settle errors too. */
export interface AgenticRunLimitAccess {
  reserve(tokens: number | null): Promise<AgenticTokenReservation>;
  settle(reservation: AgenticTokenReservation, usage: AgenticUsage): Promise<void>;
}
export const AgenticSourceRequestSchema = z
  .object({
    source: z.string().min(1).max(1024),
    operation: z.string().min(1).max(256),
    arguments: AgenticJsonSchema,
  })
  .strict();
export type AgenticSourceRequest = z.infer<typeof AgenticSourceRequestSchema>;
export type AgenticSourceAccess = (request: AgenticSourceRequest) => Promise<JsonValue>;

/** Trusted host adapter owns credentials, source mapping, argument checks and billing policy. */
export type AgenticSourceHost = (
  request: AgenticSourceRequest,
  context: { assignment: AgentAssignment; signal: AbortSignal }
) => Promise<JsonValue>;

const callback = <T extends (...args: never[]) => unknown>() =>
  z.custom<T>((value) => typeof value === 'function', 'A callable host implementation is required');
const runtime = {
  signal: z.instanceof(AbortSignal),
  budget: z
    .object({
      reserve: callback<AgenticRunLimitAccess['reserve']>(),
      settle: callback<AgenticRunLimitAccess['settle']>(),
    })
    .strict(),
};

/** Functions and AbortSignal stay in memory, outside the serializable assignment. */
export const AgentExecutorRequestSchema = z.union([
  z
    .object({
      assignment: AgentAssignmentSchema.and(z.object({ mode: z.literal('llm_call') })),
      ...runtime,
      sources: z.never().optional(),
    })
    .strict(),
  z
    .object({
      assignment: AgentAssignmentSchema.and(z.object({ mode: z.literal('agent_loop') })),
      ...runtime,
      sources: callback<AgenticSourceAccess>(),
    })
    .strict(),
]);

export type AgentExecutorRequest = z.infer<typeof AgentExecutorRequestSchema>;
export type ExecuteAgent = (request: AgentExecutorRequest) => Promise<AgentAssignmentOutcome>;

/** Unknown usage charges any finite reservation; its unknown status stays in the outcome. */
export function agenticChargeableTokens(
  reservation: AgenticTokenReservation,
  usage: AgenticUsage
): number {
  const held = AgenticTokenReservationSchema.parse(reservation);
  const receipt = AgenticUsageSchema.parse(usage);
  return receipt.status === 'measured' ? receipt.total_tokens : (held.tokens ?? 0);
}
