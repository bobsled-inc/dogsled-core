import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadResourceSpecWithWarnings } from '../../src/commands/common.js';
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

  const parseChunk = (chunk: Record<string, unknown>) => {
    const { source } = FileResourceSpecSchema.parse({
      ...baseDocumentResource,
      source: { path: 'pdfs/**/*', kind: 'document', chunk },
    });
    return source.kind === 'document' ? source.chunk : undefined;
  };

  it('parses a chunk block without a strategy as before', () => {
    expect(parseChunk({})).toEqual({
      max_tokens: 800,
      overlap_tokens: 120,
      tokenizer: 'cl100k_base',
    });
    expect(parseChunk({ strategy: 'recursive', overlap_tokens: 10 })).toMatchObject({
      strategy: 'recursive',
      overlap_tokens: 10,
    });
  });

  it('accepts the paragraph strategy without the recursive overlap default', () => {
    expect(parseChunk({ strategy: 'paragraph' })).toEqual({
      strategy: 'paragraph',
      max_tokens: 800,
      overlap_tokens: 0,
      tokenizer: 'cl100k_base',
    });
    expect(
      parseChunk({ strategy: 'paragraph', max_tokens: 100, min_tokens: 100, overlap_tokens: 0 })
    ).toMatchObject({ max_tokens: 100, min_tokens: 100, overlap_tokens: 0 });
    expect(parseChunk({ strategy: 'paragraph', max_tokens: 40 })).toMatchObject({ max_tokens: 40 });
  });

  it.each([
    [{ strategy: 'paragraph', overlap_tokens: 10 }, /overlap_tokens must be 0 when/],
    [{ strategy: 'paragraph', overlap_tokens: 120 }, /overlap_tokens must be 0 when/],
    [{ strategy: 'paragraph', max_tokens: 100, min_tokens: 101 }, /min_tokens must be less than/],
    [{ strategy: 'paragraph', min_tokens: 801 }, /min_tokens must be less than or equal/],
    [{ strategy: 'paragraph', min_tokens: 0 }, /min_tokens/],
    [{ strategy: 'paragraph', min_tokens: 1.5 }, /min_tokens/],
    [{ strategy: 'paragraph', min_token: 5 }, /Unrecognized key/],
    [{ min_tokens: 60 }, /min_tokens requires chunk.strategy: paragraph/],
    [{ strategy: 'recursive', min_tokens: 60 }, /min_tokens requires chunk.strategy: paragraph/],
    [{ strategy: 'sentence' }, /strategy must be recursive or paragraph/],
  ])('rejects the chunk block %j', (chunk, message) => {
    expect(() => parseChunk(chunk)).toThrow(message);
  });

  it.each([null, 'paragraph', []])('says that the chunk block %j is not a mapping', (chunk) => {
    expect(() => parseChunk(chunk as never)).toThrow(/expected object/);
  });

  it.each([{ kind: 'document' }, { format: 'document' }])(
    'reports the chunk error itself when a resource file with %j is loaded',
    (documentKey) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'document-resource-'));
      const file = path.join(dir, 'docs.yml');
      const write = (chunk: Record<string, unknown>): void =>
        writeFileSync(
          file,
          JSON.stringify({
            ...baseDocumentResource,
            integration: 'files',
            source: { path: 'pdfs/**/*', ...documentKey, chunk },
          })
        );
      try {
        write({ strategy: 'paragraph', overlap_tokens: 120 });
        expect(() => loadResourceSpecWithWarnings(file)).toThrow(
          /source\.chunk\.overlap_tokens: chunk\.overlap_tokens must be 0 when chunk\.strategy is paragraph/
        );
        write({ min_tokens: 5 });
        expect(() => loadResourceSpecWithWarnings(file)).toThrow(
          /source\.chunk\.min_tokens: chunk\.min_tokens requires chunk\.strategy: paragraph/
        );
        write({ strategy: 'paragraph' });
        expect(loadResourceSpecWithWarnings(file).spec).toMatchObject({
          source: { kind: 'document', chunk: { strategy: 'paragraph', overlap_tokens: 0 } },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

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
