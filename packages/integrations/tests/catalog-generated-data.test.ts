/**
 * Drift guard for `src/catalog/generated-data.ts`.
 *
 * The runtime `buildCatalogManifest()` returns the constant baked into
 * `generated-data.ts` (committed). If a developer edits the source
 * YAMLs without regenerating, the runtime gives stale results to every
 * downstream consumer. This test walks the YAMLs fresh and asserts the
 * committed file matches — if not, CI fails with a clear "run
 * `pnpm generate:catalog`" pointer.
 */

import { describe, expect, it } from 'vitest';

import { buildCatalogManifestFromYaml, resourceOutput } from '../src/catalog/yaml-walker.js';
import { renderGeneratedDataModule } from '../scripts/generate-catalog-manifest.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GENERATED_PATH = join(__dirname, '..', 'src', 'catalog', 'generated-data.ts');
const CATALOG_DRIFT_TIMEOUT_MS = 30_000;

describe('catalog generated-data.ts drift guard', () => {
  it('reads warehouse V2 schema.columns as catalog output fields', () => {
    const columns = {
      id: { type: 'integer' },
      created_at: { type: 'timestamp' },
    };
    expect(resourceOutput({ name: 'orders', schema: { columns } })).toEqual(columns);
  });

  it(
    'matches the walker output — run `pnpm generate:catalog` if this fails',
    () => {
      const committed = readFileSync(GENERATED_PATH, 'utf-8');
      const fresh = renderGeneratedDataModule();
      expect(committed).toBe(fresh);
    },
    CATALOG_DRIFT_TIMEOUT_MS
  );

  it('the runtime constant agrees with the walker (sanity check)', () => {
    const fresh = buildCatalogManifestFromYaml();
    expect(fresh.summary.source_count).toBeGreaterThan(0);
    expect(fresh.sources.length).toBe(fresh.summary.source_count);
  });
});
