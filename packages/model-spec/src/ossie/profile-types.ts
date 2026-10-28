import { z } from 'zod';

const customExtension = z.object({ vendor_name: z.string(), data: z.string() }).strict();
const expression = z
  .object({
    dialects: z.array(z.object({ dialect: z.string(), expression: z.string() }).strict()),
  })
  .strict();
const field = z
  .object({
    name: z.string(),
    expression,
    dimension: z.object({ is_time: z.boolean().optional() }).strict().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    datatype: z.string().optional(),
    ai_context: z.unknown().optional(),
    custom_extensions: z.array(customExtension).optional(),
  })
  .passthrough();
const dataset = z
  .object({
    name: z.string(),
    source: z.string(),
    primary_key: z.array(z.string()).optional(),
    unique_keys: z.array(z.array(z.string())).optional(),
    description: z.string().optional(),
    ai_context: z.unknown().optional(),
    fields: z.array(field).optional(),
    custom_extensions: z.array(customExtension).optional(),
  })
  .passthrough();
const metric = z
  .object({
    name: z.string(),
    expression,
    description: z.string().optional(),
    datatype: z.string().optional(),
    ai_context: z.unknown().optional(),
    custom_extensions: z.array(customExtension).optional(),
  })
  .passthrough();
const relationship = z
  .object({
    name: z.string(),
    from: z.string(),
    to: z.string(),
    from_columns: z.array(z.string()),
    to_columns: z.array(z.string()),
    ai_context: z.unknown().optional(),
    custom_extensions: z.array(customExtension).optional(),
  })
  .passthrough();

export const OssieSemanticModelSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    ai_context: z.unknown().optional(),
    datasets: z.array(dataset),
    metrics: z.array(metric).optional(),
    relationships: z.array(relationship).optional(),
    custom_extensions: z.array(customExtension).optional(),
  })
  .passthrough();

export type OssieSemanticModel = z.infer<typeof OssieSemanticModelSchema>;
export type OssieDataset = z.infer<typeof dataset>;
export type OssieField = z.infer<typeof field>;
export type OssieMetric = z.infer<typeof metric>;
export type OssieRelationship = z.infer<typeof relationship>;

export interface ParsedOssieDocument {
  profile: '0.1.1' | '0.2.0.dev0';
  semanticModels: OssieSemanticModel[];
}
