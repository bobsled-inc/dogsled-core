import { assignmentLimits } from './limits.js';
/** Pure construction of durable plan assignments from saved inputs and accepted work. */
import type { JsonValue } from '@bobsled-inc/protocol';
import { AgentAssignmentSchema } from './assignment.js';
import type { AgentAssignment } from './assignment.js';
import { createAgenticRowSchema, AgenticJsonSchema, AGENTIC_MAX_ROWS } from './rows.js';
import type { AgenticColumn, AgenticStep } from './model.js';
import type { ResolvedAgenticModel } from './resolve.js';
import type { AgenticRunSnapshot } from './state.js';
import { digestAgenticState } from './state.js';

type Row = Record<string, JsonValue>;
export interface PreparedPlanInput {
  ref: string;
  retrieved_at: string;
  columns: AgenticColumn[];
  rows: JsonValue[];
}
export interface PlanDefinition {
  resolved: ResolvedAgenticModel;
  tokensPerAssignment?: number;
}
export function agenticStepRefs(step: AgenticStep): string[] {
  return 'map' in step
    ? [step.source.ref]
    : Array.isArray(step.reduce.over)
      ? step.reduce.over
      : [step.reduce.over];
}
export function agenticPlanSourceAliases(resolved: ResolvedAgenticModel): string[] {
  return [
    ...new Set(
      resolved.steps
        .flatMap(({ step }) => agenticStepRefs(step))
        .filter((ref) => Object.hasOwn(resolved.model.sources, ref))
    ),
  ];
}
export function planInputColumns(resolved: ResolvedAgenticModel, alias: string): AgenticColumn[] {
  const step = resolved.steps.find((item) => agenticStepRefs(item.step).includes(alias));
  if (!step) throw new Error('Plan input is not declared');
  return step.input_schemas?.[alias] ?? step.input_columns;
}
export function validateAgenticPlanInputs(
  resolved: ResolvedAgenticModel,
  inputs: Record<string, PreparedPlanInput>
): void {
  const aliases = agenticPlanSourceAliases(resolved);
  if (digestAgenticState(Object.keys(inputs).sort()) !== digestAgenticState(aliases.sort())) {
    throw new Error('Plan input set differs from declared inputs');
  }
  for (const alias of aliases) {
    const input = inputs[alias]!;
    const columns = planInputColumns(resolved, alias);
    if (
      input.ref !== resolved.model.sources[alias]!.ref ||
      digestAgenticState(input.columns) !== digestAgenticState(columns)
    ) {
      throw new Error('Plan input schema differs from declared input');
    }
    if (input.rows.length > AGENTIC_MAX_ROWS) throw new Error('Plan input row limit exceeded');
    const schema = createAgenticRowSchema(columns);
    for (const row of input.rows) schema.parse(row);
    AgenticJsonSchema.parse(input.rows);
    for (const { step } of resolved.steps) {
      if (!step.classification || !('map' in step) || step.source.ref !== alias) continue;
      const groups = input.rows.map((row) =>
        digestAgenticState(fields(row as Row, step.map.group_by))
      );
      if (new Set(groups).size !== groups.length) {
        throw new Error('Classification requires one prepared row per group');
      }
    }
  }
}
function fields(row: Row, names: string[]): Row {
  const result: Row = {};
  for (const name of names) {
    const value = row[name];
    if (value === undefined || value === null || typeof value === 'object') {
      throw new Error(`Missing scalar grouping key ${name}`);
    }
    result[name] = value;
  }
  return result;
}
const unique = (rows: Row[]): Row[] => [
  ...new Map(rows.map((row) => [digestAgenticState(row), row])).values(),
];
interface InputData extends PreparedPlanInput {
  markers: Row[];
}
function stepInput(run: AgenticRunSnapshot, ref: string): InputData {
  const { resolved } = run.definition as unknown as PlanDefinition;
  const keys = resolved.model.materialization.keys;
  if (Object.hasOwn(resolved.model.sources, ref)) {
    const saved = run.plan_inputs?.[ref];
    if (!saved) throw new Error('Prepared input is missing');
    return { ...saved, markers: saved.rows.map((row) => row as Row) };
  }
  const resolvedStep = resolved.steps.find((item) => item.step.id === ref);
  if (!resolvedStep || !run.sealed_steps?.some((step) => step.id === ref)) {
    throw new Error('Required upstream step is missing');
  }
  const work = run.work.filter((item) => item.assignment.step_id === ref);
  if (work.some((item) => !item.accepted || item.accepted.status === 'failed')) {
    throw new Error('Required upstream step is incomplete');
  }
  const rows: Row[] = [];
  const markers: Row[] = [];
  let retrieved_at = run.started_at;
  for (const item of work) {
    const accepted = item.accepted!;
    if (accepted.status === 'failed') throw new Error('Required upstream step failed');
    for (const key of item.assignment.processed_keys) {
      markers.push({ ...item.assignment.group_key, ...(key as Row) });
    }
    for (const row of accepted.rows) rows.push({ ...(row as Row), _dogsled_run_id: run.key.id });
    const finished = item.attempts.find(
      (attempt) => attempt.id === accepted.attempt_id
    )?.finished_at;
    if (finished && Date.parse(finished) > Date.parse(retrieved_at)) retrieved_at = finished;
  }
  // Output rows carry all keys. Empty successful work keeps its keys through markers.
  for (const row of rows) fields(row, keys);
  return {
    ref,
    columns: [
      ...resolvedStep.step.columns,
      ...resolved.output_columns.filter((column) => column.name.startsWith('_dogsled_')),
    ],
    rows,
    markers,
    retrieved_at,
  };
}

export function buildAgenticStepAssignments(
  run: AgenticRunSnapshot,
  stepIndex: number
): AgentAssignment[] {
  const definition = run.definition as unknown as PlanDefinition;
  const { resolved } = definition;
  const current = resolved.steps[stepIndex];
  if (!current) throw new Error('Plan step is missing');
  const step = current.step;
  const grouping = 'map' in step ? step.map : step.reduce;
  const refs = agenticStepRefs(step);
  const keys = resolved.model.materialization.keys;
  const byInput = refs.map((ref) => {
    const data = stepInput(run, ref);
    const groups = new Map<string, { key: Row; rows: JsonValue[]; keys: Row[] }>();
    const add = (row: Row, output: boolean) => {
      const key = fields(row, grouping.group_by);
      const identity = digestAgenticState(key);
      let group = groups.get(identity);
      if (!group) {
        group = { key, rows: [], keys: [] };
        groups.set(identity, group);
      }
      group.keys.push(fields(row, keys));
      if (output) group.rows.push(row);
    };
    for (const row of data.rows) add(row as Row, true);
    // Markers cannot invent grouping fields introduced only by an output row.
    let outputKeys: Set<string> | undefined;
    for (const marker of data.markers) {
      if (grouping.group_by.every((name) => marker[name] !== undefined)) add(marker, false);
      else if (!data.rows.length) {
        throw new Error('Empty work cannot supply the requested grouping keys');
      } else {
        // add() already extracted every row's keys; hash them once, not once per marker.
        outputKeys ??= new Set(
          data.rows.map((row) => digestAgenticState(fields(row as Row, keys)))
        );
        if (!outputKeys.has(digestAgenticState(fields(marker, keys)))) {
          throw new Error('Empty work cannot supply the requested grouping keys');
        }
      }
    }
    const seenKeys = new Map<string, string>();
    for (const [id, group] of groups) {
      group.keys = unique(group.keys);
      for (const key of group.keys) {
        const identity = digestAgenticState(key);
        if (seenKeys.has(identity) && seenKeys.get(identity) !== id) {
          throw new Error('A replacement key belongs to more than one group');
        }
        seenKeys.set(identity, id);
      }
    }
    return { ref, data, groups };
  });
  const allGroups = [...new Set(byInput.flatMap((input) => [...input.groups.keys()]))].sort();
  return allGroups.map((id, index) => {
    const primary = byInput[0]!;
    const group = primary.groups.get(id);
    if (!group) throw new Error('Required reduce group is missing');
    const keyDigest = digestAgenticState(group.keys.map(digestAgenticState).sort());
    const inputs = Object.fromEntries(
      byInput.map((input) => {
        const part = input.groups.get(id);
        if (!part || digestAgenticState(part.keys.map(digestAgenticState).sort()) !== keyDigest) {
          throw new Error('Required reduce input has missing processed keys');
        }
        return [
          input.ref,
          {
            ref: input.data.ref,
            retrieved_at: input.data.retrieved_at,
            columns: input.data.columns,
            rows: part.rows,
            complete: true,
            processed_keys: part.keys,
          },
        ];
      })
    );
    const bundle = inputs[primary.ref]!;
    const grain = resolved.model.grain.every((name) =>
      step.columns.some((column) => column.name === name)
    )
      ? resolved.model.grain
      : [...new Set([...grouping.group_by, ...keys])];
    return AgentAssignmentSchema.parse({
      contract_version: 2,
      model_name: resolved.model.name,
      run_id: run.key.id,
      step_id: step.id,
      shard_id: `${step.id}:${index}`,
      attempt_id: `${run.key.id}:${step.id}:${index}:template`,
      definition_ref: `state:${run.key.id}`,
      input_snapshot_ref: `state:${run.key.id}:${step.id}:input`,
      mode: step.execution.mode,
      ...(step.execution.tools ? { allowed_tools: step.execution.tools } : {}),
      ...(step.classification ? { classification: step.classification } : {}),
      instructions: step.instructions,
      skills: [],
      profile: current.profile,
      input: {
        ref: bundle.ref,
        retrieved_at: bundle.retrieved_at,
        columns: bundle.columns,
        rows: bundle.rows,
      },
      ...('reduce' in step ? { inputs } : {}),
      group_key: group.key,
      processed_keys: group.keys,
      output: { columns: step.columns, grain, replacement_keys: keys },
      limits: {
        ...assignmentLimits(definition.resolved.model, step, definition.tokensPerAssignment),
        started_at: run.started_at,
        deadline_at: run.deadline_at,
      },
      allowed_sources: current.allowed_sources.map((alias) => resolved.model.sources[alias]!.ref),
    });
  });
}
