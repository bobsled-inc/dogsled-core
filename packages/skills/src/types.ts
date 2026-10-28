/**
 * Public types for the Dogsled skills manifest.
 *
 * The manifest re-publishes the action-oriented authoring skills under
 * `.agents/skills/<name>/SKILL.md` for downstream consumers (notably the
 * host agent) that cannot read the Dogsled checkout directly.
 *
 * Single source of truth lives in `.agents/skills/`. The build script
 * (`scripts/build-manifest.ts`) flattens transclusions and bakes the
 * result into `src/generated-data.ts` at build time — same pattern as
 * `@bobsled-inc/integrations/catalog`.
 */

export const SKILLS_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Shape of every JSON file under `content/catalogs/`. All three
 * catalogs (`integration-kinds`, `resource-kinds`, `pipeline-kinds`)
 * share this structure today. `values` is append-only — removing a
 * value is a breaking change for the host agent.
 */
export interface CatalogDefinition {
  kind: string;
  description: string;
  values: string[];
}

export interface SkillSummary {
  /** Skill identifier, matching `.agents/skills/<name>/SKILL.md`. */
  name: string;
  /** First H1 of the markdown body, or the front-matter `name` if no H1. */
  title: string;
  /** Front-matter `description` — one-line summary for relevance ranking. */
  description: string;
  /**
   * Front-matter `triggers` array — natural-language phrases agents can
   * match user intent against. 5–10 phrases per skill is typical.
   */
  triggers: string[];
  /** Bytes of the flattened (post-transclusion) markdown body. */
  size: number;
  /** SHA256 of the flattened markdown body. */
  hash: string;
}

export interface Skill extends SkillSummary {
  /** Full markdown body, with all `{{include:}}` markers resolved. */
  content: string;
}

export interface SkillsManifest {
  schema_version: typeof SKILLS_MANIFEST_SCHEMA_VERSION;
  /** SemVer of `@bobsled-inc/skills` at build time. */
  version: string;
  /**
   * Combined SHA256 over every skill hash + every catalog body. Changes
   * whenever any transcluded doc, skill body, or catalog value changes,
   * so consumers can cache cleanly and detect any drift.
   */
  hash: string;
  skills: SkillSummary[];
  catalogs: string[];
}

export const SKILLS_MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Dogsled Skills Manifest',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'version', 'hash', 'skills', 'catalogs'],
  properties: {
    schema_version: { const: SKILLS_MANIFEST_SCHEMA_VERSION },
    version: { type: 'string', minLength: 1 },
    hash: { type: 'string', minLength: 64, maxLength: 64 },
    skills: { type: 'array', items: { $ref: '#/$defs/skill_summary' } },
    catalogs: { type: 'array', items: { type: 'string' } },
  },
  $defs: {
    skill_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'title', 'description', 'triggers', 'size', 'hash'],
      properties: {
        name: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
        size: { type: 'integer', minimum: 0 },
        hash: { type: 'string', minLength: 64, maxLength: 64 },
      },
    },
  },
} as const;
