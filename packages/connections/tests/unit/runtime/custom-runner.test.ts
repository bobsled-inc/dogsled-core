import { describe, expect, it, vi } from 'vitest';

import { CustomRunnerRegistry, runnerKey } from '../../../src/runtime/custom-runner.js';

describe('runnerKey', () => {
  it('joins source_type and auth_type with a colon', () => {
    expect(runnerKey('snowflake', 'rsa_key')).toBe('snowflake:rsa_key');
    expect(runnerKey('duckdb', 'memory')).toBe('duckdb:memory');
  });
});

describe('CustomRunnerRegistry', () => {
  it('registers and retrieves a factory by (source_type, auth_type)', () => {
    const registry = new CustomRunnerRegistry();
    const factory = vi.fn();
    registry.register('snowflake', 'sledhouse_oidc', factory);
    expect(registry.get('snowflake', 'sledhouse_oidc')).toBe(factory);
  });

  it('returns undefined for unregistered keys', () => {
    const registry = new CustomRunnerRegistry();
    expect(registry.get('snowflake', 'unknown_auth')).toBeUndefined();
  });

  it('has() reports membership correctly', () => {
    const registry = new CustomRunnerRegistry();
    registry.register('snowflake', 'sledhouse_oidc', vi.fn());
    expect(registry.has('snowflake', 'sledhouse_oidc')).toBe(true);
    expect(registry.has('snowflake', 'pat')).toBe(false);
  });

  it('keys() returns all registered keys', () => {
    const registry = new CustomRunnerRegistry();
    registry.register('snowflake', 'sledhouse_oidc', vi.fn());
    registry.register('bigquery', 'wif_custom', vi.fn());
    expect([...registry.keys()].sort()).toEqual([
      'bigquery:wif_custom',
      'snowflake:sledhouse_oidc',
    ]);
  });

  it('later register() for the same key overwrites the earlier factory', () => {
    const registry = new CustomRunnerRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register('snowflake', 'sledhouse_oidc', first);
    registry.register('snowflake', 'sledhouse_oidc', second);
    expect(registry.get('snowflake', 'sledhouse_oidc')).toBe(second);
  });
});
