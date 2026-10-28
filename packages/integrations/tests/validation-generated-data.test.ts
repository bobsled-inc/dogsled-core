/** Drift guard for the runtime-safe generated validation snapshot. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderIntegrationValidationCatalogModule } from '../scripts/generate-validation-catalog.js';
import { buildIntegrationValidationCatalogFromYaml } from '../src/validation/yaml-walker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = join(__dirname, '..', 'src', 'validation', 'generated-data.ts');
const VALIDATION_CATALOG_DRIFT_TIMEOUT_MS = 30_000;

describe('validation generated-data.ts drift guard', () => {
  it(
    'matches every source YAML — run `pnpm generate:validation-catalog` if this fails',
    async () => {
      expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(
        await renderIntegrationValidationCatalogModule()
      );
    },
    VALIDATION_CATALOG_DRIFT_TIMEOUT_MS
  );

  it('walks a non-empty deterministic catalog', () => {
    const catalog = buildIntegrationValidationCatalogFromYaml();
    expect(catalog.sources.length).toBeGreaterThan(0);
    expect(catalog.sources.map((source) => source.name)).toEqual(
      [...catalog.sources.map((source) => source.name)].sort((a, b) => a.localeCompare(b))
    );
  });
});
