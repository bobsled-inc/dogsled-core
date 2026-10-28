import { describe, it, expect, beforeAll } from 'vitest';

import { clearCache, getEntityVariants, listEntities } from '../src/loader.js';

beforeAll(() => clearCache());

describe('listEntities / getEntityVariants', () => {
  describe('linear (multi-transport source)', () => {
    it('lists every canonical entity once even when multiple variants exist', () => {
      const entities = listEntities('linear');
      // Multi-variant entities (issues, teams, cycles, ...) appear once,
      // and single-variant resources (initiatives, roadmaps) appear under
      // their spec name (entity defaults to name).
      expect(entities).toContain('issues');
      expect(entities).toContain('teams');
      expect(entities).toContain('cycles');
      expect(entities).toContain('initiatives');
      expect(entities).toContain('roadmaps');
      // No duplicate `issues_graphql` / `issues_mcp` spec names leaking into
      // the entity list — that would defeat the purpose.
      expect(entities).not.toContain('issues_graphql');
      expect(entities).not.toContain('issues_mcp');
    });

    it('returns both variants for a multi-transport entity, sorted by name', () => {
      const variants = getEntityVariants('linear', 'cycles');
      expect(variants).toHaveLength(2);
      // Sorted lexicographically by spec name: cycles_graphql before cycles_mcp.
      expect(variants[0]).toEqual({ name: 'cycles_graphql', via: 'graphql' });
      expect(variants[1]).toEqual({ name: 'cycles_mcp', via: 'mcp' });
    });

    it('returns a single entry for entities backed by one variant only', () => {
      // initiatives.yml has no `entity:` field, so entity defaults to name.
      // It does declare `via: graphql` on the single variant.
      const variants = getEntityVariants('linear', 'initiatives');
      expect(variants).toHaveLength(1);
      expect(variants[0]).toEqual({ name: 'initiatives', via: 'graphql' });
    });

    it('returns variants with via=undefined when the YAML omits the field', () => {
      // Confluence resources predate the via convention and don't declare it.
      // Entity defaults to name, via stays undefined.
      const variants = getEntityVariants('confluence', 'get_current_user');
      expect(variants).toHaveLength(1);
      expect(variants[0]).toEqual({ name: 'get_current_user', via: undefined });
    });

    it('returns an empty array for unknown entities', () => {
      expect(getEntityVariants('linear', 'definitely_not_a_real_entity')).toEqual([]);
    });
  });

  describe('cache invariants', () => {
    it('returns fresh array references so callers can mutate without poisoning the cache', () => {
      const first = getEntityVariants('linear', 'cycles');
      first.push({ name: 'mutated', via: 'bogus' });
      const second = getEntityVariants('linear', 'cycles');
      expect(second).toHaveLength(2);
      expect(second.find((v) => v.name === 'mutated')).toBeUndefined();
    });
  });

  describe('safety', () => {
    it('rejects source names containing path separators', () => {
      expect(() => listEntities('../linear')).toThrow(/Invalid source name/);
      expect(() => getEntityVariants('../linear', 'issues')).toThrow(/Invalid source name/);
    });
  });
});
