import { describe, it, expect } from 'vitest';

import {
  isAbsoluteHttpsUrl,
  isAbsoluteHttpsUrlTemplate,
  AbsoluteHttpsUrlSchema,
} from '../../../src/framework/core/shared.js';

describe('OAuth HTTPS Enforcement', () => {
  describe('isAbsoluteHttpsUrl()', () => {
    it('accepts HTTPS URLs', () => {
      expect(isAbsoluteHttpsUrl('https://oauth.example.com/token')).toBe(true);
      expect(isAbsoluteHttpsUrl('https://accounts.google.com/o/oauth2/token')).toBe(true);
    });

    it('rejects HTTP URLs', () => {
      expect(isAbsoluteHttpsUrl('http://oauth.example.com/token')).toBe(false);
    });

    it('rejects non-URL strings', () => {
      expect(isAbsoluteHttpsUrl('not-a-url')).toBe(false);
      expect(isAbsoluteHttpsUrl('')).toBe(false);
    });

    it('rejects other protocols', () => {
      expect(isAbsoluteHttpsUrl('ftp://example.com')).toBe(false);
      expect(isAbsoluteHttpsUrl('file:///etc/passwd')).toBe(false);
    });
  });

  describe('isAbsoluteHttpsUrlTemplate()', () => {
    it('accepts HTTPS URL templates with interpolation', () => {
      expect(isAbsoluteHttpsUrlTemplate('https://${{secrets.HOST}}/token')).toBe(true);
      expect(isAbsoluteHttpsUrlTemplate('https://api.example.com/${{input.path}}')).toBe(true);
    });

    it('rejects HTTP URL templates', () => {
      expect(isAbsoluteHttpsUrlTemplate('http://${{secrets.HOST}}/token')).toBe(false);
    });
  });

  describe('AbsoluteHttpsUrlSchema', () => {
    it('validates HTTPS URLs', () => {
      expect(AbsoluteHttpsUrlSchema.safeParse('https://example.com').success).toBe(true);
    });

    it('rejects HTTP URLs', () => {
      expect(AbsoluteHttpsUrlSchema.safeParse('http://example.com').success).toBe(false);
    });
  });
});
