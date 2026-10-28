import { describe, expect, it, beforeAll } from 'vitest';

import {
  clearCache,
  getEmbeddingCandidates,
  getResourceFields,
  type ResourceField,
} from '../../src/index.js';

beforeAll(() => clearCache());

describe('getResourceFields', () => {
  it('returns one ResourceField per output column on the bundled Linear issues resource', () => {
    const fields = getResourceFields('linear', 'issues_graphql');

    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => typeof field.name === 'string')).toBe(true);
    expect(fields.every((field) => typeof field.type === 'string')).toBe(true);

    const byName = new Map(fields.map((field): [string, ResourceField] => [field.name, field]));
    const description = byName.get('description');
    expect(description?.type).toBe('string');
  });

  it('throws when the resource does not exist', () => {
    expect(() => getResourceFields('linear', 'definitely_not_a_real_resource')).toThrow(
      /not found/i
    );
  });

  it('throws when the source does not exist', () => {
    expect(() => getResourceFields('definitely_not_a_real_source', 'issues_graphql')).toThrow();
  });
});

describe('getEmbeddingCandidates', () => {
  it('returns only fields with embedding_candidate: true', () => {
    const candidates = getEmbeddingCandidates('linear', 'issues_graphql');
    expect(Array.isArray(candidates)).toBe(true);

    const fields = getResourceFields('linear', 'issues_graphql');
    const expected = fields
      .filter((field) => field.embedding_candidate === true)
      .map((field) => field.name);

    expect(candidates).toEqual(expected);
  });
});
