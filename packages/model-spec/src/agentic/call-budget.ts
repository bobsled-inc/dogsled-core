import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '@bobsled-inc/connections';
import type { AgentAssignment, AgenticUsage } from './assignment.js';
import { AgenticUsageSchema } from './assignment.js';
import { agenticChargeableTokens, AgenticTokenReservationSchema } from './executor.js';
import type { AgenticRunLimitAccess, AgenticTokenReservation } from './executor.js';

/** Internal call receipts spend only the full assignment reservation already saved on disk. */
export function createAssignmentBudget(assignment: AgentAssignment, signal: AbortSignal) {
  const receipts = new Map<
    string,
    { reservation: AgenticTokenReservation; charge: number; settled?: string }
  >();
  let open = true;
  let invalid = false;
  let failure: string | undefined;
  const charged = () => [...receipts.values()].reduce((sum, receipt) => sum + receipt.charge, 0);
  const guard = () => {
    throwIfCancelled(signal);
    if (!open || invalid) throw new Error('Assignment budget is closed');
  };
  const budget: AgenticRunLimitAccess = {
    async reserve(tokens) {
      guard();
      if (
        (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) ||
        (assignment.mode === 'llm_call' && receipts.size > 0) ||
        (assignment.limits.tokens !== null &&
          (tokens === null || tokens > assignment.limits.tokens - charged())) ||
        (assignment.limits.model_calls != null && receipts.size >= assignment.limits.model_calls)
      ) {
        invalid = true;
        failure ??=
          tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)
            ? 'it reserved an invalid token amount'
            : assignment.mode === 'llm_call' && receipts.size > 0
              ? 'a direct llm_call made more than one model call'
              : assignment.limits.model_calls != null &&
                  receipts.size >= assignment.limits.model_calls
                ? `it exceeded ${assignment.limits.model_calls} model calls`
                : `it reserved more than the ${assignment.limits.tokens} tokens left for this assignment`;
        throw new Error('Assignment token limit exceeded');
      }
      const reservation = { id: randomUUID(), attempt_id: assignment.attempt_id, tokens };
      receipts.set(reservation.id, { reservation, charge: tokens ?? 0 });
      return { ...reservation };
    },
    async settle(receipt, usage: AgenticUsage) {
      // Settlement after cancellation still records known usage. It cannot start another call.
      if (!open || invalid) throw new Error('Assignment budget is closed');
      try {
        const parsed = AgenticTokenReservationSchema.parse(receipt);
        const entry = receipts.get(parsed.id);
        if (
          !entry ||
          parsed.attempt_id !== entry.reservation.attempt_id ||
          parsed.tokens !== entry.reservation.tokens
        ) {
          throw new Error('Foreign token reservation');
        }
        const report = AgenticUsageSchema.parse(usage);
        const fingerprint = JSON.stringify(report);
        if (entry.settled && entry.settled !== fingerprint) {
          throw new Error('Token usage already settled');
        }
        entry.settled = fingerprint;
        entry.charge = agenticChargeableTokens(entry.reservation, report);
        // Keep the overcharge for durable accounting even if it exceeds the limit. Without
        // an assignment cap an executor's own estimate may be low; usage is still charged.
        if (
          assignment.limits.tokens !== null &&
          entry.reservation.tokens !== null &&
          entry.charge > entry.reservation.tokens
        ) {
          invalid = true;
          failure ??= `a call used ${entry.charge} tokens but reserved ${entry.reservation.tokens}`;
        }
      } catch {
        invalid = true;
        failure ??= 'it settled an unknown, foreign or conflicting token receipt';
        throw new Error('Invalid token receipt');
      }
    },
  };
  return {
    budget,
    charged,
    valid: () => !invalid,
    failure: () => failure,
    close: () => {
      open = false;
    },
  };
}
