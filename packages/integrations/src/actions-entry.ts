/**
 * `@bobsled-inc/integrations/actions` — subpath entry point.
 *
 * Clean island exposing the action catalog lookups (`getAction`,
 * `listActions`, …) WITHOUT pulling in the package root barrel, which
 * re-exports the query-resources tree and `@bobsled-inc/extractor`'s runtime
 * barrel.
 *
 * `actions.ts` itself only depends on the schema-only
 * `@bobsled-inc/extractor/extractor` barrel plus pure filesystem/YAML helpers,
 * so importing it has no static path to the DuckDB native binding. Consumers
 * running where `libduckdb` is unavailable (e.g. Vercel serverless, the web
 * app's config-validation routes) should import action lookups from this
 * subpath instead of the package root:
 *
 *   // ❌ pulls in the query-resources tree → @bobsled-inc/extractor runtime:
 *   import { getAction } from '@bobsled-inc/integrations';
 *
 *   // ✅ clean island:
 *   import { getAction } from '@bobsled-inc/integrations/actions';
 *
 * Mirrors the `./catalog` island. See `src/catalog/index.ts`.
 */

export {
  filterActions,
  findAction,
  getAction,
  listActions,
  loadActions,
  loadBuiltInActions,
  type Action,
  type ActionFilter,
  type ActionLookupResult,
} from './actions.js';
