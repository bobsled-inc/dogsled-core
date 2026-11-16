/**
 * `@bobsled-inc/skills` — package root entry point.
 *
 * Re-exports the internal Bobsled Core Skills manifest API. The `./bobsled` subpath is
 * the same clean island for consumers that want only the manifest
 * surface without any transitive workspace dependencies. Mirrors the
 * `@bobsled-inc/integrations` / `@bobsled-inc/integrations/catalog`
 * split.
 */

export {
  SKILLS_MANIFEST_JSON_SCHEMA,
  SKILLS_MANIFEST_SCHEMA_VERSION,
  type CatalogDefinition,
  type Skill,
  type SkillSummary,
  type SkillsManifest,
} from './types.js';

export { getCatalog, getSkill, listSkills, renderSkillsManifestJson } from './manifest.js';
