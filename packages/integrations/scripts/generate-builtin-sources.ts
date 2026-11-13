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
 *   pnpm --filter @bobsled-inc/integrations check:sources   (CI, writes nothing)
 *
 * Wired into `pnpm build` before the catalog and validation generators,
 * which read the sources through the loader. CI runs `check:sources` before
 * building, so a stale committed file fails instead of being regenerated.
 *
 * Only `.yml` and `.md` files are embedded; dotfiles (editor swap files,
 * `.DS_Store`) are skipped and any other file type is an error.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCES_ROOT = join(__dirname, '..', 'sources');
const OUTPUT_PATH = join(__dirname, '..', 'src', 'builtin-sources', 'generated-data.ts');

const EMBEDDED_EXTENSIONS = ['.yml', '.md'];

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
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile() && EMBEDDED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
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
  const files = collectBuiltInSourceFiles();
  const body = JSON.stringify(files, null, 2);
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return `${HEADER}
export const BUILT_IN_SOURCES_SHA256 = ${JSON.stringify(digest)};

export const BUILT_IN_SOURCE_FILES: Readonly<Record<string, string>> = ${body};
`;
}

function readCommitted(): string | undefined {
  try {
    return readFileSync(OUTPUT_PATH, 'utf-8');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const rendered = renderBuiltInSourcesModule();
  if (process.argv.includes('--check')) {
    if (readCommitted() !== rendered) {
      process.stderr.write(
        `${OUTPUT_PATH} is out of date with sources/. Run \`pnpm --filter @bobsled-inc/integrations generate:sources\` and commit the result.\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('built-in sources are up to date\n');
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered);
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
