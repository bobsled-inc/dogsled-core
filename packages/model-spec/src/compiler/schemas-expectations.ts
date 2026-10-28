import { z } from 'zod';
import { identifierRegex, identifierMsg } from './shared-validators.js';
import { dangerousExprRegex, dangerousExprMsg } from './schemas-shared.js';

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

const ExpectColumnsSchema = z
  .array(z.string().min(1).regex(identifierRegex, identifierMsg))
  .min(1, 'At least one column is required');

const severityFields = {
  severity: z.enum(['warn', 'error']).default('error').optional(),
} as const;

const ExpectPrimaryKeySchema = z
  .object({
    kind: z.literal('primary_key'),
    columns: ExpectColumnsSchema,
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectNonNullSchema = z
  .object({
    kind: z.literal('non_null'),
    column: z.string().min(1).regex(identifierRegex, identifierMsg),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectUniqueSchema = z
  .object({
    kind: z.literal('unique'),
    columns: ExpectColumnsSchema,
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectInRangeSchema = z
  .object({
    kind: z.literal('in_range'),
    column: z.string().min(1).regex(identifierRegex, identifierMsg),
    min: z.number().optional(),
    max: z.number().optional(),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.min === undefined && data.max === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'in_range requires at least one of min or max',
      });
    }
    if (data.min !== undefined && data.max !== undefined && data.min > data.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'in_range min must be <= max',
      });
    }
  });

const ExpectRegexSchema = z
  .object({
    kind: z.literal('regex'),
    column: z.string().min(1).regex(identifierRegex, identifierMsg),
    pattern: z
      .string()
      .min(1)
      .superRefine((pattern, ctx) => {
        try {
          new RegExp(pattern);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectSchemaContainsSchema = z
  .object({
    kind: z.literal('schema_contains'),
    columns: ExpectColumnsSchema,
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectRowCountBetweenSchema = z
  .object({
    kind: z.literal('row_count_between'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.min === undefined && data.max === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'row_count_between requires at least one of min or max',
      });
    }
    if (data.min !== undefined && data.max !== undefined && data.min > data.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'row_count_between min must be <= max',
      });
    }
  });

const ExpectAcceptedValuesSchema = z
  .object({
    kind: z.literal('accepted_values'),
    column: z.string().min(1).regex(identifierRegex, identifierMsg),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectExpressionSchema = z
  .object({
    kind: z.literal('expression'),
    expression: z
      .string()
      .min(1)
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

const ExpectCustomSchema = z
  .object({
    kind: z.literal('custom'),
    sql: z
      .string()
      .min(1)
      .refine(
        (v) => /\bas\s+violation_count\b/i.test(v),
        'Custom SQL must SELECT a column AS violation_count'
      ),
    description: z.string().optional(),
    ...severityFields,
  })
  .strict();

export const ExpectSpecSchema = z.discriminatedUnion('kind', [
  ExpectPrimaryKeySchema,
  ExpectNonNullSchema,
  ExpectUniqueSchema,
  ExpectInRangeSchema,
  ExpectRegexSchema,
  ExpectSchemaContainsSchema,
  ExpectRowCountBetweenSchema,
  ExpectAcceptedValuesSchema,
  ExpectExpressionSchema,
  ExpectCustomSchema,
]);

export type ExpectSpec = z.infer<typeof ExpectSpecSchema>;
