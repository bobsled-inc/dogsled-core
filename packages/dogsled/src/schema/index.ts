/**
 * `@bobsled-inc/dogsled/schema` — schema & catalog-only entry point.
 *
 * This barrel has zero static path to execution/runtime code (and therefore
 * to the DuckDB native binding `@duckdb/node-api`). Consumers that only need
 * to validate or synthesize Dogsled config — e.g. a web app's config routes —
 * should import from here instead of `@bobsled-inc/dogsled/sync`,
 * `@bobsled-inc/dogsled/actions`, or the package root, all of which co-locate
 * execution exports (`runSync`, `executeAction`, `runBatchActions`) that pull
 * in the extractor runtime barrel.
 *
 * Importing those execution barrels for a "metadata" symbol like
 * `SyncSpecSchema` evaluates the whole module graph, which statically reaches
 * `@bobsled-inc/extractor` (its `.` entry re-exports `BatchWriter`). That is
 * the package-boundary violation this entry point exists to avoid.
 *
 * The guarantee is enforced by `tests/unit/schema-import-safety.test.ts`,
 * which asserts the built bundle never references `@duckdb/node-api`. (Note
 * this prevents schema/catalog imports from causing that class of runtime
 * failure — it does not stop a consumer that deliberately imports an
 * execution entry point.)
 *
 * Sourcing notes — every re-export below is a clean leaf or clean island:
 *   - ActionSpecSchema / ActionSpec   ← @bobsled-inc/extractor/extractor (schema-only barrel)
 *   - SyncSpec* + parse/load/list      ← ../sync/spec.js (leaf; NOT the ./sync barrel)
 *   - action catalog lookups           ← @bobsled-inc/integrations/actions (clean island)
 *   - source/catalog manifest builders ← @bobsled-inc/integrations/catalog (clean island)
 */

// ── Action spec schema ──────────────────────────────────────────────────────
export { ActionSpecSchema } from '@bobsled-inc/extractor/extractor';
export type { ActionSpec } from '@bobsled-inc/extractor/extractor';

// ── Sync spec schema + loaders (leaf module, not the ./sync barrel) ──────────
export {
  SyncSpecSchema,
  SyncSpecInputSchema,
  parseSyncSpecFile,
  listSyncSpecs,
  loadSyncSpec,
  type SyncSpec,
  type LoadedSyncSpec,
} from '../sync/spec.js';

// ── In-memory reverse-ETL action builders (clean leaf) ───────────────────────
export {
  buildReverseEtlActionFromSpec,
  buildSalesforceUpsertAction,
  pruneUnmappedOptionalInputs,
  type BuildReverseEtlActionOptions,
  type BuildSalesforceUpsertActionOptions,
} from '../reverse-etl/build-action.js';

// ── Integration action catalog (clean island) ───────────────────────────────
export * from '@bobsled-inc/integrations/actions';

// ── Source / integration catalog manifest (clean island) ────────────────────
export * from '@bobsled-inc/integrations/catalog';
