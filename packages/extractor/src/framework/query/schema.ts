import { z } from 'zod';

export const QueryCompileModeSchema = z.enum(['http_query', 'direct_arg', 'filter_dsl']);

export const QueryCompileConfigSchema = z
  .object({
    mode: QueryCompileModeSchema,
    builder: z.string().min(1).optional(),
    argument: z.string().min(1).optional(),
    field_map: z.record(z.string(), z.string()).optional(),
    field_types: z.record(z.string(), z.string()).optional(),
    operator_map: z.record(z.string(), z.string()).optional(),
    base: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.mode === 'filter_dsl' && !value.builder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filter_dsl compile mode requires a builder',
        path: ['builder'],
      });
    }
  });

export type QueryCompileMode = z.infer<typeof QueryCompileModeSchema>;
export type QueryCompileConfig = z.infer<typeof QueryCompileConfigSchema>;
