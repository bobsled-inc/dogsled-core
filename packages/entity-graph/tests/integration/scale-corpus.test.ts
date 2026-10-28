/**
 * Scale corpus smoke + (gated) full scale.
 *
 * The smoke variant is 50 entities / 100 documents and runs every PR.
 * The full variant is 1K entities / 10K documents and runs only when
 * `RUN_SCALE_TESTS=1` is set (nightly / on-demand). The 10M-chunk
 * variant is reserved for a separate runner; this file validates the
 * generator + manifest contract.
 */

import { describe, it, expect } from 'vitest';

import { generateScaleCorpus } from './scale-corpus-generator.js';

const FULL_SCALE = process.env['RUN_SCALE_TESTS'] === '1';

describe('generateScaleCorpus', () => {
  it('smoke: 100 docs, deterministic on identical seed', () => {
    const a = generateScaleCorpus({
      entity_count: 50,
      document_count: 100,
      avg_chunks_per_doc: 4,
      seed: 42,
    });
    const b = generateScaleCorpus({
      entity_count: 50,
      document_count: 100,
      avg_chunks_per_doc: 4,
      seed: 42,
    });
    expect(a.manifest.hash).toBe(b.manifest.hash);
    expect(a.manifest.entity_count).toBe(50);
    expect(a.manifest.document_count).toBe(100);
    expect(a.manifest.chunk_count).toBeGreaterThan(0);
    // Different seed → different corpus + different cache key.
    const c = generateScaleCorpus({
      entity_count: 50,
      document_count: 100,
      avg_chunks_per_doc: 4,
      seed: 43,
    });
    expect(c.manifest.hash).not.toBe(a.manifest.hash);
    expect(c.documents[0]?.body).not.toBe(a.documents[0]?.body);
  });

  it('chunk_id is content-addressed and stable', () => {
    const corpus = generateScaleCorpus({
      entity_count: 5,
      document_count: 3,
      avg_chunks_per_doc: 2,
      seed: 7,
    });
    // Re-running produces identical chunk_ids — ensures cache cohesion.
    const corpusAgain = generateScaleCorpus({
      entity_count: 5,
      document_count: 3,
      avg_chunks_per_doc: 2,
      seed: 7,
    });
    expect(corpus.chunks.map((c) => c.chunk_id)).toEqual(corpusAgain.chunks.map((c) => c.chunk_id));

    // Changed seed -> different content -> at least one chunk_id differs,
    // proving chunk_id depends on content, not just position.
    const corpusChanged = generateScaleCorpus({
      entity_count: 5,
      document_count: 3,
      avg_chunks_per_doc: 2,
      seed: 8,
    });
    expect(
      corpus.chunks.some((chunk, i) => chunk.chunk_id !== corpusChanged.chunks[i]?.chunk_id)
    ).toBe(true);
  });

  it.runIf(FULL_SCALE)('full: 1000 entities / 10000 documents (RUN_SCALE_TESTS=1)', () => {
    const corpus = generateScaleCorpus({
      entity_count: 1_000,
      document_count: 10_000,
      avg_chunks_per_doc: 4,
      seed: 42,
    });
    expect(corpus.manifest.entity_count).toBe(1_000);
    expect(corpus.manifest.document_count).toBe(10_000);
    expect(corpus.manifest.chunk_count).toBeGreaterThan(20_000);
    // Roughly normal distribution: most documents have 1–3 mentions.
    const totalMentions = corpus.documents.reduce((acc, d) => acc + d.mentions.length, 0);
    expect(totalMentions).toBeGreaterThan(10_000);
    expect(totalMentions).toBeLessThan(40_000);
  });
});
