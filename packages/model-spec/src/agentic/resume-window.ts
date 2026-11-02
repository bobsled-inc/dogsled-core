import { validateAgenticReceipt } from './checkpoint-receipt.js';
import type { AgenticCheckpointCommand, AgenticRunSnapshot, AgenticStateSession } from './state.js';

/** One durable window per caller invocation, including uncertain checkpoint responses. */
export async function beginAgenticExecution(
  session: AgenticStateSession,
  snapshot: AgenticRunSnapshot,
  execution: {
    id: string;
    startedAt: string;
    retryFailed?: boolean;
    /** Spend-cap runs only: the caps this invocation applies. */
    caps?: { tokens: number | null; microusd: number | null };
  },
  validate = validateAgenticReceipt
): Promise<AgenticRunSnapshot> {
  if (snapshot.execution_windows?.some((window) => window.operation_id === execution.id)) {
    return snapshot;
  }
  const command: AgenticCheckpointCommand = {
    type: 'begin_execution',
    ...(execution.retryFailed ? { retry_failed: true as const } : {}),
    operation_id: execution.id,
    expected_revision: snapshot.revision,
    started_at: execution.startedAt,
    ...(execution.caps
      ? { token_limit: execution.caps.tokens, cost_limit_microusd: execution.caps.microusd }
      : {}),
  };
  const requestedAt = Date.now();
  try {
    return validate(await session.checkpoint(command), snapshot, command, requestedAt);
  } catch {
    return validate(await session.read(), snapshot, command, requestedAt);
  }
}
