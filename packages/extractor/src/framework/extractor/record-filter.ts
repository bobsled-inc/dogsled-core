import { z } from 'zod';

import { InputFieldSchema, OutputFieldSchema } from '../core/index.js';

const RECORD_FILTER_SCALAR_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
]);

export const RecordFilterSchema = z
  .object({
    field: z.string(),
    input: z.string(),
    operator: z.literal('in'),
    delimiter: z.string().min(1).max(8).optional(),
  })
  .strict();

export type RecordFilter = z.infer<typeof RecordFilterSchema>;

export const RecordFiltersSchema = z.array(RecordFilterSchema).min(1).max(16);

function addIssue(ctx: z.RefinementCtx, path: string[], message: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path,
  });
}

export function validateRecordFilters(
  value: {
    input: Record<string, z.infer<typeof InputFieldSchema>>;
    output: Record<string, z.infer<typeof OutputFieldSchema>>;
    extract: { record_filters?: RecordFilter[] };
  },
  ctx: z.RefinementCtx
): void {
  value.extract.record_filters?.forEach((filter, index) => {
    const outputField = value.output[filter.field];
    if (!outputField) {
      addIssue(
        ctx,
        ['extract', 'record_filters', String(index), 'field'],
        `record_filters field "${filter.field}" must reference an output field`
      );
    } else if (!RECORD_FILTER_SCALAR_OUTPUT_TYPES.has(outputField.type)) {
      addIssue(
        ctx,
        ['extract', 'record_filters', String(index), 'field'],
        `record_filters field "${filter.field}" must reference a scalar output field ` +
          `(string, integer, number, boolean, timestamp) but got "${outputField.type}"`
      );
    }

    if (!Object.prototype.hasOwnProperty.call(value.input, filter.input)) {
      addIssue(
        ctx,
        ['extract', 'record_filters', String(index), 'input'],
        `record_filters input "${filter.input}" must reference a resource input`
      );
    }
  });
}
