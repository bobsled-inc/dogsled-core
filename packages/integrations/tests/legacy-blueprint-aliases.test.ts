import { describe, expect, it } from 'vitest';

import { SourceSpecSchema } from '../src/validate.js';

const source = {
  spec_version: '2',
  type: 'source',
  name: 'api',
  transports: [
    { id: 'api', type: 'http', base_url: 'https://api.example.com', auth: { type: 'none' } },
  ],
  bobsled_connection_ref: 'api-binding',
  bobsled_source_kind: 'bobsled_api',
};

describe('legacy source extension safety net', () => {
  it('accepts only the exact aliases and strips canonical extensions', () => {
    const result = SourceSpecSchema.parse(source);
    expect(result).not.toHaveProperty('bobsled_connection_ref');
    expect(result).not.toHaveProperty('bobsled_connection_ref');
    expect(SourceSpecSchema.safeParse({ ...source, bobsled_unrelated: true }).success).toBe(false);
  });

  it('rejects conflicting duplicates before stripping either key', () => {
    const result = SourceSpecSchema.safeParse({ ...source, bobsled_connection_ref: 'private-new' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'LEGACY_KEY_CONFLICT: bobsled_connection_ref conflicts with bobsled_connection_ref'
      );
      expect(result.error.message).not.toContain('private-new');
      expect(result.error.message).not.toContain('api-binding');
    }
  });
});
