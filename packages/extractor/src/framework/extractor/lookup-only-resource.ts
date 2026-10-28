import { z } from 'zod';

import {
  InputFieldSchema,
  OperationTestSchema,
  OutputFieldSchema,
  SpecNameSchema,
  validateContextualOutputSupport,
} from '../core/index.js';

/** Build the lookup-only Resource variant from the shared operation schemas. */
export function createLookupOnlyApiResourceSpecSchema<
  TLookup extends z.ZodType,
  TBilling extends z.ZodType,
>(lookupSchema: TLookup, billingSchema: TBilling) {
  return z
    .object({
      spec_version: z.literal('1').optional(),
      type: z.literal('resource'),
      name: SpecNameSchema,
      description: z.string(),
      integration: SpecNameSchema.optional(),
      via: SpecNameSchema.optional(),
      entity: SpecNameSchema.optional(),
      target: SpecNameSchema.optional(),
      input: z.record(z.string(), InputFieldSchema).default({}),
      output: z.record(z.string(), OutputFieldSchema),
      api: z.never().optional(),
      tool: z.never().optional(),
      extract: z.never().optional(),
      incremental: z.never().optional(),
      query: z.never().optional(),
      source: z.never().optional(),
      replication: z.never().optional(),
      lookup: lookupSchema,
      billing: billingSchema.optional(),
      test: OperationTestSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      validateContextualOutputSupport(
        value.output,
        false,
        ctx,
        'contextual output fields are not supported by lookup-only resources'
      );

      if (value.via && value.integration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'first-class resources use "via"; remove legacy "integration"',
          path: ['integration'],
        });
      }

      if (value.via && value.spec_version) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'first-class resources must not declare legacy "spec_version"',
          path: ['spec_version'],
        });
      }
    });
}
