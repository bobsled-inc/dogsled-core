/**
 * `@bobsled-inc/integrations/catalog` — subpath entry point.
 *
 * Re-exports the catalog manifest types and builders from a clean island
 * that does NOT pull in `@bobsled-inc/extractor` (and therefore does not
 * load the DuckDB native binding at module init).
 *
 * Consumers running in environments without `libduckdb.so` available at
 * runtime (e.g. Vercel serverless functions) should import from this
 * subpath instead of the package root:
 *
 *   // ❌ pulls in @bobsled-inc/extractor → DuckDB → fails on Vercel:
 *   import { buildCatalogManifest } from '@bobsled-inc/integrations';
 *
 *   // ✅ clean island, no native dependencies:
 *   import { buildCatalogManifest } from '@bobsled-inc/integrations/catalog';
 *
 * The package root still re-exports the catalog API for backward
 * compatibility; existing consumers don't need to change unless they
 * hit the load failure described above.
 */

export {
  CATALOG_MANIFEST_JSON_SCHEMA,
  CATALOG_MANIFEST_SCHEMA_VERSION,
  type CatalogAuthSetupEntry,
  type CatalogColumn,
  type CatalogColumnType,
  type CatalogInputField,
  type CatalogIncrementalStrategy,
  type CatalogManifest,
  type CatalogManifestSummary,
  type CatalogResource,
  type CatalogResourceTransportVariant,
  type CatalogSource,
  type CatalogSourceType,
  type CatalogTransportConfig,
} from './types.js';

export {
  CatalogProbeDefinitionSchema,
  ProbeResourceDefinitionSchema,
  probeApiResource,
  probeResource,
} from './probe.js';
export type {
  CatalogProbeApi,
  CatalogProbeAuth,
  CatalogProbeDefinition,
  CatalogProbeFieldType,
  CatalogProbeHttpMethod,
  CatalogProbeInputField,
  CatalogProbeJsonValue,
  CatalogProbeRequestPhase,
  CatalogProbeResource,
  CatalogProbeSource,
  CatalogProbeTransport,
  ExternalProbeApiResourceTarget,
  ProbeApiResourceExecutor,
  ProbeApiResourceExecutorRequest,
  ProbeApiResourceFailureCode,
  ProbeApiResourceOptions,
  ProbeApiResourceReference,
  ProbeApiResourceResponse,
  ProbeApiResourceResult,
  ProbeApiResourceTarget,
} from './probe.js';

export {
  buildCatalogManifest,
  catalogForEachParent,
  renderCatalogManifestJson,
} from './manifest.js';
