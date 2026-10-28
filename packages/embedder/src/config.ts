import {
  BedrockRegionSchema,
  ModelAuthEnvVarsSchema,
  OllamaBaseUrlSchema,
  validateModelProviderConfig,
  ModelProviderConfigError,
} from '@bobsled-inc/protocol';
import { z } from 'zod';

export const EmbedFieldConfigSchema = z
  .object({
    field: z.string().min(1),
    as: z.string().min(1).optional(),
  })
  .strict();

export const EmbedStreamsSchema = z
  .record(z.string(), z.array(EmbedFieldConfigSchema).min(1))
  .refine((streams) => Object.keys(streams).length > 0, {
    message: 'Embed config must configure at least one stream',
  });

export function createEmbedConfigSchema<TApiKeySchema extends z.ZodType<string>>(
  apiKeySchema: TApiKeySchema
) {
  const baseFields = {
    model: z.string().min(1),
    auth_env_vars: ModelAuthEnvVarsSchema,
    dimension: z.number().int().positive().optional(),
    cost_budget_usd: z.number().positive().optional(),
    streams: EmbedStreamsSchema,
  } as const;

  return z
    .discriminatedUnion('provider', [
      z
        .object({
          ...baseFields,
          provider: z.literal('amazon-bedrock'),
          region: BedrockRegionSchema.default('us-east-1'),
          api_key: apiKeySchema.optional(),
        })
        .strict(),
      z
        .object({
          ...baseFields,
          provider: z.enum(['openai', 'anthropic', 'google', 'openrouter']),
          api_key: apiKeySchema,
        })
        .strict(),
      z
        .object({
          ...baseFields,
          provider: z.literal('ollama'),
          base_url: OllamaBaseUrlSchema.default('http://127.0.0.1:11434/api'),
        })
        .strict(),
    ])
    .superRefine((config, ctx) => {
      try {
        validateModelProviderConfig(config);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: [error instanceof ModelProviderConfigError ? error.field : 'api_key'],
          message: error instanceof Error ? error.message : 'Invalid provider configuration',
        });
      }
    });
}

export const EmbedderConfigSchema = createEmbedConfigSchema(z.string().min(1));

export type EmbedFieldConfig = z.infer<typeof EmbedFieldConfigSchema>;
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;
