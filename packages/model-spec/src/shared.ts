// Shared CLI utilities exported for consumption by @bobsled-inc/entity-graph.
// Programmatic library consumers should prefer the default compiler exports.

export { identifierRegex, identifierMsg, identifierSchema } from './compiler/shared-validators.js';
export {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_TRUST_WEIGHTS,
  DEFAULT_TRUST_TIER_THRESHOLDS,
} from './compiler/profile-defaults.js';

export { loadProjectConfig, resolveConfig } from './config.js';
export * from './output.js';
export * as out from './output.js';
export {
  assertOk,
  buildCommandContext,
  buildCommandContextWithConfig,
  buildDagContext,
  createDialectOption,
  createIntegrationOption,
  DEFAULT_DIALECT,
  DEFAULT_SCHEMA,
  loadRunnerModule,
  MODELS_DIR,
  parseGlobalFlags,
  parsePositiveIntOption,
  resolvePathWithinDir,
  SOURCES_DIR,
  trackEphemeralModel,
  validateScaffoldName,
  validateSchema,
} from './commands/common.js';
export { resolveActiveIntegration, resolveIntegrationByHandle } from './integrations.js';
export type { ResolvedIntegration } from './integrations.js';
export type {
  CommandContext,
  CompileContext,
  DagContext,
  GlobalFlags,
  ResolvedConfig,
} from './commands/common.js';
