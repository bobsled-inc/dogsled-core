/**
 * Drift guard for `src/builtin-sources/generated-data.ts`.
 *
 * The loader serves built-in sources from this committed constant, never from
 * `sources/` on disk. If a developer edits the YAML without regenerating, every
 * consumer would see stale specs. This test re-reads `sources/` and asserts the
 * committed file matches — if not, run `pnpm generate:sources`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderBuiltInSourcesModule } from '../scripts/generate-builtin-sources.js';
import { BUILT_IN_SOURCE_FILES } from '../src/builtin-sources/generated-data.js';
import {
  getResourcePath,
  getSourceDir,
  getSourcesDir,
  listSourceDirs,
  readResourceYaml,
} from '../src/loader.js';
import { getSource } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_PATH = join(__dirname, '..', 'src', 'builtin-sources', 'generated-data.ts');
const REPO_SOURCES_DIR = join(__dirname, '..', 'sources');

describe('built-in sources generated-data.ts drift guard', () => {
  it('matches the files under sources/ — run `pnpm generate:sources` if this fails', () => {
    expect(readFileSync(GENERATED_PATH, 'utf-8')).toBe(renderBuiltInSourcesModule());
  });
});

describe('built-in source loading', () => {
  it('reads sources from the embedded data, not from the package folder', () => {
    const sourcesDir = getSourcesDir();
    expect(sourcesDir).not.toBe(REPO_SOURCES_DIR);
    expect(getSource('bobsled_api').name).toBe('bobsled_api');
  });

  it('materialises a private copy for callers that need a real directory', () => {
    const sourcesDir = getSourcesDir();
    expect(sourcesDir.endsWith(`${sep}sources`)).toBe(true);
    expect(statSync(dirname(sourcesDir)).mode & 0o077).toBe(0);
    for (const [key, content] of Object.entries(BUILT_IN_SOURCE_FILES)) {
      expect(readFileSync(join(sourcesDir, ...key.split('/')), 'utf-8')).toBe(content);
    }
    expect(getSourceDir('stripe')).toBe(join(sourcesDir, 'stripe'));
    const resourcePath = getResourcePath('linear', 'issues_mcp');
    expect(existsSync(resourcePath)).toBe(true);
    expect(readFileSync(resourcePath, 'utf-8')).toBe(
      BUILT_IN_SOURCE_FILES['linear/resources/issues/mcp.yml']
    );
  });

  it('keeps the not-found errors and the hidden template', () => {
    expect(() => getSource('missing_source')).toThrow('Source "missing_source" not found');
    expect(() => readResourceYaml('stripe', 'missing')).toThrow(
      'Resource "missing" not found for source "stripe"'
    );
    expect(() => getSource('../stripe')).toThrow('Invalid source name');
    expect(listSourceDirs()).not.toContain('_template');
    expect(listSourceDirs()).toEqual([...listSourceDirs()].sort());
  });
});
