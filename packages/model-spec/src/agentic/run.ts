import { assignmentLimits, deadlineTime } from './limits.js';
import { beginAgenticCursor } from './begin-cursor.js';
import { planInputColumns } from './plan-work.js';
import { beginAgenticExecution } from './resume-window.js';
import { randomUUID } from 'node:crypto';
import { agenticDeadlineAt } from './execution-window.js';
import { bindAgenticTools, validateAgenticTools } from './tool-access.js';
import { executeAgenticPlan } from './plan-run.js';
import { preflightAgenticPublication, publishAgenticRun } from './publish-run.js';
import type { AgenticPublisher, AgenticHost } from './publication.js';
import { createAgenticReceiptValidator } from './checkpoint-receipt.js';
import { isCancellationError, runCancellable, throwIfCancelled } from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgentAssignmentSchema } from './assignment.js';
import { scheduleAgenticAssignments } from './schedule.js';
import {
  AGENTIC_MAX_BYTES,
  AGENTIC_MAX_ROWS,
  AgenticJsonSchema,
  createAgenticRowSchema,
} from './rows.js';
import {
  AgenticRunSnapshotSchema,
  AgenticRunKeySchema,
  AgenticStateError,
  digestAgenticState,
} from './state.js';
import type { AgenticStateStore, AgenticRunSnapshot, AgenticCheckpointCommand } from './state.js';
import { createLocalAgenticStateStore } from './local-state.js';
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
}
export interface AgenticExecutionResult {
  runId: string;
  deadlineAt: string | null;
  status: 'execution_complete';
  publication: 'pending' | 'confirmed';
  rows: JsonValue[];
  processedKeys: JsonValue[];
  chargedTokens: number;
  /** True when execution was already complete when this coordinator opened the run. */
  reusedCompletion: boolean;
}
async function boundary<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  try {
    return await runCancellable(signal, operation);
  } catch (error) {
    if (isCancellationError(error, signal)) throw error;
    throw new Error('Agentic host operation failed', { cause: error });
  }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isCancellationError(error)) throw error;
    if (error instanceof AgenticStateError) throw new AgenticStateError(error.code);
    throw new AgenticStateError('unavailable');
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
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await executeOwnedAgenticRun(host, context, options, execution);
    } catch (error) {
      throwIfCancelled(options.signal);
      if (!(error instanceof AgenticStateError) || error.code !== 'lease_lost' || attempt >= 2) {
        throw error;
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
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 64 ||
    !Number.isInteger(minDispatchIntervalMs) ||
    minDispatchIntervalMs < 0 ||
    minDispatchIntervalMs > 60_000 ||
    (host.tokensPerAssignment !== undefined &&
      (!Number.isSafeInteger(host.tokensPerAssignment) || host.tokensPerAssignment <= 0)) ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    (model.limits.timeout_seconds ?? 0) * 1000 > 2_147_483_647
  ) {
    throw new AgenticStateError('limit');
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
  const store = options.stateStore ?? createLocalAgenticStateStore(options.projectDirectory);
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
  const session = await storage(async () => store.acquire(key));
  const receipt = createAgenticReceiptValidator();
  let snapshot: AgenticRunSnapshot;
  try {
    const saved = await storage(async () => session.read());
    if (saved) {
      snapshot = await storage(async () => AgenticRunSnapshotSchema.parse(saved));
      if (snapshot.superseded) throw new AgenticStateError('superseded');
      if (
        digestAgenticState(snapshot.key) !== digestAgenticState(key) ||
        snapshot.identity !== identity
      ) {
        throw new AgenticStateError('conflict');
      }
    } else {
      if (options.run.mode === 'resume') throw new AgenticStateError('missing');
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
        max_attempts: maxAttempts,
        charged: 0,
        status: 'preparing',
        publication: 'pending',
        work: [],
      });
      const initial = snapshot;
      snapshot = await storage(async () => receipt(await session.create(initial), initial));
    }
    if (
      saved &&
      execution.reset &&
      snapshot.publication !== 'confirmed' &&
      (snapshot.status !== 'execution_complete' || options.publisher)
    ) {
      snapshot = await storage(async () =>
        beginAgenticExecution(session, snapshot, execution, receipt)
      );
    }
    const reportProgress = async () => {
      if (!options.onProgress) return;
      try {
        await options.onProgress(
          createAgenticProgress(
            snapshot,
            context.resolved.steps.map(({ step }) => step.id)
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
      throw new AgenticStateError('expired');
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
        snapshot = receipt(await session.checkpoint(command), before, command, requestedAt);
      } catch {
        // Confirm the complete effect after an uncertain response. Presence alone is not a receipt.
        const observed = await storage(async () => session.read());
        if (!observed) throw new AgenticStateError('missing');
        snapshot = receipt(observed, before, command, requestedAt);
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
      });
    } else if (snapshot.status === 'preparing') {
      const started = new Date(snapshot.started_at);
      const deadline = snapshot.deadline_at;
      const runId = key.id;
      const access: AgenticProbeContext = {
        ...context,
        signal: runSignal,
        maxRows: AGENTIC_MAX_ROWS,
        maxBytes: AGENTIC_MAX_BYTES,
      };
      const raw = await boundary(runSignal, async () => host.prepare(access));
      const retrievedAt = new Date().toISOString();
      throwIfCancelled(runSignal);
      const data = AgenticJsonSchema.parse(raw);
      if (!Array.isArray(data) || data.length > AGENTIC_MAX_ROWS) {
        throw new Error('Agentic preparation exceeds the bounded row limit');
      }
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
              ...assignmentLimits(model, step, host.tokensPerAssignment),
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
      processedKeys.push(...work.assignment.processed_keys);
      for (const row of accepted.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new AgenticStateError('corrupt');
        }
        const identity = JSON.stringify(model.grain.map((name) => row[name]));
        if (grain.has(identity)) throw new Error('Agentic output has duplicate final grain');
        grain.add(identity);
        findings.push({ ...row, _dogsled_run_id: key.id });
      }
      if (findings.length > AGENTIC_MAX_ROWS) throw new AgenticStateError('limit');
      AgenticJsonSchema.parse(findings);
    }
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
        cursorStore!.commit(cursorKey, cursorSignature, key.id, snapshot.cursor_values ?? {})
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
      reusedCompletion,
    };
  } catch (error) {
    if (session.ownershipLost?.aborted && !options.signal?.aborted) {
      throw new AgenticStateError('lease_lost');
    }
    throw error;
  } finally {
    await storage(async () => session.release());
  }
}
