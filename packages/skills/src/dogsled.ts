/**
 * `@bobsled-inc/skills/dogsled` — subpath entry point.
 *
 * Identical surface to the package root today. Reserved as a distinct
 * subpath so future package growth (e.g. adding an authoring-side
 * surface that imports yaml/zod heavy deps) doesn't break agent-side
 * consumers that only want the manifest.
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
