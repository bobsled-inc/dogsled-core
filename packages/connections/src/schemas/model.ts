/**
 * Compatibility re-export. These metadata-only configuration contracts are
 * protocol-owned so manifests do not need to load connection runtime code.
 */
export {
  AiGatewayModelConnectionSchema,
  ApiKeyModelConnectionSchema,
  BedrockModelConnectionSchema,
  EnvPlaceholderSchema,
  ModelConnectionSchema,
  OllamaModelConnectionSchema,
  PlatformBudgetSchema,
  PlatformConfigSchema,
} from '@bobsled-inc/protocol';
export type { ModelConnection, PlatformBudget, PlatformConfig } from '@bobsled-inc/protocol';
