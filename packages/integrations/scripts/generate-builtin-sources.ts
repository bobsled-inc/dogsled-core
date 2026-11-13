/**
 * Generator for the embedded built-in source files.
 *
 * Reads every file under `packages/integrations/sources/` and writes them to
 * `src/builtin-sources/generated-data.ts` as one constant keyed by the
 * POSIX path relative to `sources/`.
 *
 * Why embed instead of reading `sources/` at runtime: bundlers (Nitro,
 * Vercel, esbuild) move the compiled loader to a new folder, so a path
 * computed from the loader's own file no longer points at `sources/`.
 * A JavaScript constant travels with the code wherever it is bundled.
 *
 * Run via:
 *   pnpm --filter @bobsled-inc/integrations generate:sources
 *
 * Wired into `pnpm build` before the catalog and validation generators,
 * which read the sources through the loader. The drift-guard test
 * (`tests/builtin-sources-generated-data.test.ts`) verifies the committed
 * file matches the YAML on disk.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES_ROOT = join(__dirname, '..', 'sources');
const OUTPUT_PATH = join(__dirname, '..', 'src', 'builtin-sources', 'generated-data.ts');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND. @generated
 *
 * Regenerate with:
 *   pnpm --filter @bobsled-inc/integrations generate:sources
 *
 * The drift-guard test in \`tests/builtin-sources-generated-data.test.ts\`
 * fails CI if this file falls out of sync with the files under
 * \`packages/integrations/sources/\`.
 */
`;

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Unsupported entry in sources/: ${relative(SOURCES_ROOT, path)}`);
    }
  }
  return files;
}

export function collectBuiltInSourceFiles(root: string = SOURCES_ROOT): Record<string, string> {
  const entries = listFiles(root)
    .map((path) => [relative(root, path).split(sep).join('/'), path] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, path]) => [key, readFileSync(path, 'utf-8')]));
}

export function renderBuiltInSourcesModule(): string {
  const body = JSON.stringify(collectBuiltInSourceFiles(), null, 2);
  return `${HEADER}
export const BUILT_IN_SOURCE_FILES: Readonly<Record<string, string>> = ${body};
`;
}

async function main(): Promise<void> {
  writeFileSync(OUTPUT_PATH, renderBuiltInSourcesModule());
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
