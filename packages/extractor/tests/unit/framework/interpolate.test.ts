import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InterpolationError,
  interpolatePath,
  interpolateString,
  interpolateValue,
  parseInputFlags,
} from '../../../src/framework/runtime/interpolate.js';

import type { InterpolationContext } from '../../../src/framework/runtime/interpolate.js';

describe('interpolateString', () => {
  it('resolves input source', () => {
    const ctx: InterpolationContext = { input: { name: 'alice' } };
    expect(interpolateString('hello ${{ input.name }}', ctx)).toBe('hello alice');
  });

  it('resolves mapped source', () => {
    const ctx: InterpolationContext = { mapped: { first_name: 'alice' } };
    expect(interpolateString('hello ${{ mapped.first_name }}', ctx)).toBe('hello alice');
  });

  it('throws InterpolationError for missing mapped values', () => {
    const ctx: InterpolationContext = { mapped: {} };
    expect(() => interpolateString('${{ mapped.missing }}', ctx)).toThrow(InterpolationError);
  });

  it('resolves secrets source', () => {
    const ctx: InterpolationContext = {
      declaredEnvVars: new Set(['API_KEY']),
      secrets: { API_KEY: 'sk-123' },
    };
    expect(interpolateString('Bearer ${{ secrets.API_KEY }}', ctx)).toBe('Bearer sk-123');
  });

  it('resolves env source', () => {
    const ctx: InterpolationContext = {
      declaredEnvVars: new Set(['MY_VAR']),
      env: { MY_VAR: 'value' },
    };
    expect(interpolateString('${{ env.MY_VAR }}', ctx)).toBe('value');
  });

  it('resolves integration.base_url', () => {
    const ctx: InterpolationContext = { integration: { base_url: 'https://api.example.com' } };
    expect(interpolateString('${{ integration.base_url }}/v1', ctx)).toBe(
      'https://api.example.com/v1'
    );
  });

  it('handles multiple templates in one string', () => {
    const ctx: InterpolationContext = { input: { a: 'X', b: 'Y' } };
    expect(interpolateString('${{ input.a }}-${{ input.b }}', ctx)).toBe('X-Y');
  });

  it('throws InterpolationError for missing input', () => {
    const ctx: InterpolationContext = { input: {} };
    expect(() => interpolateString('${{ input.missing }}', ctx)).toThrow(InterpolationError);
  });

  it('throws InterpolationError for missing secrets', () => {
    const ctx: InterpolationContext = { declaredEnvVars: new Set(['MISSING']), secrets: {} };
    expect(() => interpolateString('${{ secrets.MISSING }}', ctx)).toThrow(InterpolationError);
  });
});

describe('interpolatePath', () => {
  it('URI-encodes resolved values', () => {
    const ctx: InterpolationContext = { input: { name: 'hello world' } };
    expect(interpolatePath('/users/${{ input.name }}', ctx)).toBe('/users/hello%20world');
  });
});

describe('interpolateValue', () => {
  it('preserves non-string types for whole-template match', () => {
    const ctx: InterpolationContext = { input: { count: 42 } };
    const result = interpolateValue('${{ input.count }}', ctx);
    expect(result).toBe(42);
    expect(typeof result).toBe('number');
  });

  it('preserves mapped object values for whole-template matches', () => {
    const ctx: InterpolationContext = { mapped: { payload: { active: true } } };
    expect(interpolateValue('${{ mapped.payload }}', ctx)).toEqual({ active: true });
  });

  it('recursively interpolates objects', () => {
    const ctx: InterpolationContext = { input: { x: 'val' } };
    const result = interpolateValue({ key: '${{ input.x }}' }, ctx);
    expect(result).toEqual({ key: 'val' });
  });

  it('recursively interpolates arrays', () => {
    const ctx: InterpolationContext = { input: { a: '1', b: '2' } };
    const result = interpolateValue(['${{ input.a }}', '${{ input.b }}'], ctx);
    expect(result).toEqual(['1', '2']);
  });

  it('returns non-template values as-is', () => {
    expect(interpolateValue(42, {})).toBe(42);
    expect(interpolateValue(true, {})).toBe(true);
    expect(interpolateValue(null, {})).toBeNull();
  });
});

describe('BLOCKED_ENV_KEYS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks sensitive env vars even if present in process.env', () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    const ctx: InterpolationContext = {
      declaredEnvVars: new Set(['AWS_SECRET_ACCESS_KEY', 'MY_SAFE_VAR']),
    };
    expect(() => interpolateString('${{ env.AWS_SECRET_ACCESS_KEY }}', ctx)).toThrow(
      InterpolationError
    );
  });

  it('allows non-blocked env vars from process.env', () => {
    vi.stubEnv('MY_SAFE_VAR', 'safe-value');
    const ctx: InterpolationContext = {
      declaredEnvVars: new Set(['AWS_SECRET_ACCESS_KEY', 'MY_SAFE_VAR']),
    };
    expect(interpolateString('${{ env.MY_SAFE_VAR }}', ctx)).toBe('safe-value');
  });
});

describe('parseInputFlags', () => {
  it('parses key=value pairs', () => {
    expect(parseInputFlags(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' });
  });

  it('handles values containing =', () => {
    expect(parseInputFlags(['key=a=b=c'])).toEqual({ key: 'a=b=c' });
  });

  it('throws on entries without =', () => {
    expect(() => parseInputFlags(['noequals'])).toThrow('Expected key=value');
  });
});
