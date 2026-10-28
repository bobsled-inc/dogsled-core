import { expect, it } from 'vitest';
import { combineAgenticEvidence } from '../../../src/agentic/evidence.js';

const citation = {
  source: 'directory',
  reference: 'restaurant:1',
  support_excerpt: null,
  retrieved_at: '2026-09-14T00:00:00Z',
};

it('deduplicates exact evidence while preserving distinct observations', () => {
  const later = { ...citation, retrieved_at: '2026-09-15T00:00:00Z' };
  const excerpt = { ...citation, support_excerpt: 'Address differs.' };
  expect(combineAgenticEvidence([[citation], null, [citation, later, excerpt]])).toEqual([
    citation,
    later,
    excerpt,
  ]);
});

it('returns null for no evidence and rejects oversized combined evidence', () => {
  expect(combineAgenticEvidence([null, []])).toBeNull();
  expect(() =>
    combineAgenticEvidence([
      Array.from({ length: 257 }, (_, i) => ({ ...citation, reference: String(i) })),
    ])
  ).toThrow();
});
