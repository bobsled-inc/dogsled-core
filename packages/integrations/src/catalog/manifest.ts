/**
 * Catalog manifest runtime entry point.
 *
 * `buildCatalogManifest()` returns the constant baked into the bundle at
 * build time by `scripts/generate-catalog-manifest.ts` (which calls the
 * YAML walker in `./yaml-walker.ts` once and serializes the result into
 * `./generated-data.ts`). Zero filesystem I/O at runtime; safe to call
 * from any environment (Vercel serverless, edge runtimes, etc.).
 *
 * If you've just edited a source YAML and want to see the change here,
 * run `pnpm --filter @bobsled-inc/integrations generate:catalog` (or
 * just `pnpm --filter @bobsled-inc/integrations build`).
 */

import { CATALOG_MANIFEST } from './generated-data.js';
import type { CatalogManifest } from './types.js';

export function buildCatalogManifest(): CatalogManifest {
  return CATALOG_MANIFEST;
}

export function renderCatalogManifestJson(
  manifest: CatalogManifest = buildCatalogManifest()
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Look up the for_each parent (canonical entity name) for a resource in a
 * bundled catalog source — or `undefined` when the source/resource isn't in the
 * catalog or the resource declares no `extract.for_each`.
 *
 * Lets consumers validate or schedule bundled-catalog resources whose YAML is
 * not present in the user's project. The parent edge ensures a `for_each`
 * child is selected alongside the resource that supplies its iteration values.
 */
export function catalogForEachParent(
  source: string,
  resource: string,
  manifest: CatalogManifest = buildCatalogManifest()
): string | undefined {
  const src = manifest.sources.find((s) => s.name === source);
  if (!src) return undefined;
  return src.resources.find((r) => r.name === resource)?.for_each_parent;
}
