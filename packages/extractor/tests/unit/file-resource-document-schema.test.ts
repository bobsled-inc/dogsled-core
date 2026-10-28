import { describe, expect, it } from 'vitest';

import { FileResourceSpecSchema } from '../../src/framework/extractor/file-resource.js';

const baseDocumentResource = {
  spec_version: '1',
  type: 'resource',
  name: 'docs',
  source: {
    path: 'pdfs/**/*',
    kind: 'document',
  },
  replication: { method: 'full_refresh' },
  output: {
    document_id: { type: 'string' },
  },
};

const baseStructuredResource = {
  spec_version: '1',
  type: 'resource',
  name: 'events',
  source: { path: 'exports/*.csv', format: 'csv' },
  replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
  output: { id: { type: 'string' } },
};

describe('FileSourceConfigSchema document branch', () => {
  it('parses a minimal document source', () => {
    const result = FileResourceSpecSchema.parse(baseDocumentResource);
    expect(result.source.kind).toBe('document');
  });

  it('treats format: document as alias for kind: document', () => {
    const result = FileResourceSpecSchema.parse({
      ...baseDocumentResource,
      source: { path: 'pdfs/**/*', format: 'document' },
    });
    expect(result.source.kind).toBe('document');
  });

  it('accepts parse / chunk / embedding / ingest / permissions sub-blocks', () => {
    const result = FileResourceSpecSchema.parse({
      ...baseDocumentResource,
      source: {
        path: 'pdfs/**/*',
        kind: 'document',
        parse: { formats: ['pdf', 'docx'], max_file_size_mb: 50, on_error: 'record' },
        chunk: { max_tokens: 600, overlap_tokens: 100, tokenizer: 'cl100k_base' },
        embedding: { role: 'default_embedding_v1', field: 'text', as: 'text_embedding' },
        ingest: { mode: 'extract', freshness: '1h' },
        permissions: { capture: true, enforcement: { enabled: false } },
      },
    });
    expect(result.source.kind).toBe('document');
    if (result.source.kind === 'document') {
      expect(result.source.parse?.formats).toContain('pdf');
      expect(result.source.embedding?.role).toBe('default_embedding_v1');
      expect(result.source.ingest?.mode).toBe('extract');
    }
  });

  it('rejects parse block on a structured resource (strict mode)', () => {
    expect(() =>
      FileResourceSpecSchema.parse({
        ...baseStructuredResource,
        source: { path: 'exports/*.csv', format: 'csv', parse: { formats: ['pdf'] } },
      })
    ).toThrow();
  });

  it('rejects overlap_tokens >= max_tokens', () => {
    expect(() =>
      FileResourceSpecSchema.parse({
        ...baseDocumentResource,
        source: {
          path: 'pdfs/**/*',
          kind: 'document',
          chunk: { max_tokens: 100, overlap_tokens: 100 },
        },
      })
    ).toThrow(/overlap_tokens must be less than/);
  });

  it('rejects path traversal in document source', () => {
    expect(() =>
      FileResourceSpecSchema.parse({
        ...baseDocumentResource,
        source: { path: '../etc/passwd', kind: 'document' },
      })
    ).toThrow(/path traversal/);
  });

  it('accepts mode: live at schema level (runtime enforcement deferred)', () => {
    // Schema accepts mode: live; runtime correctness is enforced by the cache substrate.
    const result = FileResourceSpecSchema.parse({
      ...baseDocumentResource,
      source: {
        path: 'pdfs/**/*',
        kind: 'document',
        ingest: { mode: 'live' },
      },
    });
    if (result.source.kind === 'document') {
      expect(result.source.ingest?.mode).toBe('live');
    }
  });

  it('rejects permissions.enforcement.enabled = true in OSS', () => {
    expect(() =>
      FileResourceSpecSchema.parse({
        ...baseDocumentResource,
        source: {
          path: 'pdfs/**/*',
          kind: 'document',
          permissions: { capture: true, enforcement: { enabled: true } },
        },
      })
    ).toThrow();
  });
});

describe('FileSourceConfigSchema structured branch (back-compat)', () => {
  it('parses an existing csv resource without kind discriminator', () => {
    const result = FileResourceSpecSchema.parse(baseStructuredResource);
    expect(result.source.kind).toBe('structured');
    if (result.source.kind === 'structured') {
      expect(result.source.format).toBe('csv');
    }
  });

  it('preserves existing gzip-on-parquet rejection', () => {
    expect(() =>
      FileResourceSpecSchema.parse({
        ...baseStructuredResource,
        source: { path: 'data.parquet', format: 'parquet', compression: 'gzip' },
      })
    ).toThrow(/gzip compression is only supported for csv and jsonl/);
  });
});
