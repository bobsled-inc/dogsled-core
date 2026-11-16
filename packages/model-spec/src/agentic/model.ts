import { z } from 'zod';
import { FieldMetadataSchema } from '@bobsled-inc/protocol';
import { TransformSpecSchema } from '../compiler/schemas.js';
import { identifierSchema } from '../compiler/shared-validators.js';
import {
  AGENTIC_METADATA_NAMES,
  agenticMetadataRole,
  usesReservedAgenticPrefix,
} from './metadata-names.js';

const metadataColumns = [
  { name: AGENTIC_METADATA_NAMES.run_id, type: 'string', nullable: false },
  { name: AGENTIC_METADATA_NAMES.evidence, type: 'array', nullable: true },
  { name: AGENTIC_METADATA_NAMES.confidence, type: 'number', nullable: true },
  { name: AGENTIC_METADATA_NAMES.reason, type: 'object', nullable: true },
] as const;

export const AgenticColumnSchema = FieldMetadataSchema.pick({
  name: true,
  type: true,
  description: true,
})
  .extend({
    name: identifierSchema.refine(
      (name) => !['__proto__', 'constructor', 'prototype'].includes(name),
      'Reserved property name'
    ),
    nullable: z.boolean(),
  })
  .superRefine((column, ctx) => {
    if (!usesReservedAgenticPrefix(column.name)) return;
    // Saved definitions may carry an earlier spelling of a metadata column.
    const role = agenticMetadataRole(column.name);
    const reserved =
      role === undefined || column.name !== column.name.toLowerCase()
        ? undefined
        : metadataColumns.find((entry) => entry.name === AGENTIC_METADATA_NAMES[role]);
    if (!reserved || reserved.type !== column.type || reserved.nullable !== column.nullable) {
      ctx.addIssue({
        code: 'custom',
        message: 'Bobsled Core metadata names, types and nullability are fixed',
      });
    }
  });
export type AgenticColumn = z.infer<typeof AgenticColumnSchema>;
export const AGENTIC_METADATA_COLUMNS: readonly AgenticColumn[] = metadataColumns;

export const AgenticColumnsSchema = z
  .array(AgenticColumnSchema)
  .min(1)
  .max(256)
  .superRefine((columns, ctx) => {
    const seen = new Set<string>();
    columns.forEach((column, index) => {
      const name = column.name.toLowerCase();
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: 'Column names must be unique ignoring case',
        });
      }
      seen.add(name);
    });
  });

const OutputColumnsSchema = AgenticColumnsSchema.refine(
  (columns) => columns.every((column) => !usesReservedAgenticPrefix(column.name)),
  'Bobsled Core metadata columns are reserved'
);
export const AgenticReferenceSchema = TransformSpecSchema.shape.source.pick({ ref: true }).strict();
export const AgenticInputSourceSchema = AgenticReferenceSchema.extend({
  incremental: z.object({ cursor_field: identifierSchema }).strict().optional(),
});
const NamesSchema = z
  .array(identifierSchema)
  .min(1)
  .max(256)
  .refine(
    (names) => new Set(names.map((name) => name.toLowerCase())).size === names.length,
    'Names must be unique ignoring case'
  );
const ProfileSchema = z.object({ profile: z.string().trim().min(1).max(256) }).strict();
const OptionalLimit = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .optional();
export const AgenticAssignmentLimitsSchema = z
  .object({
    tokens_per_assignment: OptionalLimit,
    tool_calls_per_assignment: OptionalLimit,
    model_calls_per_assignment: OptionalLimit,
  })
  .strict();
/** Run spend caps stop new dispatch once reached; in-flight work still finishes. */
export const AgenticRunLimitsSchema = AgenticAssignmentLimitsSchema.extend({
  tokens: OptionalLimit,
  max_cost_usd: z.number().positive().max(1_000_000_000).nullable().optional(),
  timeout_seconds: z.number().int().positive().max(2_147_483).nullable().optional(),
}).strict();

export const AgenticToolNamesSchema = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/))
  .max(1024)
  .refine((names) => new Set(names).size === names.length, 'Tool names must be unique');

const GroupSchema = z.object({ over: identifierSchema, group_by: NamesSchema }).strict();
export const AgenticClassificationSchema = z
  .object({
    choices: z
      .record(
        identifierSchema.refine(
          (key) => !['__proto__', 'constructor', 'prototype'].includes(key),
          'Reserved choice key'
        ),
        z.string().trim().min(1).max(4096)
      )
      .refine(
        (choices) => Object.keys(choices).length >= 2 && Object.keys(choices).length <= 255,
        'Classification requires between 2 and 255 choices'
      ),
  })
  .strict();

export function validClassificationColumns(columns: AgenticColumn[], keys: string[]): boolean {
  return (
    !keys.some((key) => ['choice', 'confidence'].includes(key.toLowerCase())) &&
    columns.length === keys.length + 2 &&
    keys.every((key) => columns.some((column) => column.name === key)) &&
    columns.some(
      (column) => column.name === 'choice' && column.type === 'string' && !column.nullable
    ) &&
    columns.some(
      (column) => column.name === 'confidence' && column.type === 'number' && !column.nullable
    )
  );
}

const StepFields = {
  id: identifierSchema,
  source: AgenticReferenceSchema,
  execution: z
    .object({ mode: z.enum(['llm_call', 'agent_loop']), tools: AgenticToolNamesSchema.optional() })
    .strict(),
  context_sources: z.array(identifierSchema).max(256).optional(),
  sources: z
    .array(identifierSchema)
    .max(256)
    .optional()
    .describe('Deprecated step field; use context_sources instead. Do not set both.'),
  llm: ProfileSchema.optional(),
  limits: AgenticAssignmentLimitsSchema.optional(),
  skills: z.array(z.string().trim().min(1).max(1024)).max(64).optional(),
  classification: AgenticClassificationSchema.optional(),
  instructions: z.string().trim().min(1).max(65536),
  columns: OutputColumnsSchema,
};
export const AgenticStepSchema = z.union([
  z.object({ ...StepFields, map: GroupSchema }).strict(),
  z
    .object({
      ...StepFields,
      reduce: GroupSchema.extend({ over: z.union([identifierSchema, NamesSchema]) }),
    })
    .strict(),
]);
export type AgenticStep = z.infer<typeof AgenticStepSchema>;

/** Read the current spelling or the legacy field without rewriting saved definitions. */
export function getAgenticContextSources(step: AgenticStep): string[] | undefined {
  return step.context_sources ?? step.sources;
}

export const AgenticModelSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('model'),
    model_kind: z.literal('agentic'),
    name: TransformSpecSchema.shape.name,
    description: TransformSpecSchema.shape.description,
    grain: NamesSchema,
    sources: z
      .record(identifierSchema, AgenticInputSourceSchema)
      .refine(
        (sources) => Object.keys(sources).length > 0 && Object.keys(sources).length <= 256,
        'Declare between 1 and 256 source aliases'
      ),
    llm: ProfileSchema,
    limits: AgenticRunLimitsSchema.default({}),
    plan: z.object({ steps: z.array(AgenticStepSchema).min(1).max(256) }).strict(),
    output: z.object({ from: identifierSchema }).strict(),
    materialization: z
      .object({
        type: z.literal('table'),
        strategy: z.literal('replace_processed_keys'),
        keys: NamesSchema,
      })
      .strict(),
    execution: TransformSpecSchema.shape.execution,
    publish: TransformSpecSchema.shape.publish,
    target_schema: TransformSpecSchema.shape.target_schema,
    target_database: TransformSpecSchema.shape.target_database,
    tests: TransformSpecSchema.shape.tests,
    expect: TransformSpecSchema.shape.expect,
  })
  .strict()
  .superRefine((model, ctx) => {
    const sources = new Set(Object.keys(model.sources));
    const names = new Set([...sources].map((name) => name.toLowerCase()));
    if (names.size !== sources.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Source aliases must be unique ignoring case',
      });
    }
    const prior = new Set<string>();
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: 'custom', path, message });
    model.plan.steps.forEach((step, index) => {
      const path = ['plan', 'steps', index];
      if (names.has(step.id.toLowerCase())) {
        issue([...path, 'id'], 'Step names must be unique and distinct from source aliases');
      }
      names.add(step.id.toLowerCase());
      const grouping = 'map' in step ? step.map : step.reduce;
      if (
        step.classification &&
        (!('map' in step) ||
          step.execution.mode !== 'llm_call' ||
          step.skills?.length ||
          step.sources?.length ||
          step.execution.tools?.length ||
          !validClassificationColumns(step.columns, grouping.group_by))
      ) {
        issue(
          path,
          'Classification requires a map direct call without skills or tools and key, choice, confidence columns'
        );
      }
      const refs = Array.isArray(grouping.over) ? grouping.over : [grouping.over];
      if (refs[0] !== step.source.ref) {
        issue([...path, 'source', 'ref'], 'source.ref must select the first grouping input');
      }
      if (!sources.has(step.source.ref) && !prior.has(step.source.ref)) {
        issue([...path, 'source', 'ref'], 'Input must name a source alias or an earlier step');
      }
      if ('reduce' in step && refs.some((ref) => !prior.has(ref))) {
        issue([...path, 'reduce'], 'Reduce must read an earlier step');
      }
      if (step.context_sources !== undefined && step.sources !== undefined) {
        issue([...path, 'context_sources'], 'Use context_sources or legacy sources, not both');
      }
      const contextSources = getAgenticContextSources(step);
      const contextField = step.context_sources !== undefined ? 'context_sources' : 'sources';
      if (contextSources?.some((name) => !sources.has(name))) {
        issue([...path, contextField], 'A step cannot grant an undeclared source');
      }
      if (step.execution.mode === 'llm_call' && contextSources?.length) {
        issue([...path, contextField], 'Direct calls cannot declare source callbacks');
      }
      if (step.execution.mode === 'llm_call' && step.execution.tools?.length) {
        issue([...path, 'execution', 'tools'], 'Direct calls cannot declare tools');
      }
      prior.add(step.id);
    });
    const output = model.plan.steps.find((step) => step.id === model.output.from);
    if (!output) {
      issue(['output', 'from'], 'Output must select a declared step');
      return;
    }
    for (const key of [...model.grain, ...model.materialization.keys]) {
      const column = output.columns.find((column) => column.name === key);
      if (!column || column.nullable || ['array', 'object'].includes(column.type)) {
        issue(['output'], `Output key "${key}" must name a non-null scalar column`);
      }
    }
  });
export type AgenticModelSpec = z.infer<typeof AgenticModelSpecSchema>;

/** Contract validation only. SQL compilation and agentic dispatch remain separate. */
export const ModelSpecSchema = z.union([AgenticModelSpecSchema, TransformSpecSchema]);
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

/**
 * Format model validation issues against the branch the author chose, so a SQL model
 * missing `grain` reports `grain` instead of an unexplained union failure.
 */
export function describeModelSpecIssues(data: unknown, error: z.ZodError): string {
  const agentic =
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)['model_kind'] === 'agentic';
  const branch = (agentic ? AgenticModelSpecSchema : TransformSpecSchema).safeParse(data);
  const issues = branch.success ? error.issues : branch.error.issues;
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Declared business columns plus fixed Bobsled Core metadata for agentic outputs. */
export function getModelOutputColumns(model: ModelSpec) {
  if (model.model_kind !== 'agentic') return model.columns;
  const output = model.plan.steps.find((step) => step.id === model.output.from)!;
  return [...output.columns, ...AGENTIC_METADATA_COLUMNS];
}
