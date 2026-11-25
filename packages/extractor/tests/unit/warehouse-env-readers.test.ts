import { HOST_EMBEDDING_ENV_NAMES } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConnectionEnv } from '../../src/runtime/warehouse-env.js';
import { resolveConnectionConfig } from '../../src/runtime/warehouse-extractor.js';

import type { IntegrationSpec } from '../../src/types/index.js';

const VALUE = 'synthetic-value';
const RESERVED = HOST_EMBEDDING_ENV_NAMES.flatMap((name) => [name, name.toLowerCase()]);

function resolve(connection: Record<string, unknown>, declared: string): Record<string, unknown> {
  return resolveConnectionConfig({
    auth_env_vars: [declared],
    spec_version: '1',
    type: 'integration',
    name: 'example_warehouse',
    source_type: 'postgres',
    connection,
  } as unknown as IntegrationSpec);
}

function expectRefused(read: () => unknown): void {
  let error: unknown;
  try {
    read();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toMatchObject({
    message: expect.stringContaining('are reserved for the provider: host embedding stage'),
    exitCode: 2,
  });
  expect(String(error)).not.toContain(VALUE);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  ['a template', (name: string) => ({ database: `\${{ env.${name} }}` })],
  ['an _env field', (name: string) => ({ database_env: name })],
])('a warehouse connection with %s', (_label, connection) => {
  it('resolves a declared variable', () => {
    vi.stubEnv('EXAMPLE_DATABASE', VALUE);
    expect(resolve(connection('EXAMPLE_DATABASE'), 'EXAMPLE_DATABASE')).toEqual({
      database: VALUE,
    });
  });

  it('reports a declared variable that is not set', () => {
    expect(() => resolve(connection('EXAMPLE_UNSET_DATABASE'), 'EXAMPLE_UNSET_DATABASE')).toThrow(
      /Environment variable "EXAMPLE_UNSET_DATABASE" \(referenced by connection\.database(_env)?\) is not set/
    );
  });

  it.each(RESERVED)('refuses %s', (name) => {
    vi.stubEnv(name, VALUE);
    expectRefused(() => resolve(connection(name), name));
  });
});

describe('readConnectionEnv', () => {
  it.each(RESERVED)('refuses %s', (name) => {
    vi.stubEnv(name, VALUE);
    expectRefused(() => readConnectionEnv(name, 'connection.database'));
  });
});
