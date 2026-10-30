import { assignmentLimits, deadlineTime, attemptReservation } from './limits.js';
import { agenticDeadlineAt, isAgenticFailureBlocked } from './execution-window.js';
import { buildAgenticStepAssignments } from './plan-work.js';
import { createAgenticRowSchema } from './rows.js';
import { z } from 'zod';
import {
  getAgenticContextSources,
  AgenticModelSpecSchema,
  AgenticColumnsSchema,
  AGENTIC_METADATA_COLUMNS,
} from './model.js';
import { AgenticProfileSchema } from './resolve.js';
import { digestAgenticState } from './state.js';
import type { AgenticRunSnapshot } from './state.js';

const DefinitionSchema = z.object({
  resolved: z.object({
    model: AgenticModelSpecSchema,
    output_columns: AgenticColumnsSchema,
    steps: z
      .array(
        z.object({
          step: z.unknown(),
          allowed_sources: z.array(z.string()),
          input_columns: AgenticColumnsSchema,
          input_schemas: z.record(z.string(), AgenticColumnsSchema).optional(),
          profile: AgenticProfileSchema,
        })
      )
      .min(1),
  }),
  inputRef: z.string().optional(),
  tokensPerAssignment: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).max(10),
});

/** Check the relationships that independent field schemas cannot establish. */
export function checkpointIsConsistent(run: AgenticRunSnapshot): boolean {
  const parsed = DefinitionSchema.safeParse(run.definition);
  if (!parsed.success) return false;
  const definition = parsed.data;
  const model = definition.resolved.model;
  const spendCap = run.accounting === 'spend_cap';
  const step = model.plan.steps[0];
  if (
    !step ||
    (!run.plan_inputs &&
      run.status !== 'preparing' &&
      (model.plan.steps.length !== 1 || !('map' in step)))
  ) {
    return false;
  }
  if (
    run.token_limit !== (model.limits.tokens ?? null) ||
    run.max_attempts !== definition.maxAttempts ||
    run.key.model !== model.name ||
    (model.limits.timeout_seconds == null
      ? run.deadline_at !== null
      : deadlineTime(run.deadline_at) - Date.parse(run.started_at) !==
        model.limits.timeout_seconds * 1000)
  ) {
    return false;
  }
  if (definition.resolved.steps.length !== model.plan.steps.length) return false;
  const output = model.plan.steps.find((step) => step.id === model.output.from)!;
  if (
    digestAgenticState(definition.resolved.output_columns) !==
    digestAgenticState([...output.columns, ...AGENTIC_METADATA_COLUMNS])
  ) {
    return false;
  }
  for (const [index, resolved] of definition.resolved.steps.entries()) {
    const authored = model.plan.steps[index]!;
    const allowed =
      authored.execution.mode === 'llm_call'
        ? []
        : (getAgenticContextSources(authored) ?? Object.keys(model.sources));
    if (
      digestAgenticState(resolved.step) !== digestAgenticState(authored) ||
      digestAgenticState(resolved.allowed_sources) !== digestAgenticState(allowed)
    ) {
      return false;
    }
  }
  if ((run.plan_inputs === undefined) !== (run.sealed_steps === undefined)) return false;
  const revisions = new Set<number>();
  const windowIds = new Set<string>();
  const phases = ['preparing', 'running', 'execution_complete'];
  let priorPhase = 0;
  const preparationRevision =
    run.execution_windows?.filter((window) => window.status === 'preparing').length ?? 0;
  let priorWindowRevision = -1;
  let priorWindowStart = Date.parse(run.started_at);
  for (const window of run.execution_windows ?? []) {
    const started = Date.parse(window.started_at);
    const phase = phases.indexOf(window.status);
    if (
      phase < priorPhase ||
      phase > phases.indexOf(run.status) ||
      (phase > 0 && window.revision <= preparationRevision) ||
      (window.status === 'preparing' && window.revision !== windowIds.size)
    ) {
      return false;
    }
    priorPhase = phase;
    if (
      windowIds.has(window.operation_id) ||
      window.revision <= priorWindowRevision ||
      window.revision >= run.revision ||
      started < priorWindowStart ||
      started > Date.now() ||
      (model.limits.timeout_seconds == null
        ? window.deadline_at !== null
        : deadlineTime(window.deadline_at) - started !== model.limits.timeout_seconds * 1000)
    ) {
      return false;
    }
    windowIds.add(window.operation_id);
    revisions.add(window.revision);
    priorWindowRevision = window.revision;
    priorWindowStart = started;
  }
  if (run.plan_inputs) {
    if (run.status === 'preparing') return false;
    const needed = new Set(
      model.plan.steps.flatMap((step) => {
        const over = 'map' in step ? step.map.over : step.reduce.over;
        return (Array.isArray(over) ? over : [over]).filter((ref) =>
          Object.hasOwn(model.sources, ref)
        );
      })
    );
    if (Object.keys(run.plan_inputs).length !== needed.size) return false;
    for (const alias of needed) {
      const input = run.plan_inputs[alias];
      if (!input || input.ref !== model.sources[alias]!.ref) return false;
      const schemas = definition.resolved.steps.flatMap((resolved, index) => {
        const source = model.plan.steps[index]!;
        return resolved.input_schemas?.[alias]
          ? [resolved.input_schemas[alias]]
          : source.source.ref === alias
            ? [resolved.input_columns]
            : [];
      });
      if (
        !schemas.length ||
        schemas.some((columns) => digestAgenticState(columns) !== digestAgenticState(input.columns))
      ) {
        return false;
      }
      const rowSchema = createAgenticRowSchema(input.columns);
      if (input.rows.some((row) => !rowSchema.safeParse(row).success)) return false;
      if (
        Date.parse(input.retrieved_at) < Date.parse(run.started_at) ||
        Date.parse(input.retrieved_at) > Date.now()
      ) {
        return false;
      }
    }
    if (
      run.sealed_steps!.length > model.plan.steps.length ||
      (run.status === 'execution_complete' && run.sealed_steps!.length !== model.plan.steps.length)
    ) {
      return false;
    }
    const expected = [];
    for (const [index, sealed] of run.sealed_steps!.entries()) {
      if (
        sealed.id !== model.plan.steps[index]!.id ||
        revisions.has(sealed.revision) ||
        sealed.revision <= preparationRevision ||
        (index > 0 && sealed.revision <= run.sealed_steps![index - 1]!.revision)
      ) {
        return false;
      }
      const earlierIds = new Set(model.plan.steps.slice(0, index).map((step) => step.id));
      if (
        run.work
          .filter((work) => earlierIds.has(work.assignment.step_id))
          .some(
            (work) =>
              !work.accepted ||
              (work.attempts.at(-1)?.finish_revision ?? Infinity) >= sealed.revision
          )
      ) {
        return false;
      }
      revisions.add(sealed.revision);
      try {
        expected.push(...buildAgenticStepAssignments(run, index));
      } catch {
        return false;
      }
    }
    if (
      digestAgenticState(expected) !== digestAgenticState(run.work.map((work) => work.assignment))
    ) {
      return false;
    }
  }
  const chargesBefore = new Map<number, number>();
  const events = run.work
    .flatMap((work) =>
      work.attempts.flatMap((attempt) => [
        { revision: attempt.start_revision, delta: attempt.reservation ?? 0 },
        ...(attempt.finish_revision !== undefined
          ? [
              {
                revision: attempt.finish_revision,
                delta: attempt.charge - (attempt.reservation ?? 0),
              },
            ]
          : []),
      ])
    )
    .sort((a, b) => a.revision - b.revision);
  let charged = 0;
  for (const event of events) {
    chargesBefore.set(event.revision, charged);
    charged += event.delta;
  }
  const attemptIds = new Set<string>();
  let transitions =
    (run.status === 'preparing' ? 0 : 1) +
    (run.sealed_steps?.length ?? 0) +
    (run.execution_windows?.length ?? 0);
  if (run.status === 'execution_complete') transitions++;
  if (run.cursors_committed) transitions++;
  if (run.superseded) transitions++;
  if (run.publication === 'prepared') transitions++;
  if (run.publication === 'confirmed') transitions += 2;
  for (const [index, work] of run.work.entries()) {
    const assignment = work.assignment;
    if (!run.plan_inputs && 'map' in step) {
      const row = assignment.input.rows[0];
      if (
        assignment.input.rows.length !== 1 ||
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
      ) {
        return false;
      }
      const expected = {
        ...assignment,
        model_name: model.name,
        run_id: run.key.id,
        step_id: step.id,
        shard_id: String(index),
        attempt_id: `${run.key.id}:${index}:template`,
        definition_ref: `state:${run.key.id}`,
        input_snapshot_ref: `state:${run.key.id}:input`,
        mode: step.execution.mode,
        ...(step.execution.tools ? { allowed_tools: step.execution.tools } : {}),
        ...(step.classification ? { classification: step.classification } : {}),
        instructions: step.instructions,
        skills: [],
        profile: definition.resolved.steps[0]!.profile,
        input: {
          ...assignment.input,
          ref: definition.inputRef,
          columns: definition.resolved.steps[0]!.input_columns,
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
            definition.tokensPerAssignment,
            run.accounting ?? 'reservation'
          ),
          started_at: run.started_at,
          deadline_at: run.deadline_at,
        },
        allowed_sources:
          step.execution.mode === 'llm_call'
            ? []
            : (getAgenticContextSources(step) ?? Object.keys(model.sources)).map(
                (alias) => model.sources[alias]!.ref
              ),
      };
      if (digestAgenticState(assignment) !== digestAgenticState(expected)) return false;
    }
    const sealRevision =
      run.sealed_steps?.find((sealed) => sealed.id === assignment.step_id)?.revision ?? 0;
    let priorFinish = sealRevision;
    for (const [attemptIndex, attempt] of work.attempts.entries()) {
      const previous = work.attempts[attemptIndex - 1];
      // Spend-cap attempts hold no reservation; the snapshot schema requires null.
      if (
        !spendCap &&
        attempt.reservation !==
          attemptReservation(
            assignment.limits.tokens,
            run.token_limit,
            chargesBefore.get(attempt.start_revision)!
          )
      ) {
        return false;
      }
      if (isAgenticFailureBlocked(run, previous, attempt.start_revision)) return false;
      if (
        !spendCap &&
        previous &&
        previous.reservation !== null &&
        previous.charge > previous.reservation
      ) {
        return false;
      }
      if (
        attemptIds.has(attempt.id) ||
        attempt.start_revision <= preparationRevision ||
        attempt.start_revision <= priorFinish ||
        revisions.has(attempt.start_revision)
      ) {
        return false;
      }
      attemptIds.add(attempt.id);
      revisions.add(attempt.start_revision);
      transitions++;
      if (attempt.outcome) {
        if (
          attempt.finish_revision === undefined ||
          attempt.finish_revision <= attempt.start_revision ||
          revisions.has(attempt.finish_revision) ||
          !attempt.finished_at
        ) {
          return false;
        }
        const finished = Date.parse(attempt.finished_at);
        if (finished < Date.parse(run.started_at) || finished > Date.now()) return false;
        revisions.add(attempt.finish_revision);
        transitions++;
        priorFinish = attempt.finish_revision;
        const eligible =
          attempt.outcome.status !== 'failed' &&
          (spendCap ||
            ((attempt.reservation === null || attempt.charge <= attempt.reservation) &&
              finished < deadlineTime(agenticDeadlineAt(run, attempt.start_revision))));
        if (eligible && (!work.accepted || work.accepted.attempt_id !== attempt.id)) return false;
        if (!eligible && work.accepted?.attempt_id === attempt.id) return false;
      } else {
        if (
          attempt.finish_revision !== undefined ||
          attempt.finish_digest !== undefined ||
          attempt.finished_at !== undefined ||
          (!spendCap && attempt.charge !== (attempt.reservation ?? 0))
        ) {
          return false;
        }
        priorFinish = attempt.start_revision;
      }
    }
  }
  return (
    transitions === run.revision && [...revisions].every((revision) => revision < run.revision)
  );
}
