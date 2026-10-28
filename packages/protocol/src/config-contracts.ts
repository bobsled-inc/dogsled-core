import {
  BedrockRegionSchema,
  ModelAuthEnvVarsSchema,
  OllamaBaseUrlSchema,
  validateModelProviderConfig,
  ModelProviderConfigError,
} from './model-provider-security.js';
import { z } from 'zod';

/**
 * A configuration value that defers secret resolution to the runtime
 * environment. Literal secrets must never be persisted in Dogsled config.
 */
export const EnvPlaceholderSchema = z
  .string()
  .regex(
    /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{\{\s*env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\})$/,
    'Must be an environment variable placeholder like $MY_TOKEN or ${{ env.MY_TOKEN }}'
  );

const BaseModelConnectionSchema = z
  .object({
    model: z.string().min(1),
    auth_env_vars: ModelAuthEnvVarsSchema,
    dimension: z.number().int().positive().optional(),
    cost_budget_usd: z.number().positive().optional(),
  })
  .strict();

export const BedrockModelConnectionSchema = BaseModelConnectionSchema.extend({
  provider: z.literal('amazon-bedrock'),
  region: BedrockRegionSchema.default('us-east-1'),
  api_key: EnvPlaceholderSchema.optional(),
});

export const ApiKeyModelConnectionSchema = BaseModelConnectionSchema.extend({
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter', 'typesafe']),
  api_key: EnvPlaceholderSchema,
});

export const AiGatewayModelConnectionSchema = BaseModelConnectionSchema.extend({
  provider: z.literal('ai-gateway'),
  model: z.string().regex(/^[^/\s]+\/\S+$/, 'AI Gateway model IDs must be namespaced'),
  api_key: EnvPlaceholderSchema,
});

export const OllamaModelConnectionSchema = BaseModelConnectionSchema.extend({
  provider: z.literal('ollama'),
  base_url: OllamaBaseUrlSchema.default('http://127.0.0.1:11434/api'),
});

export const ModelConnectionSchema = z
  .discriminatedUnion('provider', [
    BedrockModelConnectionSchema,
    ApiKeyModelConnectionSchema,
    AiGatewayModelConnectionSchema,
    OllamaModelConnectionSchema,
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

export const PlatformBudgetSchema = z
  .object({
    ai_cost_daily_usd: z.number().positive().optional(),
    per_source_rpm: z.number().int().positive().optional(),
  })
  .strict();

export const PlatformConfigSchema = z
  .object({
    models: z.record(z.string().min(1), ModelConnectionSchema).optional(),
    budget: PlatformBudgetSchema.optional(),
    lazy_cache: z.unknown().optional(),
    system_store: z.unknown().optional(),
    principals: z.unknown().optional(),
    groups: z.unknown().optional(),
  })
  .strict();

export type ModelConnection = z.infer<typeof ModelConnectionSchema>;
export type PlatformBudget = z.infer<typeof PlatformBudgetSchema>;
export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
