/** Generate the committed, runtime-safe integration validation snapshot. */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { buildIntegrationValidationCatalogFromYaml } from '../src/validation/yaml-walker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = join(__dirname, '..', 'src', 'validation', 'generated-data.ts');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with:
 *   pnpm --filter @bobsled-inc/integrations generate:validation-catalog
 *
 * The drift-guard test in \`tests/validation-generated-data.test.ts\` compares
 * this snapshot with every YAML file under \`packages/integrations/sources/\`.
 */
`;

export async function renderIntegrationValidationCatalogModule(): Promise<string> {
  const catalog = buildIntegrationValidationCatalogFromYaml();
  const source = `${HEADER}
import type { IntegrationValidationCatalog } from './types.js';

export const INTEGRATION_VALIDATION_CATALOG: IntegrationValidationCatalog = ${JSON.stringify(catalog, null, 2)};
`;
  return format(source, {
    ...(await resolveConfig(OUTPUT_PATH)),
    filepath: OUTPUT_PATH,
  });
}

async function main(): Promise<void> {
  writeFileSync(OUTPUT_PATH, await renderIntegrationValidationCatalogModule());
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
