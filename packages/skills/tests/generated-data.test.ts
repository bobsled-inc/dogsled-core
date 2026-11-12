/**
 * Drift guard for `src/generated-data.ts`.
 *
 * The runtime `listSkills()` / `getSkill()` / `getCatalog()` API
 * returns constants baked into `generated-data.ts` (committed). If a
 * developer edits a `.agents/skills/<name>/SKILL.md`, a transcluded
 * doc, or a `content/catalogs/<name>.json` without regenerating, the
 * runtime gives stale results to every downstream consumer. This test
 * rebuilds the module fresh and asserts the committed file matches —
 * if not, CI fails with a clear "run `pnpm --filter
 * @bobsled-inc/skills generate:manifest`" pointer.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildManifest, renderGeneratedDataModule } from '../scripts/build-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GENERATED_PATH = join(__dirname, '..', 'src', 'generated-data.ts');

describe('Dogsled Skills generated-data.ts drift guard', () => {
  it('matches the build output — run `pnpm --filter @bobsled-inc/skills generate:manifest` if this fails', () => {
    const committed = readFileSync(GENERATED_PATH, 'utf-8');
    const fresh = renderGeneratedDataModule();
    expect(committed).toBe(fresh);
  });

  it('the manifest has at least one exposed skill and at least one catalog (sanity check)', () => {
    const { manifest } = buildManifest();
    expect(manifest.skills.length).toBeGreaterThan(0);
    expect(manifest.catalogs.length).toBeGreaterThan(0);
  });

  it('keeps the dependency-maintenance skill out of shipped manifests', () => {
    const { manifest } = buildManifest();
    expect(manifest.skills.map(({ name }) => name)).not.toContain('dependency-maintenance');
  });
});
