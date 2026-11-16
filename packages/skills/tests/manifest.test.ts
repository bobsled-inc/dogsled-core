/**
 * Smoke tests for the runtime manifest API.
 *
 * These run against whatever `src/generated-data.ts` currently holds,
 * so they verify the public surface contract (`listSkills`,
 * `getSkill`, `getCatalog`) regardless of which skills are exposed at
 * any point in time.
 */

import { describe, expect, it } from 'vitest';

import { SKILLS_MANIFEST_SCHEMA_VERSION, getCatalog, getSkill, listSkills } from '../src/index.js';

describe('Dogsled Skills public API', () => {
  it('listSkills() returns a manifest with the current schema version', () => {
    const manifest = listSkills();
    expect(manifest.schema_version).toBe(SKILLS_MANIFEST_SCHEMA_VERSION);
    expect(typeof manifest.version).toBe('string');
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every skill summary has a non-empty hash and matching size', () => {
    const manifest = listSkills();
    for (const skill of manifest.skills) {
      expect(skill.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(skill.size).toBeGreaterThan(0);
    }
  });

  it('getSkill() returns full content for every advertised skill', () => {
    const manifest = listSkills();
    for (const summary of manifest.skills) {
      const skill = getSkill(summary.name);
      expect(skill).not.toBeNull();
      expect(skill?.hash).toBe(summary.hash);
      expect(skill?.content.length).toBeGreaterThan(0);
    }
  });

  it('getSkill() returns null for unknown names', () => {
    expect(getSkill('definitely-not-a-skill')).toBeNull();
  });

  it('publishes one authoritative extract-pipeline contract and routes legacy entry points to it', () => {
    const authoritative = getSkill('extract-pipelines');
    expect(authoritative).not.toBeNull();
    expect(authoritative?.content).not.toContain('{{include:');
    expect(authoritative?.content).toContain(
      '`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`'
    );
    expect(authoritative?.content).toContain(
      '`eq`, `contains`, `gte`, `lte`, `ne`, `lt`, `gt`, `not`, `in`'
    );
    expect(authoritative?.content).toContain('Use `manual` for an on-demand pipeline');

    for (const name of ['pipeline', 'bobsled-add-pipeline', 'bobsled-generate-yml']) {
      const compatibilitySkill = getSkill(name)?.content;
      expect(compatibilitySkill).toContain('single authoritative source');
      expect(compatibilitySkill).toContain(
        '`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`'
      );
      expect(compatibilitySkill).not.toMatch(/\n\s+only:\s*(?:\n|\[)/);
      expect(compatibilitySkill).not.toMatch(/\n\s+exclude:\s*(?:\n|\[)/);
    }

    for (const name of [
      'add-custom-api-integration',
      'etl-migration',
      'bobsled-overview',
      'bobsled-troubleshoot',
    ]) {
      expect(getSkill(name)?.content).toContain('extract-pipelines');
    }
  });

  it('advertises canonical brand-bearing IDs without old aliases', () => {
    for (const name of [
      'bobsled-overview',
      'bobsled-init',
      'bobsled-add-pipeline',
      'bobsled-generate-yml',
      'bobsled-model-spec',
      'bobsled-model-spec-edit',
      'bobsled-author-model-spec-model',
    ]) {
      expect(getSkill(name)).not.toBeNull();
    }
    for (const name of [
      'track-overview',
      'track-init',
      'track-preflight',
      'generate-track-yml',
      'bms',
      'bms-edit',
      'author-bms-model',
    ]) {
      expect(getSkill(name)).toBeNull();
    }
    for (const name of ['pipeline', 'add-integration', 'entity-resolution']) {
      expect(getSkill(name)).not.toBeNull();
    }
  });

  it('getCatalog() returns data for every advertised catalog', () => {
    const manifest = listSkills();
    for (const name of manifest.catalogs) {
      expect(getCatalog(name)).not.toBeNull();
    }
  });

  it('getCatalog() returns null for unknown names', () => {
    expect(getCatalog('definitely-not-a-catalog')).toBeNull();
  });
});
