import { z } from 'zod';

import { identifierMsg, identifierRegex } from '../compiler/shared-validators.js';
import { boundedJson } from '../interchange/storage.js';

const MAX_METADATA_BYTES = 1_000_000;

const AiContextObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(boundedJson, 'AI context must be bounded JSON data (maximum depth 40 and 1 MB)');

/** Open AI guidance copied without assigning meaning to its property names. */
export const AiContextSchema = z.union([z.string().max(MAX_METADATA_BYTES), AiContextObjectSchema]);

export const SemanticExpressionSchema = z
  .object({
    dialects: z
      .array(
        z
          .object({
            dialect: z.string().trim().min(1),
            expression: z.string().min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export const SemanticFieldMetadataSchema = z.object({
  semantic_expression: SemanticExpressionSchema.optional(),
  is_time: z.boolean().optional(),
  ai_context: AiContextSchema.optional(),
});

export const OssieLogicalDataTypeSchema = z.enum([
  'String',
  'Integer',
  'Decimal',
  'Float',
  'Boolean',
  'Date',
  'Time',
  'DateTime',
  'DateTimeTz',
  'Opaque',
]);

/** A bare name is a derived model. `<connection>.<source>` is a source. */
export const DatasetReferenceSchema = z
  .string()
  .trim()
  .min(1, 'Dataset reference is required')
  .regex(
    new RegExp(
      `^${identifierRegex.source.slice(1, -1)}(?:\\.${identifierRegex.source.slice(1, -1)})?$`
    ),
    `${identifierMsg}; source references use <connection>.<source>`
  );

export type AiContext = z.infer<typeof AiContextSchema>;
export type SemanticExpression = z.infer<typeof SemanticExpressionSchema>;
export type OssieLogicalDataType = z.infer<typeof OssieLogicalDataTypeSchema>;
export type DatasetReference = z.infer<typeof DatasetReferenceSchema>;
