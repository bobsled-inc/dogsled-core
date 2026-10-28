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
        // Keep the overcharge for durable accounting even if it exceeds the limit.
        if (entry.reservation.tokens !== null && entry.charge > entry.reservation.tokens) {
          invalid = true;
        }
      } catch {
        invalid = true;
        throw new Error('Invalid token receipt');
      }
    },
  };
  return {
    budget,
    charged,
    valid: () => !invalid,
    close: () => {
      open = false;
    },
  };
}
