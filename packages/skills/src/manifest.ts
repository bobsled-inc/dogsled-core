/**
 * Dogsled skills manifest runtime entry point.
 *
 * `listSkills()`, `getSkill()`, and `getCatalog()` return the constants
 * baked into the bundle at build time by `scripts/build-manifest.ts`.
 * Zero filesystem I/O at runtime; safe to call from any environment
 * (serverless, edge runtimes, etc.).
 *
 * If you've just edited a `.agents/skills/<name>/SKILL.md` or a
 * transcluded doc and want to see the change here, run
 * `pnpm --filter @bobsled-inc/skills build` (or
 * `pnpm --filter @bobsled-inc/skills generate:manifest`).
 */

import { CATALOG_DATA, SKILLS_MANIFEST, SKILL_BODIES } from './generated-data.js';
import type { CatalogDefinition, Skill, SkillsManifest } from './types.js';

// Defensive deep copy on every accessor return: the manifest, skill
// bodies, and catalogs are baked-in module-level singletons. Returning
// references means a caller could `.skills.push(...)` and corrupt
// subsequent reads across the process. `structuredClone` is fast
// enough at this size (~150 KB across all skills + catalogs) that
// cloning on each call is a non-issue, and the safer API contract is
// worth the few microseconds.

export function listSkills(): SkillsManifest {
  return structuredClone(SKILLS_MANIFEST);
}

export function getSkill(name: string): Skill | null {
  const summary = SKILLS_MANIFEST.skills.find((s) => s.name === name);
  if (!summary) return null;
  const content = SKILL_BODIES[name];
  if (content === undefined) return null;
  return structuredClone({ ...summary, content });
}

export function getCatalog(name: string): CatalogDefinition | null {
  if (!Object.prototype.hasOwnProperty.call(CATALOG_DATA, name)) return null;
  const catalog = CATALOG_DATA[name];
  return catalog === undefined ? null : structuredClone(catalog);
}

export function renderSkillsManifestJson(manifest: SkillsManifest = listSkills()): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
