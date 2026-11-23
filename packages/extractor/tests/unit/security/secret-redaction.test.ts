import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

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

    it.each([
      ['http://user:pass@example.com:8080/a?b=c#d', 'http://example.com:8080/a?[redacted]#d'],
      ['https://user@example.com', 'https://example.com/'],
      ['https://:pass@example.com/%C3%A9', 'https://example.com/%C3%A9'],
      ['postgres://user:pass@db.example.com/main?x=1', 'postgres://db.example.com/main?[redacted]'],
      ['file:///tmp/a?b=c', 'file:///tmp/a?[redacted]'],
      ['mailto:someone?subject=x', 'mailto:someone?[redacted]'],
      ['https://user:pass@[::1]:8443/a', 'https://[::1]:8443/a'],
    ])('rebuilds %s', (input, expected) => {
      expect(sanitizeUrlForError(input)).toBe(expected);
    });

    it(
      'sanitizes international and encoded hosts in a separate process',
      { timeout: 60_000 },
      () => {
        const source = (file: string) =>
          JSON.stringify(new URL(`../../../src/${file}`, import.meta.url).href);
        const script = `
        import { sanitizeUrlForError } from ${source('framework/core/shared.ts')};
        import { redactUrls, safeError } from ${source('runtime/clients/vercel-blob-file-utils.ts')};
        const parts = ['xn--', '\\u00e9', 'x', '-', '%C3%A9', '.', '\\u00ad', '\\u4e2d', '1'];
        const leaks = [];
        let count = 0;
        for (const a of parts) for (const b of parts) for (const c of parts) for (const d of parts) {
          const url = 'https://userpart:passpart@' + a + b + c + d + '/path?key=querypart';
          for (const text of [
            sanitizeUrlForError(url),
            redactUrls('see ' + url + ' now'),
            safeError(new Error(url)).message,
          ]) if (/userpart|passpart|querypart/.test(text)) leaks.push(url);
          count += 1;
        }
        process.stdout.write(JSON.stringify({ count, leaks }));
      `;
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            createRequire(import.meta.url).resolve('tsx'),
            '--input-type=module',
            '--eval',
            script,
          ],
          { encoding: 'utf8', timeout: 50_000 }
        );
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr.slice(0, 500)).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ count: 6_561, leaks: [] });
      }
    );

    it('handles empty strings', () => {
      const result = sanitizeUrlForError('');
      expect(result).toBe('[invalid-url]');
    });
  });
});
