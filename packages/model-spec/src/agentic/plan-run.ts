import { normalizeCursor, type AgenticCursorValues } from './cursor.js';
import { isCancellationError, runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import { AgenticJsonSchema, AGENTIC_MAX_BYTES, AGENTIC_MAX_ROWS } from './rows.js';
import type { AgenticProbeContext, ExperimentalAgenticProbe } from './probe.js';
import type { AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import { scheduleAgenticAssignments } from './schedule.js';
import {
  agenticPlanSourceAliases,
  buildAgenticStepAssignments,
  planInputColumns,
  validateAgenticPlanInputs,
} from './plan-work.js';
import type { PreparedPlanInput } from './plan-work.js';
import { AgenticHostError } from './errors.js';

export async function executeAgenticPlan(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  context: Omit<AgenticProbeContext, 'signal' | 'maxRows' | 'maxBytes'>,
  options: {
    snapshot: AgenticRunSnapshot;
    cursorValues?: AgenticCursorValues;
    checkpoint: (command: AgenticCheckpointCommand) => Promise<AgenticRunSnapshot>;
    signal: AbortSignal;
    abort: () => void;
    concurrency: number;
    minDispatchIntervalMs: number;
  }
): Promise<void> {
  let snapshot = options.snapshot;
  const checkpoint = async (command: AgenticCheckpointCommand) => {
    snapshot = await options.checkpoint(command);
    return snapshot;
  };
  if (snapshot.status === 'preparing') {
    const cursorValues: AgenticCursorValues = Object.assign(
      Object.create(null),
      options.cursorValues
    );
    const inputs: Record<string, PreparedPlanInput> = Object.create(null);
    // Freeze every external input before the first executor call, including roots
    // used only by later steps. A resumed plan never reads these sources again.
    for (const alias of agenticPlanSourceAliases(context.resolved)) {
      const ref = context.resolved.model.sources[alias]!.ref;
      const columns = planInputColumns(context.resolved, alias);
      const incremental = context.resolved.model.sources[alias]!.incremental;
      const cursorField = incremental?.cursor_field;
      const cursorType = columns.find((column) => column.name === cursorField)?.type;
      const lower = cursorValues[alias];
      const raw = await runCancellable(options.signal, () =>
        host.prepare({
          ...context,
          inputRef: ref,
          inputColumns: columns,
          ...(cursorField
            ? {
                incremental: {
                  cursor_field: cursorField,
                  ...(lower === undefined ? {} : { after: lower }),
                },
              }
            : {}),
          inputSql:
            context.inputSqlByRef?.[ref] ??
            (ref === context.inputRef ? context.inputSql : undefined),
          signal: options.signal,
          maxRows: AGENTIC_MAX_ROWS,
          maxBytes: AGENTIC_MAX_BYTES,
        })
      ).catch((error: unknown) => {
        if (isCancellationError(error, options.signal)) throw error;
        throw new AgenticHostError(`Agentic input preparation failed for source "${ref}".`, {
          cause: error,
        });
      });
      throwIfCancelled(options.signal);
      const rows = AgenticJsonSchema.parse(raw);
      if (!Array.isArray(rows) || rows.length > AGENTIC_MAX_ROWS) {
        throw new Error('Agentic plan input exceeds row limit');
      }
      const selected = cursorField
        ? rows.filter((row) => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
              throw new Error('Invalid incremental input row');
            }
            const value = normalizeCursor(row[cursorField], cursorType!);
            if (lower !== undefined && typeof value !== typeof lower) {
              throw new Error('Stored incremental cursor type differs from input');
            }
            if (lower !== undefined && value <= lower) {
              return false;
            }
            if (cursorValues[alias] === undefined || value > cursorValues[alias]!) {
              cursorValues[alias] = value;
            }
            return true;
          })
        : rows;
      inputs[alias] = { ref, columns, rows: selected, retrieved_at: new Date().toISOString() };
    }
    validateAgenticPlanInputs(context.resolved, inputs);
    await checkpoint({
      type: 'seal_work',
      operation_id: 'seal_work',
      expected_revision: snapshot.revision,
      assignments: [],
      plan_inputs: inputs,
      ...(options.cursorValues ? { cursor_values: cursorValues } : {}),
    });
  }
  const dispatchClock = { nextAt: 0 };
  for (let index = 0; index < context.resolved.steps.length; index++) {
    const step = context.resolved.steps[index]!.step;
    if (!snapshot.sealed_steps?.some((sealed) => sealed.id === step.id)) {
      throwIfCancelled(options.signal);
      await checkpoint({
        type: 'append_step',
        operation_id: `append_step:${step.id}`,
        expected_revision: snapshot.revision,
        step_id: step.id,
        assignments: buildAgenticStepAssignments(snapshot, index),
      });
    }
    await scheduleAgenticAssignments(host, { ...options, snapshot, checkpoint, dispatchClock });
  }
}
