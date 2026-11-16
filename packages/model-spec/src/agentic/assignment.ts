import { z } from 'zod';
import { BOBSLED_CORE_RUNTIME_ERROR_KINDS } from '@bobsled-inc/protocol';
import { identifierSchema } from '../compiler/shared-validators.js';
import {
  AgenticColumnsSchema,
  AgenticToolNamesSchema,
  AgenticClassificationSchema,
  validClassificationColumns,
} from './model.js';
import { AgenticProfileSchema } from './resolve.js';
import {
  AGENTIC_MAX_ROWS,
  AgenticEvidenceSchema,
  AgenticJsonSchema,
  AgenticJudgmentSchema,
  AgenticReasonSchema,
  createAgenticRowSchema,
  isBoundedAgenticJson,
} from './rows.js';

const IdentitySchema = z.string().trim().min(1).max(1024);
const TokensSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const KeySchema = z.record(identifierSchema, z.union([z.string(), z.number(), z.boolean()]));
const KeysSchema = z
  .array(identifierSchema)
  .min(1)
  .max(256)
  .refine(
    (keys) => new Set(keys.map((key) => key.toLowerCase())).size === keys.length,
    'Key names must be unique'
  );
// Validation builds row schemas for each assignment. Compiling a schema's fast parser
// costs more than checking a few values without it.
const parseOptions = (values: number) => (values <= 4 ? { jitless: true } : undefined);

export const AgenticUsageSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('measured'),
      input_tokens: TokensSchema,
      output_tokens: TokensSchema,
      total_tokens: TokensSchema,
    })
    .strict()
    .refine(
      (usage) => usage.total_tokens === usage.input_tokens + usage.output_tokens,
      'Total tokens must include all input and output tokens'
    ),
  z
    .object({ status: z.literal('unknown'), reason: z.enum(['unavailable', 'interrupted']) })
    .strict(),
]);
export type AgenticUsage = z.infer<typeof AgenticUsageSchema>;

const InputSchema = z
  .object({
    ref: IdentitySchema,
    /** Host time when prepared input was received, not source record freshness. */
    retrieved_at: z.iso.datetime({ offset: true }).optional(),
    columns: AgenticColumnsSchema,
    rows: z.array(AgenticJsonSchema).max(AGENTIC_MAX_ROWS),
  })
  .strict();
const CompletedInputSchema = InputSchema.extend({
  complete: z.literal(true),
  processed_keys: z.array(KeySchema).min(1).max(AGENTIC_MAX_ROWS),
}).strict();

const AssignmentObjectSchema = z
  .object({
    contract_version: z.literal(2),
    model_name: identifierSchema,
    run_id: IdentitySchema,
    step_id: identifierSchema,
    shard_id: IdentitySchema,
    attempt_id: IdentitySchema,
    definition_ref: IdentitySchema,
    input_snapshot_ref: IdentitySchema,
    mode: z.enum(['llm_call', 'agent_loop']),
    classification: AgenticClassificationSchema.optional(),
    instructions: z.string().trim().min(1).max(65536),
    skills: z
      .array(
        z
          .object({
            ref: IdentitySchema,
            version: IdentitySchema,
            instructions: z.string().min(1).max(65536),
          })
          .strict()
      )
      .max(64),
    profile: AgenticProfileSchema,
    input: InputSchema,
    /** Required reduce inputs stay distinct. Empty rows are a completed result, not missing work. */
    inputs: z
      .record(identifierSchema, CompletedInputSchema)
      .refine(
        (inputs) => Object.keys(inputs).length > 0 && Object.keys(inputs).length <= 256,
        'Declare between 1 and 256 named inputs'
      )
      .optional(),
    group_key: KeySchema.refine((key) => Object.keys(key).length > 0, 'A group key is required'),
    processed_keys: z.array(KeySchema).min(1).max(AGENTIC_MAX_ROWS),
    output: z
      .object({ columns: AgenticColumnsSchema, grain: KeysSchema, replacement_keys: KeysSchema })
      .strict(),
    limits: z
      .object({
        tokens: TokensSchema.refine(
          (tokens) => tokens > 0,
          'Token limit must be positive'
        ).nullable(),
        tool_calls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
        model_calls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
        started_at: z.iso.datetime({ offset: true }),
        deadline_at: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict()
      .refine(
        (limits) =>
          limits.deadline_at === null ||
          Date.parse(limits.deadline_at) > Date.parse(limits.started_at),
        'Deadline must follow the original start'
      ),
    allowed_sources: z.array(IdentitySchema).max(256),
    allowed_tools: AgenticToolNamesSchema.optional(),
  })
  .strict()
  .superRefine((work, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (
      !AgenticColumnsSchema.safeParse(work.input.columns).success ||
      !AgenticColumnsSchema.safeParse(work.output.columns).success
    ) {
      return;
    }
    if (work.mode === 'llm_call' && work.allowed_tools?.length) {
      issue('Direct calls cannot carry tool access');
    }
    if (work.mode === 'llm_call' && work.allowed_sources.length) {
      issue('Direct calls cannot carry source access');
    }
    if (work.output.columns.some((column) => column.name.toLowerCase().startsWith('_bobsled_'))) {
      issue('Output metadata columns are reserved');
    }
    const keyNames = Object.keys(work.group_key);
    if (Boolean(work.classification) !== (work.profile.connection.provider === 'typesafe')) {
      issue('TypeSafe classification profile mismatch');
    }
    if (
      work.classification &&
      (work.mode !== 'llm_call' ||
        work.inputs ||
        work.skills.length ||
        work.input.rows.length !== 1 ||
        work.allowed_sources.length ||
        work.allowed_tools?.length ||
        !validClassificationColumns(work.output.columns, keyNames))
    ) {
      issue('Classification requires one input row without tools, skills, or reduce inputs');
    }
    for (const name of [...keyNames, ...work.output.replacement_keys, ...work.output.grain]) {
      const column = work.output.columns.find((column) => column.name === name);
      if (!column || column.nullable || ['array', 'object'].includes(column.type)) {
        issue(`Output key "${name}" must be a non-null scalar column`);
      }
    }
    const keyColumns = work.output.columns.filter((column) =>
      work.output.replacement_keys.includes(column.name)
    );
    if (!keyColumns.length) {
      issue('Replacement keys must name output columns');
      return;
    }
    const keySchema = createAgenticRowSchema(keyColumns);
    const keyOptions = parseOptions(
      work.processed_keys.length * (1 + (work.inputs ? Object.keys(work.inputs).length : 0))
    );
    const keys = new Set<string>();
    for (const key of work.processed_keys) {
      if (!keySchema.safeParse(key, keyOptions).success) {
        issue('Processed keys must match replacement key columns');
      }
      const identity = keyIdentity(key, work.output.replacement_keys);
      if (keys.has(identity)) issue('Processed keys must be unique');
      keys.add(identity);
      for (const name of keyNames) {
        if (Object.hasOwn(key, name) && key[name] !== work.group_key[name]) {
          issue('Processed key is outside the assignment group');
        }
      }
    }
    if (work.inputs) {
      const primary = Object.values(work.inputs).find((input) => input.ref === work.input.ref);
      if (
        !primary ||
        JSON.stringify({
          ref: primary.ref,
          retrieved_at: primary.retrieved_at,
          columns: primary.columns,
          rows: primary.rows,
        }) !== JSON.stringify(work.input)
      ) {
        issue('Primary input must match its named input');
      }
      for (const input of Object.values(work.inputs)) {
        const completed = new Set(
          input.processed_keys.map((key) => keyIdentity(key, work.output.replacement_keys))
        );
        if (
          completed.size !== input.processed_keys.length ||
          completed.size !== keys.size ||
          [...keys].some((key) => !completed.has(key)) ||
          input.processed_keys.some((key) => !keySchema.safeParse(key, keyOptions).success)
        ) {
          issue('Named input must complete the assignment processed key set');
        }
      }
    }
    for (const input of work.inputs ? Object.values(work.inputs) : [work.input]) {
      const groupColumns = input.columns.filter((column) => keyNames.includes(column.name));
      if (
        !groupColumns.length ||
        !createAgenticRowSchema(groupColumns).safeParse(work.group_key, parseOptions(1)).success
      ) {
        issue('Group key must match input columns');
      }
      for (const name of [...keyNames, ...work.output.replacement_keys]) {
        const inputColumn = input.columns.find((column) => column.name === name);
        const output = work.output.columns.find((column) => column.name === name);
        if (!inputColumn || inputColumn.nullable || inputColumn.type !== output?.type) {
          issue(`Input must preserve key "${name}" and its type`);
        }
      }
      const inputRow = createAgenticRowSchema(input.columns);
      const rowOptions = parseOptions(input.rows.length);
      for (const row of input.rows) {
        const parsed = inputRow.safeParse(row, rowOptions);
        if (!parsed.success) {
          issue('Input row does not match its inferred schema');
          continue;
        }
        if (keyNames.some((name) => parsed.data[name] !== work.group_key[name])) {
          issue('Input row is outside the assignment group');
        }
        if (!keys.has(keyIdentity(parsed.data, work.output.replacement_keys))) {
          issue('Input row is outside the processed key set');
        }
      }
    }
  });

export const AgentAssignmentSchema = AgenticJsonSchema.pipe(AssignmentObjectSchema);
export type AgentAssignment = z.infer<typeof AgentAssignmentSchema>;

const OutcomeFields = {
  contract_version: z.literal(2),
  attempt_id: IdentitySchema,
  usage: AgenticUsageSchema,
};
export const AgentAssignmentOutcomeSchema = AgenticJsonSchema.pipe(
  z.discriminatedUnion('status', [
    z
      .object({
        ...OutcomeFields,
        status: z.literal('succeeded'),
        rows: z.array(AgenticJsonSchema).max(AGENTIC_MAX_ROWS),
      })
      .strict(),
    z
      .object({
        ...OutcomeFields,
        status: z.literal('insufficient_evidence'),
        rows: z.array(AgenticJsonSchema).max(AGENTIC_MAX_ROWS),
        reason: AgenticReasonSchema,
      })
      .strict(),
    z
      .object({
        ...OutcomeFields,
        status: z.literal('failed'),
        error: z
          .object({
            kind: z.enum(BOBSLED_CORE_RUNTIME_ERROR_KINDS),
            code: identifierSchema,
            retryable: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  ])
);
export type AgentAssignmentOutcome = z.infer<typeof AgentAssignmentOutcomeSchema>;

function keyIdentity(row: Record<string, unknown>, keys: readonly string[]): string {
  return JSON.stringify(keys.map((name) => row[name]));
}

function assignmentEvidenceSources(work: AgentAssignment): Set<string> {
  const inputs = work.inputs ? Object.values(work.inputs) : [work.input];
  const sources = new Set([
    ...inputs.map((input) => input.ref),
    ...work.allowed_sources,
    ...(work.allowed_tools ?? []),
  ]);
  // Saved input evidence can be cited without granting fresh access to its source.
  for (const row of inputs.flatMap((input) => input.rows)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const prior = AgenticJudgmentSchema.shape._bobsled_evidence.safeParse(row['_bobsled_evidence']);
    if (prior.success && prior.data) {
      for (const entry of prior.data) sources.add(entry.source);
    }
  }
  return sources;
}

function assignmentRowSchema(work: AgentAssignment) {
  const sources = [...assignmentEvidenceSources(work)];
  const base = createAgenticRowSchema(work.output.columns, true, sources);
  const fields: Record<string, z.ZodType> = Object.fromEntries(
    Object.entries(work.group_key).map(([name, value]) => [name, z.literal(value)])
  );
  const inputs = work.inputs ? Object.values(work.inputs) : [work.input];
  const fixedTimes = new Map<string, string>();
  for (const source of sources) {
    const prepared = inputs.find((input) => input.ref === source);
    if (prepared?.retrieved_at !== undefined && !work.allowed_sources.includes(source)) {
      fixedTimes.set(source, prepared.retrieved_at);
    }
  }
  if (fixedTimes.size) {
    const variants = sources.map((source) => {
      const time = fixedTimes.get(source);
      return AgenticEvidenceSchema.extend({
        source: z.literal(source),
        ...(time === undefined ? {} : { retrieved_at: z.literal(time) }),
      });
    });
    const evidence = variants.length === 1 ? variants[0]! : z.union(variants);
    fields['_bobsled_evidence'] = z.array(evidence).min(1).max(256).nullable();
  }
  if (work.classification) {
    fields['choice'] = z.enum(Object.keys(work.classification.choices));
    fields['confidence'] = z.number().min(0).max(1);
  }
  return base.in.pipe(base.out.extend(fields));
}

/** Row constraints that survive JSON Schema transport to the executor's output tool. */
export function createAgentAssignmentRowSchema(assignment: AgentAssignment) {
  return assignmentRowSchema(AgentAssignmentSchema.parse(assignment));
}

/** Canonical model-facing result envelope. Final outcome validation is still required. */
export function createAgentAssignmentOutputSchema(assignment: AgentAssignment) {
  const work = AgentAssignmentSchema.parse(assignment);
  const singleRow =
    work.classification !== undefined ||
    work.output.grain.every((key) => Object.hasOwn(work.group_key, key));
  return z
    .object({
      rows: z
        .array(assignmentRowSchema(work))
        .min(work.classification ? 1 : 0)
        .max(singleRow ? 1 : AGENTIC_MAX_ROWS),
    })
    .strict();
}

/** Pure validation, not durable attempt acceptance. The state store must still fence commits. */
export function parseAgentAssignmentOutcome(
  assignment: AgentAssignment,
  value: unknown
): AgentAssignmentOutcome {
  return parseOutcome(AgentAssignmentSchema.parse(assignment), value);
}

/** Validates an attempt's outcome against `work`, which must be AgentAssignmentSchema output.
 * Equivalent to parseAgentAssignmentOutcome({ ...work, attempt_id }, value): only the
 * attempt ID and the bounded total differ, so only they are checked again. */
export function parseAttemptOutcome(
  work: AgentAssignment,
  attemptId: string,
  value: unknown
): AgentAssignmentOutcome {
  const raw = { ...work, attempt_id: attemptId };
  const id = IdentitySchema.safeParse(attemptId);
  return parseOutcome(
    id.success && isBoundedAgenticJson(raw)
      ? { ...work, attempt_id: id.data }
      : AgentAssignmentSchema.parse(raw),
    value
  );
}

function parseOutcome(work: AgentAssignment, value: unknown): AgentAssignmentOutcome {
  const schema = AgentAssignmentOutcomeSchema.superRefine((outcome, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (outcome.attempt_id !== work.attempt_id) issue('Outcome belongs to a different attempt');
    if (outcome.status === 'failed') return;
    if (work.classification && (outcome.status !== 'succeeded' || outcome.rows.length !== 1)) {
      issue('Classification must return exactly one successful row');
    }
    const rowSchema = createAgenticRowSchema(work.output.columns, true);
    const rowOptions = parseOptions(outcome.rows.length);
    const allowed = new Set(
      work.processed_keys.map((key) => keyIdentity(key, work.output.replacement_keys))
    );
    const grain = new Set<string>();
    const inputs = work.inputs ? Object.values(work.inputs) : [work.input];
    const sources = assignmentEvidenceSources(work);
    for (const row of outcome.rows) {
      const parsed = rowSchema.safeParse(row, rowOptions);
      if (!parsed.success) {
        issue('Output row does not match columns and reserved metadata');
        continue;
      }
      const data = parsed.data;
      if (
        work.classification &&
        (typeof data.choice !== 'string' ||
          !Object.hasOwn(work.classification.choices, data.choice) ||
          typeof data.confidence !== 'number' ||
          data.confidence < 0 ||
          data.confidence > 1)
      ) {
        issue('Invalid classification choice or confidence');
      }
      if (!allowed.has(keyIdentity(data, work.output.replacement_keys))) {
        issue('Output key is outside the prepared work set');
      }
      if (Object.keys(work.group_key).some((name) => data[name] !== work.group_key[name])) {
        issue('Output row is outside the assignment group');
      }
      const identity = keyIdentity(data, work.output.grain);
      if (grain.has(identity)) issue('Output rows must be unique at the declared grain');
      grain.add(identity);
      const evidence = data['_bobsled_evidence'];
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          const prepared = inputs.find((input) => input.ref === entry.source);
          if (
            prepared &&
            !work.allowed_sources.includes(prepared.ref) &&
            prepared.retrieved_at !== undefined &&
            entry.retrieved_at !== prepared.retrieved_at
          ) {
            issue('Evidence retrieval time must match the prepared input');
          }
          if (!sources.has(entry.source)) {
            issue('Evidence must name a prepared input, permitted source, or permitted tool');
          }
        }
      }
    }
  });
  return schema.parse(value);
}
