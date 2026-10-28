import { z } from 'zod';
import {
  AuthEnvVarsSchema,
  CommandError,
  EXIT_VALIDATION,
  ModelConnectionSchema,
} from '@bobsled-inc/protocol';
import { withHostManagedModelAuth, withHostModelDeclarations } from './host-declarations.js';
import { AgenticColumnsSchema, AgenticModelSpecSchema, getAgenticContextSources } from './model.js';
import { AGENTIC_METADATA_COLUMNS } from './model.js';
import type { AgenticColumn, AgenticModelSpec, AgenticStep } from './model.js';

export const AgenticProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    connection: ModelConnectionSchema,
  })
  .strict();
export type AgenticProfile = z.infer<typeof AgenticProfileSchema>;
export interface ResolvedAgenticStep {
  step: AgenticStep;
  input_columns: AgenticColumn[];
  /** Separate schemas preserve each input identity, including overlapping field names. */
  input_schemas?: Record<string, AgenticColumn[]>;
  profile: AgenticProfile;
  allowed_sources: string[];
}
export interface ResolvedAgenticModel {
  model: AgenticModelSpec;
  steps: ResolvedAgenticStep[];
  output_columns: AgenticColumn[];
}

/** Host supplies discovered column contracts, keyed by the existing model/source ref. */
export function resolveAgenticModel(
  definition: unknown,
  context: {
    inputs: Readonly<Record<string, unknown>>;
    platform?: { models?: Readonly<Record<string, unknown>> };
    /**
     * API key names the embedding host declares it serves, in addition to each
     * profile's own `auth_env_vars`. Validation only: values are never read.
     */
    declaredSecretNames?: readonly string[];
    /**
     * Set to `true` only when the host's own executor runs every profile and
     * signs in to the model provider itself. Each profile's own `api_key` name
     * then counts as declared. Validation only: values are never read.
     */
    hostManagedModelAuth?: boolean;
  }
): ResolvedAgenticModel {
  const model = AgenticModelSpecSchema.parse(definition);
  if (context.declaredSecretNames !== undefined && context.platform) {
    const names = AuthEnvVarsSchema.safeParse(context.declaredSecretNames);
    if (!names.success) {
      throw new CommandError(
        'declaredSecretNames must contain valid environment variable names.',
        EXIT_VALIDATION
      );
    }
    context = { ...context, platform: withHostModelDeclarations(context.platform, names.data) };
  }
  if (context.hostManagedModelAuth === true && context.platform) {
    context = { ...context, platform: withHostManagedModelAuth(context.platform) };
  }
  const output = model.plan.steps.find((step) => step.id === model.output.from)!;
  const output_columns = [...output.columns, ...AGENTIC_METADATA_COLUMNS];
  const inputs = new Map<string, AgenticColumn[]>();
  for (const [alias, source] of Object.entries(model.sources)) {
    // A self-target read is old published data, never a new model dependency.
    if (source.ref === model.name) inputs.set(alias, output_columns);
    else if (Object.hasOwn(context.inputs, source.ref)) {
      inputs.set(alias, AgenticColumnsSchema.parse(context.inputs[source.ref]));
    }
  }
  const fail = (message: string): never => {
    throw new CommandError(message, EXIT_VALIDATION);
  };
  for (const [alias, source] of Object.entries(model.sources)) {
    if (!source.incremental) continue;
    const column = inputs
      .get(alias)
      ?.find((item) => item.name === source.incremental!.cursor_field);
    if (
      !column ||
      column.nullable ||
      !['timestamp', 'date', 'integer', 'number'].includes(column.type)
    ) {
      fail(
        `Incremental cursor "${alias}.${source.incremental.cursor_field}" must be a non-null timestamp, date, or number`
      );
    }
    if (
      !model.plan.steps.some((step) => {
        const over = 'map' in step ? step.map.over : step.reduce.over;
        return (Array.isArray(over) ? over : [over]).includes(alias);
      })
    ) {
      fail(`Incremental source "${alias}" must be a prepared plan input`);
    }
  }
  const steps = model.plan.steps.map((step): ResolvedAgenticStep => {
    const input_columns = inputs.get(step.source.ref);
    if (!input_columns) fail(`No prepared input schema for "${step.source.ref}"`);
    const grouping = 'map' in step ? step.map : step.reduce;
    const refs = Array.isArray(grouping.over) ? grouping.over : [grouping.over];
    const input_schemas = Object.fromEntries(
      refs.map((ref) => {
        const columns = inputs.get(ref);
        if (!columns) fail(`No prepared input schema for "${ref}"`);
        return [ref, columns!];
      })
    );
    for (const columns of Object.values(input_schemas)) {
      for (const name of [...grouping.group_by, ...model.materialization.keys]) {
        const column = columns.find((column) => column.name === name);
        if (!column || column.nullable || ['array', 'object'].includes(column.type)) {
          fail(`Input key "${name}" must be a non-null scalar column`);
        }
        const returned = step.columns.find((column) => column.name === name);
        if (!returned || returned.type !== column!.type || returned.nullable) {
          fail(`Step "${step.id}" must preserve input key "${name}" and its type`);
        }
      }
    }
    const name = step.llm?.profile ?? model.llm.profile;
    const models = context.platform?.models;
    if (!models || !Object.hasOwn(models, name)) {
      fail(`Model role "${name}" is not defined in platform.models`);
    }
    const profile = AgenticProfileSchema.parse({ name, connection: models![name] });
    if (Boolean(step.classification) !== (profile.connection.provider === 'typesafe')) {
      fail(
        'TypeSafe profiles require classification, and classification requires a TypeSafe profile'
      );
    }
    if (
      step.classification &&
      (profile.connection.dimension || profile.connection.cost_budget_usd)
    ) {
      fail(
        'TypeSafe classification does not support dimension or dollar budgets; use model token limits'
      );
    }
    const allowed_sources =
      step.execution.mode === 'llm_call'
        ? []
        : (getAgenticContextSources(step) ?? Object.keys(model.sources));
    inputs.set(step.id, [...step.columns, ...AGENTIC_METADATA_COLUMNS]);
    return {
      step,
      input_columns: input_columns!,
      ...('reduce' in step ? { input_schemas } : {}),
      profile,
      allowed_sources,
    };
  });
  return { model, steps, output_columns };
}
