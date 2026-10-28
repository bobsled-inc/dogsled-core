import { describe, it, expect } from 'vitest';

import { sanitizeUrlForError } from '../../../src/framework/core/shared.js';

describe('Secret Redaction', () => {
  describe('sanitizeUrlForError()', () => {
    it('passes through URLs without credentials', () => {
      const result = sanitizeUrlForError('https://api.example.com/path');
      expect(result).toBe('https://api.example.com/path');
    });

    it('redacts username and password from URLs', () => {
      const result = sanitizeUrlForError('https://user:pass@api.example.com/path');
      expect(result).not.toContain('user');
      expect(result).not.toContain('pass');
      expect(result).toContain('api.example.com');
    });

    it('redacts query strings', () => {
      const result = sanitizeUrlForError('https://api.example.com/path?api_key=secret123&foo=bar');
      expect(result).not.toContain('secret123');
      expect(result).toContain('[redacted]');
    });

    it('handles invalid URLs gracefully', () => {
      const result = sanitizeUrlForError('not a url at all');
      expect(result).toBe('[invalid-url]');
    });

    it('handles empty strings', () => {
      const result = sanitizeUrlForError('');
      expect(result).toBe('[invalid-url]');
    });
  });
});
