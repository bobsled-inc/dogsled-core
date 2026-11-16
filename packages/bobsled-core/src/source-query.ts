/**
 * Public library surface for the lazy/live source-query engine.
 *
 * Exposes the same engine that powers the `bobsled source-query` (alias `vq`)
 * CLI so host applications can drive it programmatically: inject source entries
 * in memory, supply a default destination and/or warehouse SQL runner, and pass
 * API secrets without mutating `process.env`.
 *
 * See `docs/source-query-programmatic-api.md` for an end-to-end example.
 */

export {
  LazyQueryEngine,
  runQueryCommand,
  referencedSources,
  maxSqlLimitLiteral,
  isMissingTableError,
} from './runtime/lazy-query-engine.js';
export type {
  RunQueryArgs,
  RunQueryResult,
  LazyQueryEngineDeps,
} from './runtime/lazy-query-engine.js';

export { resolveDestinationFor } from './runtime/source-materializer/destination-resolver.js';
export type {
  ResolvedDestination,
  ResolveDestinationArgs,
} from './runtime/source-materializer/destination-resolver.js';

export {
  loadApiResourceEntries,
  sourceNameOf,
  sourceReferenceOf,
} from './runtime/source-materializer/load-specs.js';
export type { ApiResourceEntry } from './runtime/source-materializer/load-specs.js';

export { resolveSourceMaterializerFlags } from './runtime/source-materializer/feature-flags.js';
export type { SourceMaterializerFeatureFlags } from './runtime/source-materializer/feature-flags.js';

export { createSqlRunnerFor } from './runtime/source-materializer/sql-runner-bridge.js';

// Query-time derived-model resolution. `resolveModelReferences` is the pure SQL
// front-end that splices any referenced Model Spec model's self-contained SELECT in as
// a leading CTE before the engine runs, so host applications can support
// `SELECT ... FROM <model>` over live/lazy sources (not just `sources.<name>`).
// `detectModelReferences` is exposed for hosts that need to know which model
// names a query references without rewriting it.
export { resolveModelReferences, detectModelReferences } from './runtime/model-query.js';
export type { ResolveModelReferencesOptions } from './runtime/model-query.js';

// Warehouse-leaf staging brick. `stageWarehouseSourceIntoDuckDb` reads a foreign
// `warehouse_table` source via a caller-provided runner and lands it as
// `sources.<name>` in a DuckDB/DuckLake engine, so a host can co-locate a
// warehouse table next to live/lazy `sources.*` tables and then resolve a derived
// model that joins them (via `resolveModelReferences`) — without re-implementing
// the read -> JSONL -> load staging. `createRunnerDuckDbDestination` wraps a
// DuckDB `SqlRunnerModule` (e.g. from `createSqlRunnerFor`) as the
// `DatabaseDestination` the brick writes through.
export { stageWarehouseSourceIntoDuckDb } from './runtime/source-materializer/stage-warehouse-source.js';
export type {
  StageWarehouseSourceArgs,
  StageWarehouseSourceResult,
} from './runtime/source-materializer/stage-warehouse-source.js';
export { createRunnerDuckDbDestination } from './runtime/source-materializer/runner-duckdb-destination.js';

// Freshness-aware wrapper over the brick. `materializeWarehouseLeaf` gives a
// warehouse leaf the same `live`/`lazy` read semantics an api_resource leaf has:
// `live` always re-reads, `lazy` reuses a staged snapshot within `maxAge` via the
// generic `_bobsled_source_metadata` freshness table. The read mode is a
// per-reference call argument (not a source-entry field), and the `maxRows` OOM
// ceiling bounds every (re)stage. A host application drives this directly to cache a foreign warehouse table next to its
// live/lazy `sources.*` tables before resolving a mixed model that joins them.
export {
  materializeWarehouseLeaf,
  DEFAULT_WAREHOUSE_LEAF_ROW_CEILING,
} from './runtime/source-materializer/materialize-warehouse-leaf.js';
export type {
  MaterializeWarehouseLeafArgs,
  MaterializeWarehouseLeafResult,
  WarehouseLeafReadMode,
} from './runtime/source-materializer/materialize-warehouse-leaf.js';

// Deployed-definition planning. This is the small host seam for products that
// persist Bobsled Core definitions outside a project directory: Bobsled Core validates the
// definitions, derives the transitive execution mode/closure, assigns safe
// internal source tables, and folds model SQL for DuckDB.
export {
  analyzeDeployedModelProject,
  planDeployedModelExecution,
} from '@bobsled-inc/model-spec/project';
export type {
  AnalyzeDeployedModelProjectOptions,
  DeployedModelAnalysis,
  DeployedModelExecutionClosure,
  DeployedModelExecutionMode,
  DeployedModelExecutionPlan,
  DeployedModelSourceBinding,
  PlanDeployedModelExecutionOptions,
} from '@bobsled-inc/model-spec/project';
