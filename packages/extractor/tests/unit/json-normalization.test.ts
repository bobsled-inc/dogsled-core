import { describe, expect, it } from 'vitest';

import { normalizeJsonObject } from '../../src/runtime/json-normalization.js';

describe('normalizeJsonObject', () => {
  it('preserves keys that shadow prototype properties', () => {
    const input = JSON.parse(
      '{"__proto__":"proto","constructor":"ctor","prototype":"base"}'
    ) as Record<string, unknown>;

    const normalized = normalizeJsonObject(input);

    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(normalized['__proto__']).toBe('proto');
    expect(normalized['constructor']).toBe('ctor');
    expect(normalized['prototype']).toBe('base');
  });
});
