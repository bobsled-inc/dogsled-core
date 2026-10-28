import { describe, expect, it } from 'vitest';
import {
  chunkText,
  createDefaultRegistry,
  documentId,
  pdfParser,
} from '../../../src/compat/document-parsers.js';

describe('document parser compatibility export', () => {
  it('exposes parser, registry, chunking, and identity contracts', () => {
    expect(pdfParser.format).toBe('pdf');
    expect(createDefaultRegistry()).toBeDefined();
    expect(typeof chunkText).toBe('function');
    expect(typeof documentId).toBe('function');
  });
});
