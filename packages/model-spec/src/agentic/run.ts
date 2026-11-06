import { assignmentLimits, deadlineTime, type AgenticAccounting } from './limits.js';
import { beginAgenticCursor } from './begin-cursor.js';
import { planInputColumns } from './plan-work.js';
import { beginAgenticExecution } from './resume-window.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { agenticDeadlineAt } from './execution-window.js';
import { bindAgenticTools, validateAgenticTools } from './tool-access.js';
import { executeAgenticPlan } from './plan-run.js';
import { preflightAgenticPublication, publishAgenticRun } from './publish-run.js';
import type { AgenticPublisher, AgenticHost } from './publication.js';
import { validateAgenticReceipt } from './checkpoint-receipt.js';
import { isCancellationError, runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgentAssignmentSchema } from './assignment.js';
import { AgenticHostError } from './errors.js';
import { assertAgenticPricing } from './spend.js';
import { agenticDeadlinePassed, statementTimeoutReason } from './state-errors.js';
import { scheduleAgenticAssignments } from './schedule.js';
import { boundedAgenticRows, AgenticJsonSchema, createAgenticRowSchema } from './rows.js';
import { resolveAgenticStoreLimits } from './store-limits.js';
import {
  AgenticRunSnapshotSchema,
  AgenticRunKeySchema,
  AgenticStateError,
  digestAgenticState,
} from './state.js';
import type { AgenticStateStore, AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import { createDefaultAgenticStateStore } from './default-state.js';
import type { ExperimentalAgenticProbe, AgenticProbeContext } from './probe.js';
import { createAgenticProgress, type AgenticRunProgress } from './progress.js';

export interface AgenticRunOptions {
  /** Explicit resume only: retry saved terminal failures, retaining answers, charges and attempt counts. */
  retryFailedAssignments?: boolean;
  /** Best-effort observer of validated durable checkpoints. Keep callbacks brief. */
  onProgress?: (progress: AgenticRunProgress) => void | Promise<void>;
  cursorStore?: import('./cursor.js').AgenticCursorStore;
  run: { id: string; mode: 'start' | 'resume'; scope?: string };
  stateStore?: AgenticStateStore;
  /** Host executor and preparation capability for mixed model runs. */
  host?: AgenticHost;
  /** Durable publisher. Runtime methods are never saved in checkpoints. */
  publisher?: AgenticPublisher;
  /** Whole-assignment attempts, including interrupted attempts. Default: 3; maximum: 10. */
  maxAttempts?: number;
  /** Overrides `limits.max_cost_usd` for this invocation; `null` removes the cost cap. */
  maxCostUsd?: number | null;
  /**
   * @deprecated Creates new runs with the older per-attempt reservation accounting.
   * Saved runs always keep the accounting they started with.
   */
  accounting?: AgenticAccounting;
}
export interface AgenticExecutionResult {
  runId: string;
  deadlineAt: string | null;
  status: 'execution_complete';
  publication: 'pending' | 'confirmed';
  rows: JsonValue[];
  processedKeys: JsonValue[];
  chargedTokens: number;
  /** Incremental inputs with rows left for the next run; empty when the batch was complete. */
  remainingInput: string[];
  /** Priced spend in US dollars; null for runs saved with reservation accounting. */
  chargedUsd: number | null;
  /** True when execution was already complete when this coordinator opened the run. */
  reusedCompletion: boolean;
}
async function boundary<T>(
  signal: AbortSignal,
  description: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await runCancellable(signal, operation);
  } catch (error) {
    if (isCancellationError(error, signal)) throw error;
    throw new AgenticHostError(description, { cause: error });
  }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isCancellationError(error)) throw error;
    // State errors carry only safe text; other store errors are attached, never printed.
    if (error instanceof AgenticStateError) throw error;
    throw new AgenticStateError('unavailable', {}, { cause: error });
  }
}

export async function executeAgenticRun(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  context: Omit<AgenticProbeContext, 'signal' | 'maxRows' | 'maxBytes'>,
  options: AgenticRunOptions & { projectDirectory: string; signal?: AbortSignal }
): Promise<AgenticExecutionResult> {
  if (options.retryFailedAssignments && options.run.mode !== 'resume') {
    throw new AgenticStateError('conflict');
  }
  const execution = {
    id: randomUUID(),
    startedAt: new Date(Date.now()).toISOString(),
    reset: true,
    retryFailed: options.retryFailedAssignments,
  };
  // A new session must reload durable state; never reuse the expired coordinator.
  let timedOut: AgenticStateError | undefined;
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await executeOwnedAgenticRun(host, context, options, execution);
    } catch (error) {
      throwIfCancelled(options.signal);
      if (!(error instanceof AgenticStateError) || error.code !== 'lease_lost' || attempt >= 2) {
        // A session that cannot reacquire ownership must not hide why the run stopped.
        const unexplained =
          error instanceof AgenticStateError && error.code === 'unavailable' && !error.reason;
        throw timedOut && unexplained ? timedOut : error;
      }
      if (error.reason === statementTimeoutReason) timedOut = error;
      // A timed-out session keeps its lease, so a new one can only acquire after it expires.
      if (error.retryAfterMs) {
        await delay(
          error.retryAfterMs,
          undefined,
          options.signal && { signal: options.signal }
        ).catch((waiting: unknown) => {
          throwIfCancelled(options.signal);
          throw waiting;
        });
      }
    }
  }
}

async function executeOwnedAgenticRun(
  host: Omit<ExperimentalAgenticProbe, 'publish'>,
  context: Omit<AgenticProbeContext, 'signal' | 'maxRows' | 'maxBytes'>,
  options: AgenticRunOptions & { projectDirectory: string; signal?: AbortSignal },
  execution: { id: string; startedAt: string; reset: boolean; retryFailed?: boolean }
): Promise<AgenticExecutionResult> {
  throwIfCancelled(options.signal);
  if (!['start', 'resume'].includes(options.run.mode)) throw new AgenticStateError('conflict');
  context = bindAgenticTools(context, host.supportedTools);
  const { model } = context.resolved;
  validateAgenticTools(model, host.supportedTools);
  if (!options.publisher && (model.tests?.length || model.expect.length)) {
    throw new Error('Agentic execution does not support authored tests or expectations');
  }
  const maxAttempts = options.maxAttempts ?? 3;
  const concurrency = host.concurrency ?? 1;
  const minDispatchIntervalMs = host.minDispatchIntervalMs ?? 0;
  const invalidOption = (message: string): never => {
    throw new AgenticStateError('limit', { reason: 'invalid_option', message });
  };
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    invalidOption('Agent concurrency must be an integer from 1 to 64.');
  }
  if (
    !Number.isInteger(minDispatchIntervalMs) ||
    minDispatchIntervalMs < 0 ||
    minDispatchIntervalMs > 60_000
  ) {
    invalidOption('The minimum dispatch interval must be an integer from 0 to 60000 ms.');
  }
  if (
    host.tokensPerAssignment !== undefined &&
    (!Number.isSafeInteger(host.tokensPerAssignment) || host.tokensPerAssignment <= 0)
  ) {
    invalidOption('tokensPerAssignment must be a positive integer.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    invalidOption('maxAttempts must be an integer from 1 to 10.');
  }
  if ((model.limits.timeout_seconds ?? 0) * 1000 > 2_147_483_647) {
    invalidOption('limits.timeout_seconds must be at most 2147483.');
  }
  const resolved = context.resolved.steps[0]!;
  const step = resolved?.step;
  if (!step || context.resolved.steps.some((item) => item.step.skills?.length)) {
    throw new Error('Agentic execution does not support authored skills');
  }
  if (
    context.resolved.steps.some((item) => item.step.execution.mode === 'agent_loop') &&
    !host.sources
  ) {
    throw new Error('Agent loops require a scoped source host');
  }
  const key = AgenticRunKeySchema.parse({
    scope: options.run.scope ?? context.integration,
    model: model.name,
    id: options.run.id,
  });
  const definition = AgenticJsonSchema.parse(
    JSON.parse(
      JSON.stringify({ ...context, tokensPerAssignment: host.tokensPerAssignment, maxAttempts })
    )
  );
  const identity = digestAgenticState(definition);
  const comparable = digestAgenticState(comparableDefinition(definition));
  const costCapUsd =
    options.maxCostUsd !== undefined ? options.maxCostUsd : (model.limits.max_cost_usd ?? null);
  if (costCapUsd !== null && !(Number.isFinite(costCapUsd) && costCapUsd > 0)) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_option',
      message: 'The cost cap must be a positive number of US dollars.',
    });
  }
  const costCapMicrousd = costCapUsd === null ? null : Math.round(costCapUsd * 1_000_000);
  const store =
    options.stateStore ??
    createDefaultAgenticStateStore(
      options.projectDirectory,
      options.signal ? { signal: options.signal } : {}
    );
  const limits = resolveAgenticStoreLimits(store);
  const incremental = Object.values(model.sources).some((source) => source.incremental);
  const cursorStore =
    options.cursorStore ??
    (options.stateStore ? store.cursors : (options.publisher?.cursors ?? store.cursors));
  if (incremental && (!options.publisher || !cursorStore)) {
    throw new Error('Incremental agentic models require a durable publisher and cursor store');
  }
  const cursorKey = { scope: key.scope, model: key.model, target: context.target };
  const cursorSignature = digestAgenticState(
    Object.entries(model.sources)
      .filter(([, source]) => source.incremental)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([alias, source]) => [
        alias,
        source,
        planInputColumns(context.resolved, alias).find(
          (column) => column.name === source.incremental!.cursor_field
        )?.type,
      ])
  );
  // Validate the effective accounting before creating a run or starting a new window.
  const checkCostCap = (accounting: AgenticAccounting) => {
    if (costCapMicrousd === null) return;
    if (accounting !== 'spend_cap') {
      throw new AgenticStateError('limit', {
        reason: 'invalid_option',
        message: `Run "${key.id}" was saved with older token-reservation accounting, which has no cost cap.`,
        hint: 'Resume it without --agent-max-cost, or start a new run ID to use a cost cap.',
      });
    }
    assertAgenticPricing(context.resolved, host.priceUsage);
  };
  const session = await storage(async () => store.acquire(key));
  let snapshot: AgenticRunSnapshot;
  try {
    const saved = await storage(async () => session.read());
    if (saved) {
      snapshot = await storage(async () => {
        const parsed = AgenticRunSnapshotSchema.safeParse(saved);
        if (!parsed.success) {
          throw new AgenticStateError('corrupt', {
            reason: 'invalid_checkpoint',
            message: `The saved checkpoint for run "${key.id}" failed validation. It may be damaged or written by a different Dogsled version.`,
          });
        }
        return parsed.data;
      });
      if (snapshot.superseded) throw new AgenticStateError('superseded');
      if (
        digestAgenticState(snapshot.key) !== digestAgenticState(key) ||
        // Legacy runs keep their saved budget, so a changed cap must not pass silently.
        (snapshot.accounting === 'spend_cap'
          ? digestAgenticState(comparableDefinition(snapshot.definition)) !== comparable
          : snapshot.identity !== identity)
      ) {
        throw new AgenticStateError('conflict', {
          reason: 'definition_changed',
          message: `Run "${key.id}" was started with a different model definition, LLM profile, target, input schema, tool selection or attempt setting.`,
          hint: 'Restore the original definition to resume it, or start a new run ID.',
        });
      }
      // The saved accounting decides, not the caller's option; check before a new window.
      checkCostCap(snapshot.accounting ?? 'reservation');
    } else {
      if (options.run.mode === 'resume') {
        throw new AgenticStateError('missing', {
          reason: 'run_not_found',
          message: `No saved run "${key.id}" exists for model "${key.model}" in scope "${key.scope}".`,
          hint: 'Check the run ID, or start a new run without --agent-resume.',
        });
      }
      checkCostCap(options.accounting ?? 'spend_cap');
      execution.reset = false;
      const started = new Date();
      const deadline =
        model.limits.timeout_seconds == null
          ? null
          : new Date(started.getTime() + model.limits.timeout_seconds * 1000).toISOString();
      snapshot = AgenticRunSnapshotSchema.parse({
        version: 2,
        revision: 0,
        key,
        identity,
        definition,
        started_at: started.toISOString(),
        deadline_at: deadline,
        token_limit: model.limits.tokens ?? null,
        ...((options.accounting ?? 'spend_cap') === 'spend_cap'
          ? { accounting: 'spend_cap', cost_limit_microusd: costCapMicrousd, charged_microusd: 0 }
          : {}),
        max_attempts: maxAttempts,
        charged: 0,
        status: 'preparing',
        publication: 'pending',
        work: [],
      });
      const initial = snapshot;
      snapshot = await storage(async () =>
        validateAgenticReceipt(await session.create(initial), initial)
      );
    }
    if (
      saved &&
      execution.reset &&
      snapshot.publication !== 'confirmed' &&
      (snapshot.status !== 'execution_complete' || options.publisher)
    ) {
      snapshot = await storage(async () =>
        beginAgenticExecution(session, snapshot, {
          ...execution,
          ...(snapshot.accounting === 'spend_cap'
            ? { caps: { tokens: model.limits.tokens ?? null, microusd: costCapMicrousd } }
            : {}),
        })
      );
    }
    // Assignments never change once saved, so each estimate is computed once per run.
    const tokenEstimates = new Map<string, number>();
    const reportProgress = async () => {
      if (!options.onProgress) return;
      try {
        await options.onProgress(
          createAgenticProgress(
            snapshot,
            context.resolved.steps.map(({ step }) => step.id),
            tokenEstimates
          )
        );
      } catch {
        // Observability must not undo saved work or cause another model call.
      }
    };
    await reportProgress();
    const cursorValues =
      incremental && snapshot.publication !== 'confirmed'
        ? await storage(() =>
            beginAgenticCursor(
              cursorStore!,
              store,
              cursorKey,
              cursorSignature,
              key.id,
              options.run.mode === 'start' && snapshot.status === 'preparing',
              options.signal
            )
          )
        : undefined;
    const reusedCompletion = snapshot.status === 'execution_complete';
    const remaining = deadlineTime(agenticDeadlineAt(snapshot)) - Date.now();
    if (remaining <= 0 && !reusedCompletion) {
      throw agenticDeadlinePassed('before this invocation started');
    }
    const timeout = Number.isFinite(remaining)
      ? AbortSignal.timeout(Math.max(1, Math.min(remaining, 2_147_483_647)))
      : new AbortController().signal;
    const coordinator = new AbortController();
    const runSignal = AbortSignal.any([
      timeout,
      coordinator.signal,
      ...(session.ownershipLost ? [session.ownershipLost] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    if (options.publisher && !reusedCompletion) {
      await preflightAgenticPublication(options.publisher, session, snapshot, context, runSignal);
    }
    const checkpoint = async (command: AgenticCheckpointCommand): Promise<AgenticRunSnapshot> => {
      const before = snapshot;
      const requestedAt = Date.now();
      try {
        snapshot = validateAgenticReceipt(
          await session.checkpoint(command),
          before,
          command,
          requestedAt
        );
      } catch {
        // Confirm the complete effect after an uncertain response. Presence alone is not a receipt.
        const observed = await storage(async () => session.read());
        if (!observed) throw new AgenticStateError('missing');
        snapshot = validateAgenticReceipt(observed, before, command, requestedAt);
      }
      await reportProgress();
      return snapshot;
    };
    const planExecution = incremental || context.resolved.steps.length > 1 || !('map' in step);
    if (planExecution) {
      await executeAgenticPlan(host, context, {
        snapshot,
        ...(cursorValues ? { cursorValues } : {}),
        checkpoint,
        signal: runSignal,
        abort: () => coordinator.abort(),
        concurrency,
        minDispatchIntervalMs,
        limits,
      });
    } else if (snapshot.status === 'preparing') {
      const started = new Date(snapshot.started_at);
      const deadline = snapshot.deadline_at;
      const runId = key.id;
      const access: AgenticProbeContext = {
        ...context,
        signal: runSignal,
        maxRows: limits.maxRows,
        maxBytes: limits.maxBatchBytes,
      };
      const raw = await boundary(
        runSignal,
        `Agentic input preparation failed for "${context.inputRef}".`,
        async () => host.prepare(access)
      );
      const retrievedAt = new Date().toISOString();
      throwIfCancelled(runSignal);
      const data = boundedAgenticRows(raw, `Agentic input "${context.inputRef}"`, limits);
      const resolved = context.resolved.steps[0]!;
      const step = resolved.step;
      if (!('map' in step)) throw new Error('Agentic probe requires one map step');
      const inputSchema = createAgenticRowSchema(resolved.input_columns);
      const rows = data.map((row) => inputSchema.parse(row));
      const groupKeys = new Set<string>();
      const preparedKeys = new Set<string>();
      // Preflight the whole bounded batch before the first executor call.
      for (const row of rows) {
        const group = JSON.stringify(step.map.group_by.map((name) => row[name]));
        const key = JSON.stringify(model.materialization.keys.map((name) => row[name]));
        if (groupKeys.has(group) || preparedKeys.has(key)) {
          throw new Error(
            'Agentic probe requires one prepared row per unique group and replacement key'
          );
        }
        groupKeys.add(group);
        preparedKeys.add(key);
      }
      const work = rows
        .map((row, index) => {
          const attemptId = `${runId}:${index}:template`;
          return AgentAssignmentSchema.parse({
            contract_version: 2,
            model_name: model.name,
            run_id: runId,
            step_id: step.id,
            shard_id: String(index),
            attempt_id: attemptId,
            definition_ref: `state:${runId}`,
            input_snapshot_ref: `state:${runId}:input`,
            mode: step.execution.mode,
            ...(step.execution.tools ? { allowed_tools: step.execution.tools } : {}),
            ...(step.classification ? { classification: step.classification } : {}),
            instructions: step.instructions,
            skills: [],
            profile: resolved.profile,
            input: {
              ref: context.inputRef,
              retrieved_at: retrievedAt,
              columns: resolved.input_columns,
              rows: [row],
            },
            group_key: Object.fromEntries(step.map.group_by.map((name) => [name, row[name]])),
            processed_keys: [
              Object.fromEntries(model.materialization.keys.map((name) => [name, row[name]])),
            ],
            output: {
              columns: step.columns,
              grain: model.grain,
              replacement_keys: model.materialization.keys,
            },
            limits: {
              ...assignmentLimits(
                model,
                step,
                host.tokensPerAssignment,
                snapshot.accounting ?? 'reservation'
              ),
              started_at: started.toISOString(),
              deadline_at: deadline,
            },
            allowed_sources: resolved.allowed_sources.map((alias) => model.sources[alias]!.ref),
          });
        })
        .map((assignment) => ({ assignment, attempts: [] }));
      await checkpoint({
        type: 'seal_work',
        operation_id: 'seal_work',
        expected_revision: snapshot.revision,
        assignments: work.map((item) => item.assignment),
      });
    }
    await scheduleAgenticAssignments(host, {
      snapshot,
      checkpoint,
      signal: runSignal,
      abort: () => coordinator.abort(),
      concurrency,
      minDispatchIntervalMs,
    });
    if (!reusedCompletion) throwIfCancelled(runSignal);
    const findings: JsonValue[] = [];
    const processedKeys: JsonValue[] = [];
    const grain = new Set<string>();
    for (const work of snapshot.work.filter(
      (work) => !planExecution || work.assignment.step_id === model.output.from
    )) {
      const accepted = work.accepted;
      if (!accepted || accepted.status === 'failed') throw new AgenticStateError('corrupt');
      // Saved state is frozen. Hosts and publishers receive data of their own.
      processedKeys.push(...structuredClone(work.assignment.processed_keys));
      for (const row of accepted.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new AgenticStateError('corrupt');
        }
        const identity = JSON.stringify(model.grain.map((name) => row[name]));
        if (grain.has(identity)) throw new Error('Agentic output has duplicate final grain');
        grain.add(identity);
        findings.push({ ...structuredClone(row), _dogsled_run_id: key.id });
      }
    }
    boundedAgenticRows(findings, `The output of agentic model "${model.name}"`, limits);
    if (snapshot.status !== 'execution_complete') {
      await checkpoint({
        type: 'complete',
        operation_id: 'complete',
        expected_revision: snapshot.revision,
      });
    }
    if (options.publisher && snapshot.publication !== 'confirmed') {
      snapshot = await publishAgenticRun(
        options.publisher,
        session,
        snapshot,
        context,
        findings,
        processedKeys,
        checkpoint,
        runSignal,
        reusedCompletion,
        options.signal
      );
    }
    if (incremental && snapshot.publication === 'confirmed' && !snapshot.cursors_committed) {
      await storage(() =>
        cursorStore!.commit(
          cursorKey,
          cursorSignature,
          key.id,
          structuredClone(snapshot.cursor_values ?? {})
        )
      );
      await checkpoint({
        type: 'confirm_cursors',
        operation_id: 'confirm_cursors',
        expected_revision: snapshot.revision,
      });
    }
    throwIfCancelled(remaining > 0 ? runSignal : options.signal);
    return {
      runId: key.id,
      deadlineAt: agenticDeadlineAt(snapshot),
      status: 'execution_complete',
      publication: snapshot.publication === 'confirmed' ? 'confirmed' : 'pending',
      rows: findings,
      processedKeys,
      chargedTokens: snapshot.charged,
      // Read from the saved batch, so a resumed or already finished run reports it too.
      remainingInput: Object.values(snapshot.plan_inputs ?? {})
        .filter((input) => input.more)
        .map((input) => input.ref),
      chargedUsd:
        snapshot.accounting === 'spend_cap' ? (snapshot.charged_microusd ?? 0) / 1_000_000 : null,
      reusedCompletion,
    };
  } catch (error) {
    if (session.ownershipLost?.aborted && !options.signal?.aborted) {
      const cause = (session.ownershipLost.reason as { cause?: unknown } | null)?.cause;
      throw cause instanceof AgenticStateError && cause.code === 'lease_lost'
        ? cause
        : new AgenticStateError('lease_lost');
    }
    throw error;
  } finally {
    await storage(async () => session.release());
  }
}

/**
 * Spend caps and the deprecated per-assignment limits may change between invocations of
 * one run. Everything else, including the timeout, must match the saved definition.
 */
function comparableDefinition(definition: unknown): unknown {
  const copy = structuredClone(definition) as {
    tokensPerAssignment?: unknown;
    resolved?: {
      model?: { limits?: Record<string, unknown>; plan?: { steps?: { limits?: unknown }[] } };
      steps?: { step?: { limits?: unknown } }[];
    };
  };
  delete copy.tokensPerAssignment;
  const model = copy.resolved?.model;
  if (model?.limits) {
    model.limits =
      model.limits['timeout_seconds'] == null
        ? {}
        : { timeout_seconds: model.limits['timeout_seconds'] };
  }
  for (const step of model?.plan?.steps ?? []) delete step.limits;
  for (const resolved of copy.resolved?.steps ?? []) delete resolved.step?.limits;
  return copy;
}
