import { describe, expect, it } from 'vitest';

import { chunkId, documentId, documentVersionId, sha256Hex } from '../src/index.js';

describe('three-tier deterministic identity', () => {
  const sourceUri = 's3://acme-docs/q4-results.pdf';
  const contentHash = 'a'.repeat(64);
  const sourceRevision = 'etag-abc';

  it('document_id is sha256 of source_uri', () => {
    expect(documentId(sourceUri)).toBe(sha256Hex(sourceUri));
  });

  it('document_version_id changes when content_hash changes', () => {
    const v1 = documentVersionId({ sourceUri, contentHash, sourceRevision });
    const v2 = documentVersionId({
      sourceUri,
      contentHash: 'b'.repeat(64),
      sourceRevision,
    });
    expect(v1).not.toBe(v2);
  });

  it('document_version_id changes when source_revision changes', () => {
    const v1 = documentVersionId({ sourceUri, contentHash, sourceRevision: 'r1' });
    const v2 = documentVersionId({ sourceUri, contentHash, sourceRevision: 'r2' });
    expect(v1).not.toBe(v2);
  });

  it('document_version_id is deterministic for identical inputs', () => {
    const v1 = documentVersionId({ sourceUri, contentHash, sourceRevision });
    const v2 = documentVersionId({ sourceUri, contentHash, sourceRevision });
    expect(v1).toBe(v2);
  });

  it('chunk_id changes when chunker config hash changes', () => {
    const dvi = documentVersionId({ sourceUri, contentHash });
    const a = chunkId({
      documentVersionId: dvi,
      chunkerConfigHash: 'cfg-a',
      chunkIndex: 0,
      chunkText: 'hello',
    });
    const b = chunkId({
      documentVersionId: dvi,
      chunkerConfigHash: 'cfg-b',
      chunkIndex: 0,
      chunkText: 'hello',
    });
    expect(a).not.toBe(b);
  });

  it('chunk_id changes when chunk_text changes (content edit)', () => {
    const dvi = documentVersionId({ sourceUri, contentHash });
    const a = chunkId({
      documentVersionId: dvi,
      chunkerConfigHash: 'cfg',
      chunkIndex: 0,
      chunkText: 'hello',
    });
    const b = chunkId({
      documentVersionId: dvi,
      chunkerConfigHash: 'cfg',
      chunkIndex: 0,
      chunkText: 'goodbye',
    });
    expect(a).not.toBe(b);
  });

  it('chunk_id is stable for identical inputs', () => {
    const dvi = documentVersionId({ sourceUri, contentHash });
    const args = {
      documentVersionId: dvi,
      chunkerConfigHash: 'cfg',
      chunkIndex: 5,
      chunkText: 'a chunk of text',
    };
    expect(chunkId(args)).toBe(chunkId(args));
  });

  it('chunk_id hashes the published canonical tuple with raw chunk text', () => {
    const dvi = documentVersionId({ sourceUri, contentHash });
    expect(
      chunkId({
        documentVersionId: dvi,
        chunkerConfigHash: 'cfg',
        chunkIndex: 0,
        chunkText: 'hello',
      })
    ).toBe(sha256Hex([dvi, 'cfg', '0', 'hello'].join('::')));
  });
});
