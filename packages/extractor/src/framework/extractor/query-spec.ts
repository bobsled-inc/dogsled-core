import { z } from 'zod';

export const QUERY_OPERATORS = [
  'eq',
  'contains',
  'gte',
  'lte',
  'ne',
  'lt',
  'gt',
  'not',
  'in',
] as const;

export const QueryOperatorSchema = z.enum(QUERY_OPERATORS);
const QueryScalarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const QueryBindSchema = z
  .object({
    input: z.string(),
    preserve_default: z.boolean().optional(),
  })
  .strict();

export const QueryFilterCompileModeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('http_query'),
      param: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('direct_arg'),
      argument: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('filter_dsl'),
      expression: z.string().min(1),
    })
    .strict(),
]);

const QueryFilterCompileByOperatorSchema = z
  .object({
    eq: QueryFilterCompileModeSchema.optional(),
    contains: QueryFilterCompileModeSchema.optional(),
    gte: QueryFilterCompileModeSchema.optional(),
    lte: QueryFilterCompileModeSchema.optional(),
    ne: QueryFilterCompileModeSchema.optional(),
    lt: QueryFilterCompileModeSchema.optional(),
    gt: QueryFilterCompileModeSchema.optional(),
    not: QueryFilterCompileModeSchema.optional(),
    in: QueryFilterCompileModeSchema.optional(),
  })
  .strict();

const QueryFilterCompileSchema = z.union([
  QueryFilterCompileModeSchema,
  QueryFilterCompileByOperatorSchema,
]);

const QueryFilterBindingsSchema = z
  .object({
    eq: QueryBindSchema.optional(),
    contains: QueryBindSchema.optional(),
    gte: QueryBindSchema.optional(),
    lte: QueryBindSchema.optional(),
    ne: QueryBindSchema.optional(),
    lt: QueryBindSchema.optional(),
    gt: QueryBindSchema.optional(),
    not: QueryBindSchema.optional(),
    in: QueryBindSchema.optional(),
  })
  .strict();

export const QueryFilterFieldSchema = z
  .object({
    compile: QueryFilterCompileSchema.default({ mode: 'http_query' }),
    operators: z.array(QueryOperatorSchema).min(1),
    enum: z.array(QueryScalarValueSchema).min(1).optional(),
    description: z.string().optional(),
    bind: QueryFilterBindingsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const operatorSet = new Set(value.operators);
    if (operatorSet.size !== value.operators.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query filter operators must be unique',
        path: ['operators'],
      });
    }

    const declaredBindings = Object.entries(value.bind)
      .filter(([, binding]) => binding !== undefined)
      .map(([operator]) => operator);

    for (const operator of value.operators) {
      if (!value.bind[operator]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `query filter operator "${operator}" must define a matching bind entry`,
          path: ['bind', operator],
        });
      }
    }

    for (const operator of declaredBindings) {
      if (!operatorSet.has(operator as z.infer<typeof QueryOperatorSchema>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `query filter bind "${operator}" must also be listed in operators`,
          path: ['bind', operator],
        });
      }
    }

    if ('mode' in value.compile) {
      return;
    }

    for (const [operator, compileConfig] of Object.entries(value.compile)) {
      if (!compileConfig) {
        continue;
      }
      if (!operatorSet.has(operator as z.infer<typeof QueryOperatorSchema>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `query filter compile "${operator}" must also be listed in operators`,
          path: ['compile', operator],
        });
      }
    }
  });

export const QuerySearchSchema = z
  .object({
    dialect: z.string().min(1),
    bind: QueryBindSchema,
    append: z.string().min(1).optional(),
    docs: z.string().url().optional(),
  })
  .strict();

export const QuerySpecSchema = z
  .object({
    filters: z.record(z.string(), QueryFilterFieldSchema).optional(),
    search: QuerySearchSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((!value.filters || Object.keys(value.filters).length === 0) && value.search === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query must define at least one filter or a search block',
        path: ['filters'],
      });
    }
  });
