/**
 * Generator script for the catalog manifest.
 *
 * Walks the prebuilt source YAMLs via `buildCatalogManifestFromYaml()`
 * and writes the resulting `CatalogManifest` to
 * `src/catalog/generated-data.ts` as a typed constant.
 *
 * Why generated TS instead of a runtime walk: serverless bundlers
 * (Vercel standalone, etc.) trace JS imports but not runtime
 * `fs.readdirSync` reads. A pre-baked constant makes the catalog
 * available to every consumer without bundler workarounds.
 *
 * Run via:
 *   pnpm --filter @bobsled-inc/integrations generate:catalog
 *
 * Wired into `pnpm build` so the generated file is always in sync with
 * the source YAMLs after a build. A drift-guard test
 * (`tests/catalog-generated-data.test.ts`) verifies the committed file
 * matches the walker output.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCatalogManifestFromYaml } from '../src/catalog/yaml-walker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_PATH = join(__dirname, '..', 'src', 'catalog', 'generated-data.ts');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with:
 *   pnpm --filter @bobsled-inc/integrations generate:catalog
 *
 * The drift-guard test in \`tests/catalog-generated-data.test.ts\`
 * fails CI if this file falls out of sync with the source YAMLs under
 * \`packages/integrations/sources/\`.
 */
`;

export function renderGeneratedDataModule(): string {
  const manifest = buildCatalogManifestFromYaml();
  const body = JSON.stringify(manifest, null, 2);
  return `${HEADER}
import type { CatalogManifest } from './types.js';

export const CATALOG_MANIFEST: CatalogManifest = ${body};
`;
}

async function main(): Promise<void> {
  const rendered = renderGeneratedDataModule();
  writeFileSync(OUTPUT_PATH, rendered);
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
