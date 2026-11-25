export { assertExhaustive } from './assert-exhaustive.js';
export {
  CallBudgetExceeded,
  DailyBudgetExceeded,
  InvalidBudgetCost,
  MemoryBudgetLedger,
  MissingProjectKey,
  enforceBudget,
  finalizeBudgetReservation,
  isBudgetError,
  reserveBudget,
} from './budget.js';
export { embedMany } from './embed.js';
export type { EmbedManyOptions } from './embed.js';
export { connectHostEmbedding } from './host-embedding.js';
export type {
  HostEmbeddingConnection,
  HostEmbeddingOptions,
  HostEmbeddingResult,
} from './host-embedding.js';
export { HostEmbeddingError } from './host-embedding-response.js';
export type {
  HostEmbeddingErrorCode,
  HostEmbeddingLimits,
  HostEmbeddingModel,
} from './host-embedding-response.js';
export { generateStructured } from './generate.js';
export type { GenerateOptions } from './generate.js';
export { generateStream } from './stream.js';
export type { GenerateStreamOptions } from './stream.js';
export { resolveProviderModels } from './providers.js';
export {
  currentModelVersionFor,
  DEFAULT_MODEL_FAMILY_ID,
  MODEL_FAMILIES,
  MODEL_FAMILY_IDS,
  modelFamilyFor,
  RETIRED_MODEL_IDS,
} from './model-families.js';
export type { ModelFamilyId } from './model-families.js';
export { resolveModelConnection } from './resolve.js';
export { knownModelCostUsd } from './pricing.js';
export type {
  BudgetLedger,
  BudgetUsage,
  DeltaEvent,
  EmbedInput,
  EmbedResult,
  GenerateStructuredOptions,
  GenerateStructuredResult,
  ModelConnection,
  PlatformConfig,
  StructuredTokenUsage,
} from './types.js';
