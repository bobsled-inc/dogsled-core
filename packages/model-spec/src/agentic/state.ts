import { attemptReservation, deadlineTime } from './limits.js';
import { AgenticStateError, agenticDeadlinePassed } from './state-errors.js';
export { AgenticStateError, type AgenticStateErrorCode } from './state-errors.js';
import type { AgenticCursorStore } from './cursor.js';
import { CursorValuesSchema } from './cursor.js';
import type { AgenticStoreLimits } from './store-limits.js';
import {
  agenticDeadlineAt,
  agenticSpendCapError,
  agenticSpendCapReached,
  executionWindowsAfter,
  isAgenticFailureBlocked,
} from './execution-window.js';
import { applyPublicationCheckpoint } from './publication-checkpoint.js';
/** Versioned execution checkpoints. Stores apply commands atomically under exclusive ownership. */
import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { z } from 'zod';
import {
  AgenticPublicationIntentSchema,
  AgenticPublicationReceiptSchema,
  createAgenticPublicationIdentity,
} from './publication.js';
import { buildAgenticStepAssignments } from './plan-work.js';
import { AgenticColumnsSchema } from './model.js';
import { checkpointIsConsistent } from './checkpoint-consistency.js';
import { workMatchesRun } from './checkpoint-work.js';
import { isBoundedCheckpoint } from './checkpoint-json.js';
import { advanceVerifiedCheckpoint, parseVerifiedCheckpoint } from './checkpoint-verified.js';
import {
  AgentAssignmentSchema,
  AgentAssignmentOutcomeSchema,
  parseAttemptOutcome,
} from './assignment.js';
import { AgenticJsonSchema, AGENTIC_MAX_ROWS } from './rows.js';

const Identity = z.string().min(1).max(1024);
const Tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AgenticTokensSchema = Tokens;
export const AgenticRunKeySchema = z
  .object({ scope: Identity, model: Identity, id: Identity })
  .strict();
export type AgenticRunKey = z.infer<typeof AgenticRunKeySchema>;
export const AgenticAttemptStateSchema = z
  .object({
    id: Identity,
    start_revision: z.number().int().nonnegative(),
    finished_at: z.iso.datetime({ offset: true }).optional(),
    finish_revision: z.number().int().nonnegative().optional(),
    reservation: Tokens.nullable(),
    charge: Tokens,
    /** Spend-cap runs only: priced charge in millionths of a US dollar. */
    charge_microusd: Tokens.optional(),
    outcome: AgentAssignmentOutcomeSchema.optional(),
    finish_digest: z.string().length(64).optional(),
  })
  .strict();
export const AgenticWorkStateSchema = z
  .object({
    assignment: AgentAssignmentSchema,
    attempts: z.array(AgenticAttemptStateSchema).max(10),
    accepted: AgentAssignmentOutcomeSchema.optional(),
  })
  .strict();
/** A work item's mutable part: everything an attempt can change. */
export const AgenticWorkProgressSchema = AgenticWorkStateSchema.omit({ assignment: true });
const PlanInputsSchema = z
  .record(
    Identity,
    z
      .object({
        ref: Identity,
        retrieved_at: z.iso.datetime({ offset: true }),
        columns: AgenticColumnsSchema,
        rows: z.array(AgenticJsonSchema).max(AGENTIC_MAX_ROWS),
        // Set when the source had rows past this batch; a later run processes them.
        more: z.literal(true).optional(),
      })
      .strict()
  )
  .refine((inputs) => Object.keys(inputs).length <= 256);
const SnapshotObjectSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    key: AgenticRunKeySchema,
    identity: z.string().length(64),
    definition: AgenticJsonSchema,
    started_at: z.iso.datetime({ offset: true }),
    deadline_at: z.iso.datetime({ offset: true }).nullable(),
    execution_windows: z
      .array(
        z
          .object({
            operation_id: Identity,
            retry_failed: z.literal(true).optional(),
            status: z.enum(['preparing', 'running', 'execution_complete']),
            revision: z.number().int().nonnegative(),
            started_at: z.iso.datetime({ offset: true }),
            deadline_at: z.iso.datetime({ offset: true }).nullable(),
            // Spend-cap runs record the caps each invocation used, so a resume can raise them.
            token_limit: Tokens.nullable().optional(),
            cost_limit_microusd: Tokens.nullable().optional(),
          })
          .strict()
      )
      .max(1000)
      .optional(),
    /** Absent for runs saved with per-attempt reservation accounting. */
    accounting: z.literal('spend_cap').optional(),
    token_limit: Tokens.nullable(),
    cost_limit_microusd: Tokens.nullable().optional(),
    charged_microusd: Tokens.optional(),
    max_attempts: z.number().int().min(1).max(10),
    charged: Tokens,
    status: z.enum(['preparing', 'running', 'execution_complete']),
    publication: z.enum(['pending', 'prepared', 'confirmed']),
    publication_intent: z.lazy(() => AgenticPublicationIntentSchema).optional(),
    publication_receipt: z.lazy(() => AgenticPublicationReceiptSchema).optional(),
    plan_inputs: PlanInputsSchema.optional(),
    cursor_values: z.lazy(() => CursorValuesSchema).optional(),
    cursors_committed: z.literal(true).optional(),
    superseded: z.literal(true).optional(),
    sealed_steps: z
      .array(z.object({ id: Identity, revision: z.number().int().positive() }).strict())
      .max(256)
      .optional(),
    work: z.array(AgenticWorkStateSchema).max(AGENTIC_MAX_ROWS),
  })
  .strict()
  .superRefine((run, ctx) => {
    const invalid = (): void =>
      ctx.addIssue({ code: 'custom', message: 'Invalid execution checkpoint' });
    if (!checkpointIsConsistent(run)) invalid();
    if (run.superseded && run.publication !== 'pending') invalid();
    if (run.cursors_committed && (run.publication !== 'confirmed' || !run.cursor_values)) invalid();
    if (run.publication === 'pending') {
      if (run.publication_intent || run.publication_receipt) invalid();
    } else {
      if (run.status !== 'execution_complete' || !run.publication_intent) invalid();
      else if (
        digestAgenticState(run.publication_intent.identity) !==
        digestAgenticState(createAgenticPublicationIdentity(run))
      ) {
        invalid();
      }
      if (run.publication === 'prepared' && run.publication_receipt) invalid();
      if (
        run.publication === 'confirmed' &&
        (!run.publication_receipt ||
          digestAgenticState(run.publication_receipt.intent) !==
            digestAgenticState(run.publication_intent))
      ) {
        invalid();
      }
    }
    if (run.status === 'preparing' && run.work.length) invalid();
    if (digestAgenticState(run.definition) !== run.identity) invalid();
    if (deadlineTime(run.deadline_at) <= Date.parse(run.started_at)) invalid();
    if (
      run.charged !==
      run.work.reduce(
        (total, work) => total + work.attempts.reduce((sum, attempt) => sum + attempt.charge, 0),
        0
      )
    ) {
      invalid();
    }
    if (run.accounting === 'spend_cap') {
      if (
        run.charged_microusd !==
          run.work.reduce(
            (total, work) =>
              total + work.attempts.reduce((sum, item) => sum + (item.charge_microusd ?? 0), 0),
            0
          ) ||
        run.execution_windows?.some((window) => window.token_limit === undefined)
      ) {
        invalid();
      }
    } else if (
      run.charged_microusd !== undefined ||
      run.cost_limit_microusd !== undefined ||
      run.execution_windows?.some(
        (window) => window.token_limit !== undefined || window.cost_limit_microusd !== undefined
      )
    ) {
      invalid();
    }
    const ids = new Set<string>();
    for (const work of run.work) {
      if (ids.has(work.assignment.shard_id)) invalid();
      ids.add(work.assignment.shard_id);
      if (!workMatchesRun(run, work)) invalid();
    }
    if (run.status === 'execution_complete' && run.work.some((work) => !work.accepted)) invalid();
  });
export const AgenticRunSnapshotSchema = z
  .custom<unknown>(
    isBoundedCheckpoint,
    'The run checkpoint exceeds its limits of 16 MiB and 262,144 values; process fewer or smaller rows per run'
  )
  .pipe(SnapshotObjectSchema);
export type AgenticRunSnapshot = z.infer<typeof AgenticRunSnapshotSchema>;
const CommandObjectSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('supersede'),
      operation_id: z.literal('supersede'),
      expected_revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('begin_execution'),
      retry_failed: z.literal(true).optional(),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      started_at: z.iso.datetime({ offset: true }),
      token_limit: Tokens.nullable().optional(),
      cost_limit_microusd: Tokens.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prepare_publication'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      intent: z.lazy(() => AgenticPublicationIntentSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('confirm_publication'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      receipt: z.lazy(() => AgenticPublicationReceiptSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('confirm_cursors'),
      operation_id: z.literal('confirm_cursors'),
      expected_revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('seal_work'),
      operation_id: z.literal('seal_work'),
      expected_revision: z.number().int().nonnegative(),
      assignments: z.array(AgentAssignmentSchema).max(AGENTIC_MAX_ROWS),
      plan_inputs: PlanInputsSchema.optional(),
      cursor_values: z.lazy(() => CursorValuesSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('append_step'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      step_id: Identity,
      assignments: z.array(AgentAssignmentSchema).max(AGENTIC_MAX_ROWS),
    })
    .strict(),
  z
    .object({
      type: z.literal('start_attempt'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      work: z.number().int().nonnegative(),
      attempt_id: Identity,
      /** Spend-cap runs: estimated charge kept if the attempt never reports usage. */
      charge: Tokens.optional(),
      charge_microusd: Tokens.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('finish_attempt'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
      work: z.number().int().nonnegative(),
      attempt_id: Identity,
      outcome: AgentAssignmentOutcomeSchema,
      charge: Tokens,
      charge_microusd: Tokens.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('complete'),
      operation_id: Identity,
      expected_revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const AgenticCheckpointCommandSchema = z
  .custom<unknown>(isBoundedCheckpoint, 'Command exceeds bounded JSON limits')
  .pipe(CommandObjectSchema);
export type AgenticCheckpointCommand = z.infer<typeof AgenticCheckpointCommandSchema>;
/** The host must durably commit before resolving and fence every call after ownership is lost.
 * read() returns null only for a missing run, never for a storage failure.
 * create() is insert-only; checkpoint() applies applyAgenticCheckpoint atomically.
 * Duplicate commands return current state with the original effect preserved.
 * release() must not remove ownership acquired later by another coordinator.
 */
export interface AgenticStateSession {
  /** Aborts when this session can no longer prove ownership. */
  readonly ownershipLost?: AbortSignal;
  read(): Promise<AgenticRunSnapshot | null>;
  create(snapshot: AgenticRunSnapshot): Promise<AgenticRunSnapshot>;
  checkpoint(command: AgenticCheckpointCommand): Promise<AgenticRunSnapshot>;
  /**
   * Experimental. Applies `commands` in order, each with `applyAgenticCheckpoint`, and commits
   * them as one write: every command or none. A command's `expected_revision` is the revision the
   * one before it produces. A refusal of any command must leave the run unchanged. A coordinator
   * uses this, when it is present, to commit waiting starts and finishes together. A wrapper that
   * changes `checkpoint` must change this too, or leave it out.
   */
  checkpointMany?(commands: readonly AgenticCheckpointCommand[]): Promise<AgenticRunSnapshot>;
  release(): Promise<void>;
}
export interface AgenticStateStore {
  cursors?: AgenticCursorStore;
  /** What this store can hold. Omitted: the default limits. */
  limits?: AgenticStoreLimits;
  /** The store removes old runs, though never one with a publication, so a cursor reservation
   * can outlive its run. Takeover may then replace it instead of reporting the run missing. */
  expiresRuns?: boolean;
  acquire(key: AgenticRunKey): Promise<AgenticStateSession>;
}
/** Legacy finishes digest only outcome and charge; spend-cap finishes add their price. */
export function finishDigest(
  outcome: unknown,
  charge: number,
  chargeMicrousd: number | undefined
): string {
  return digestAgenticState(
    chargeMicrousd === undefined
      ? { outcome, charge }
      : { outcome, charge, charge_microusd: chargeMicrousd }
  );
}
export function digestAgenticState(value: unknown): string {
  return createHash('sha256')
    .update(canonicalize(value) ?? 'null')
    .digest('hex');
}

/**
 * Shared store conformance function: one accepted attempt, conservative charges, bounded retries.
 * The result is deeply frozen and holds none of the caller's objects. Pass it back to the next
 * call and return it from `checkpoint`: a start or finish of an attempt then costs what it changed.
 */
export function applyAgenticCheckpoint(
  value: AgenticRunSnapshot,
  input: AgenticCheckpointCommand,
  now = Date.now()
): AgenticRunSnapshot {
  const advanced = advanceVerifiedCheckpoint(value, input, now);
  if (advanced) return advanced;
  const state = AgenticRunSnapshotSchema.parse(value);
  transitionAgenticCheckpoint(state, input, now);
  return parseVerifiedCheckpoint(state);
}

/** The two questions a transition asks about the whole run. */
export interface AgenticRunLookups {
  hasOvercharge(): boolean;
  hasAttempt(attemptId: string): boolean;
}

export function isOverchargedAttempt(
  attempt: AgenticRunSnapshot['work'][number]['attempts'][number]
) {
  return attempt.reservation !== null && attempt.charge > attempt.reservation;
}

/** Applies a command to `state` in place and reports whether it changed. `state` must be an
 * unshared copy of AgenticRunSnapshotSchema output. A changed state is not yet validated. */
export function transitionAgenticCheckpoint(
  state: AgenticRunSnapshot,
  input: AgenticCheckpointCommand,
  now: number
): boolean {
  return applyParsedCommand(state, AgenticCheckpointCommandSchema.parse(input), now, {
    hasOvercharge: () => state.work.some((item) => item.attempts.some(isOverchargedAttempt)),
    hasAttempt: (attemptId) =>
      state.work.some((item) => item.attempts.some((attempt) => attempt.id === attemptId)),
  });
}

/** As transitionAgenticCheckpoint, for `command` already parsed. A start or finish of an attempt
 * writes only the run, its work item, that item's attempt list and its last attempt. */
export function applyParsedCommand(
  state: AgenticRunSnapshot,
  command: AgenticCheckpointCommand,
  now: number,
  lookups: AgenticRunLookups
): boolean {
  const conflict = (): never => {
    throw new AgenticStateError('conflict');
  };
  if (command.type === 'supersede') {
    if (state.superseded) return false;
    if (state.revision !== command.expected_revision || state.publication !== 'pending') {
      conflict();
    }
    state.superseded = true;
    state.revision++;
    return true;
  }
  if (state.superseded) throw new AgenticStateError('superseded');
  if (command.type === 'begin_execution') {
    const windows = state.execution_windows ?? [];
    const prior = windows.find((window) => window.operation_id === command.operation_id);
    if (prior) {
      if (
        prior.revision !== command.expected_revision ||
        prior.started_at !== command.started_at ||
        prior.retry_failed !== command.retry_failed ||
        prior.token_limit !== command.token_limit ||
        prior.cost_limit_microusd !== command.cost_limit_microusd
      ) {
        conflict();
      }
      return false;
    }
    if ((state.accounting === 'spend_cap') !== (command.token_limit !== undefined)) conflict();
    if (state.revision !== command.expected_revision || state.publication === 'confirmed') {
      conflict();
    }
    if (windows.length >= 1000) {
      throw new AgenticStateError('limit', {
        reason: 'too_many_resumes',
        message: 'This run has been resumed 1,000 times.',
        hint: 'Start a new run ID.',
      });
    }
    const started = Date.parse(command.started_at);
    if (started > now || started < Date.parse(windows.at(-1)?.started_at ?? state.started_at)) {
      conflict();
    }
    const duration = deadlineTime(state.deadline_at) - Date.parse(state.started_at);
    state.execution_windows = [
      ...windows,
      {
        operation_id: command.operation_id,
        ...(command.retry_failed ? { retry_failed: true as const } : {}),
        status: state.status,
        revision: state.revision,
        started_at: command.started_at,
        deadline_at: Number.isFinite(duration) ? new Date(started + duration).toISOString() : null,
        ...(command.token_limit !== undefined
          ? {
              token_limit: command.token_limit,
              cost_limit_microusd: command.cost_limit_microusd ?? null,
            }
          : {}),
      },
    ];
    state.revision++;
    return true;
  }
  if (command.type === 'prepare_publication' || command.type === 'confirm_publication') {
    return applyPublicationCheckpoint(state, command);
  }
  if (command.type === 'confirm_cursors') {
    if (state.publication !== 'confirmed' || !state.cursor_values) conflict();
    if (state.cursors_committed) return false;
    if (command.expected_revision !== state.revision) conflict();
    state.cursors_committed = true;
    state.revision++;
    return true;
  }
  if (command.type === 'seal_work') {
    if (command.plan_inputs && command.assignments.length) {
      conflict();
    }
    if (state.status !== 'preparing') {
      const preparationRevision =
        state.execution_windows?.filter((window) => window.status === 'preparing').length ?? 0;
      if (command.expected_revision !== preparationRevision) conflict();
      if (
        digestAgenticState(state.plan_inputs) !== digestAgenticState(command.plan_inputs) ||
        digestAgenticState(state.cursor_values) !== digestAgenticState(command.cursor_values) ||
        (!command.plan_inputs &&
          digestAgenticState(state.work.map((item) => item.assignment)) !==
            digestAgenticState(command.assignments))
      ) {
        conflict();
      }
      return false;
    }
    if (command.expected_revision !== state.revision) conflict();
    if (now >= deadlineTime(agenticDeadlineAt(state))) {
      throw agenticDeadlinePassed('before the input batch was sealed');
    }
    if (command.plan_inputs) {
      state.plan_inputs = command.plan_inputs;
      state.sealed_steps = [];
    }
    if (command.cursor_values) state.cursor_values = command.cursor_values;
    state.work = command.assignments.map((assignment) => ({ assignment, attempts: [] }));
    state.status = 'running';
    state.revision++;
    return true;
  }
  if (command.type === 'append_step') {
    if (
      !state.plan_inputs ||
      !state.sealed_steps ||
      command.operation_id !== `append_step:${command.step_id}`
    ) {
      conflict();
    }
    const prior = state.sealed_steps!.find((step) => step.id === command.step_id);
    if (prior) {
      if (
        prior.revision !== command.expected_revision ||
        digestAgenticState(
          state.work
            .filter((work) => work.assignment.step_id === command.step_id)
            .map((work) => work.assignment)
        ) !== digestAgenticState(command.assignments)
      ) {
        conflict();
      }
      return false;
    }
    if (state.status !== 'running' || command.expected_revision !== state.revision) conflict();
    if (now >= deadlineTime(agenticDeadlineAt(state))) {
      throw agenticDeadlinePassed('before the next plan step');
    }
    let expected;
    try {
      expected = buildAgenticStepAssignments(state, state.sealed_steps!.length);
    } catch {
      return conflict();
    }
    if (
      expected.some((assignment) => assignment.step_id !== command.step_id) ||
      digestAgenticState(expected) !== digestAgenticState(command.assignments)
    ) {
      conflict();
    }
    state.sealed_steps!.push({ id: command.step_id, revision: state.revision });
    state.work.push(...command.assignments.map((assignment) => ({ assignment, attempts: [] })));
    state.revision++;
    return true;
  }
  const work = 'work' in command ? state.work[command.work] : undefined;
  if (command.type === 'complete') {
    if (command.operation_id !== 'complete') conflict();
    if (state.status === 'execution_complete') {
      const publications =
        state.publication === 'confirmed' ? 2 : state.publication === 'prepared' ? 1 : 0;
      if (
        command.expected_revision !==
        state.revision - 1 - publications - executionWindowsAfter(state, command.expected_revision)
      ) {
        conflict();
      }
      return false;
    }
  } else {
    if (!work || command.operation_id !== `${command.type}:${command.attempt_id}`) conflict();
    const prior = work!.attempts.find((attempt) => attempt.id === command.attempt_id);
    if (command.type === 'start_attempt' && prior) {
      if (command.expected_revision !== prior.start_revision) conflict();
      return false;
    }
    if (command.type === 'finish_attempt' && prior?.finish_digest) {
      if (command.expected_revision !== prior.finish_revision) conflict();
      if (
        prior.finish_digest !==
        finishDigest(command.outcome, command.charge, command.charge_microusd)
      ) {
        conflict();
      }
      return false;
    }
  }
  if (command.expected_revision !== state.revision || state.status !== 'running') conflict();
  if (command.type === 'complete') {
    if (state.work.some((item) => !item.accepted)) conflict();
    if (now >= deadlineTime(agenticDeadlineAt(state))) {
      throw agenticDeadlinePassed('before the run completed');
    }
    state.status = 'execution_complete';
  } else if (command.type === 'start_attempt') {
    if (work!.accepted) conflict();
    const previous = work!.attempts.at(-1);
    if (isAgenticFailureBlocked(state, previous)) conflict();
    const spendCap = state.accounting === 'spend_cap';
    if ((command.charge !== undefined || command.charge_microusd !== undefined) && !spendCap) {
      conflict();
    }
    if (!spendCap && lookups.hasOvercharge()) {
      throw new AgenticStateError('limit', {
        reason: 'assignment_overcharged',
        message: 'An earlier attempt reported more token usage than it reserved.',
        hint: 'This run uses the older reservation accounting and cannot continue. Start a new run ID.',
      });
    }
    if (now >= deadlineTime(agenticDeadlineAt(state))) {
      throw agenticDeadlinePassed('before the next assignment started');
    }
    if (work!.attempts.length >= state.max_attempts) {
      throw new AgenticStateError('limit', {
        reason: 'attempts_exhausted',
        message: `Assignment ${work!.assignment.shard_id} of step "${work!.assignment.step_id}" has used all ${state.max_attempts} attempts.`,
      });
    }
    if (spendCap) {
      if (agenticSpendCapReached(state)) throw agenticSpendCapError(state);
    } else if (
      state.token_limit !== null &&
      (state.charged >= state.token_limit ||
        state.charged + (work!.assignment.limits.tokens ?? 0) > state.token_limit)
    ) {
      throw new AgenticStateError('limit', {
        reason: 'token_budget_exhausted',
        message: `The run token budget (limits.tokens: ${state.token_limit}) has no room for another attempt; ${state.charged} tokens are charged.`,
      });
    }
    if (lookups.hasAttempt(command.attempt_id)) conflict();
    if (spendCap) {
      // Charge an estimate now so an interrupted attempt still counts toward the cap.
      const charge = command.charge ?? 0;
      const microusd = command.charge_microusd ?? 0;
      work!.attempts.push({
        id: command.attempt_id,
        start_revision: command.expected_revision,
        reservation: null,
        charge,
        charge_microusd: microusd,
      });
      state.charged += charge;
      state.charged_microusd = (state.charged_microusd ?? 0) + microusd;
    } else {
      const tokens = attemptReservation(
        work!.assignment.limits.tokens,
        state.token_limit,
        state.charged
      );
      work!.attempts.push({
        id: command.attempt_id,
        start_revision: command.expected_revision,
        reservation: tokens,
        charge: tokens ?? 0,
      });
      state.charged += tokens ?? 0;
    }
  } else {
    const attempt = work!.attempts.at(-1);
    if (!attempt || attempt.id !== command.attempt_id || work!.accepted) {
      throw new AgenticStateError('conflict');
    }
    const spendCap = state.accounting === 'spend_cap';
    if (spendCap !== (command.charge_microusd !== undefined)) conflict();
    const outcome = parseAttemptOutcome(work!.assignment, attempt.id, command.outcome);
    const minimum =
      outcome.usage.status === 'measured' ? outcome.usage.total_tokens : (attempt.reservation ?? 0);
    if (command.charge < minimum) conflict();
    state.charged += command.charge - attempt.charge;
    attempt.charge = command.charge;
    if (spendCap) {
      state.charged_microusd =
        (state.charged_microusd ?? 0) + command.charge_microusd! - (attempt.charge_microusd ?? 0);
      attempt.charge_microusd = command.charge_microusd!;
    }
    attempt.finish_revision = command.expected_revision;
    attempt.finished_at = new Date(now).toISOString();
    attempt.outcome = outcome;
    attempt.finish_digest = finishDigest(outcome, command.charge, command.charge_microusd);
    // Spend-cap runs keep every valid answer that was paid for; caps only stop new dispatch.
    if (
      outcome.status !== 'failed' &&
      (spendCap ||
        ((attempt.reservation === null || command.charge <= attempt.reservation) &&
          (state.token_limit === null || state.charged <= state.token_limit) &&
          now < deadlineTime(agenticDeadlineAt(state, attempt.start_revision))))
    ) {
      work!.accepted = outcome;
    }
  }
  state.revision++;
  return true;
}
