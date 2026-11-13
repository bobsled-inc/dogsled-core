import { describe, expect, it } from 'vitest';

import { SourceSpecSchema } from '../src/validate.js';

// Compatibility test: the rename never rewrites this file, so both spellings stay literal.
const base = {
  spec_version: '2',
  type: 'source',
  name: 'api',
  transports: [
    { id: 'api', type: 'http', base_url: 'https://api.example.com', auth: { type: 'none' } },
  ],
};

describe.each([
  ['dogsled_connection_ref', 'dogsled_source_kind', 'bobsled_connection_ref'],
  ['bobsled_connection_ref', 'bobsled_source_kind', 'dogsled_connection_ref'],
])('source extension keys %s and %s', (ref, kind, otherRef) => {
  const source = { ...base, [ref]: 'api-binding', [kind]: 'bobsled_api' };

  it('accepts the keys and strips every host extension key', () => {
    const result = SourceSpecSchema.parse({
      ...source,
      dogsled_unrelated: true,
      bobsled_unrelated: true,
    });
    for (const key of [ref, kind, otherRef, 'dogsled_unrelated', 'bobsled_unrelated'])
      expect(result).not.toHaveProperty(key);
  });

  it('rejects conflicting duplicates before stripping either key', () => {
    const result = SourceSpecSchema.safeParse({ ...source, [otherRef]: 'private-new' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/^LEGACY_KEY_CONFLICT: /);
      expect(result.error.message).not.toContain('private-new');
      expect(result.error.message).not.toContain('api-binding');
    }
  });
});
