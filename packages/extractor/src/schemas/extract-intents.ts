import { z } from 'zod';

import { SAFE_NAME_RE, SpecNameSchema } from '../framework/core/index.js';

/** Matches a full `${{ seed.field_name }}` binding expression. Shared with runtime extraction. */
export const SEED_BINDING_RE = /^\$\{\{\s*seed\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

const SeedBindingPatternSchema = z.string().regex(SEED_BINDING_RE, 'Must reference a seed field');

const StepInputValueSchema = z.union([
  SeedBindingPatternSchema,
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const SeedFileSchema = z
  .object({
    format: z.enum(['csv', 'jsonl', 'yaml']),
    path: z.string().min(1),
  })
  .strict();

const PlanStepSchema = z
  .object({
    id: SpecNameSchema,
    integration: SpecNameSchema,
    resource: SpecNameSchema,
    seed: SpecNameSchema,
    input: z.record(z.string().regex(SAFE_NAME_RE), StepInputValueSchema),
    limits: z
      .object({
        max_input_rows: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [field, inputValue] of Object.entries(value.input)) {
      if (typeof inputValue !== 'string') {
        continue;
      }

      if (inputValue.includes('${{') && !SeedBindingPatternSchema.safeParse(inputValue).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Input "${field}" must be a full seed binding like \${{ seed.field }}`,
          path: ['input', field],
        });
      }
    }
  });

const PlanBudgetSchema = z
  .object({
    max_estimated_credits: z.number().positive(),
    on_exceed: z.enum(['fail', 'warn']),
  })
  .strict();

const ExtractIntentPlanSchema = z
  .object({
    description: z.string().min(1),
    budget: PlanBudgetSchema,
    seeds: z.record(SpecNameSchema, SeedFileSchema),
    steps: z.array(PlanStepSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const stepIds = new Set<string>();

    for (const step of value.steps) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step id "${step.id}"`,
          path: ['steps'],
        });
      }
      stepIds.add(step.id);

      if (!(step.seed in value.seeds)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step "${step.id}" references unknown seed "${step.seed}"`,
          path: ['steps'],
        });
      }
    }
  });

export const ExtractIntentsSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('extract-intents'),
    plans: z.record(SpecNameSchema, ExtractIntentPlanSchema),
  })
  .strict();
