import { describe, expect, it } from 'vitest';

import { PostgresAuthSchema, PostgresConnectionSchema } from '../../../src/schemas/postgres.js';

describe('PostgresConnectionSchema', () => {
  const minimalValid = {
    host: 'db.acme.com',
    database: 'analytics',
  };

  it('accepts minimum required fields and defaults port to 5432', () => {
    const parsed = PostgresConnectionSchema.parse(minimalValid);
    expect(parsed.host).toBe('db.acme.com');
    expect(parsed.port).toBe(5432);
  });

  it('accepts explicit port', () => {
    expect(PostgresConnectionSchema.parse({ ...minimalValid, port: 5433 }).port).toBe(5433);
  });

  it('accepts host_env legacy', () => {
    expect(
      PostgresConnectionSchema.parse({ host_env: 'PG_HOST', database: 'analytics' })
    ).toMatchObject({ host_env: 'PG_HOST' });
  });

  it('rejects host + host_env together', () => {
    expect(() =>
      PostgresConnectionSchema.parse({
        ...minimalValid,
        host_env: 'PG_HOST',
      })
    ).toThrow(/Cannot set both/);
  });

  it('rejects missing host and host_env', () => {
    expect(() => PostgresConnectionSchema.parse({ database: 'analytics' })).toThrow(/must be set/);
  });

  it('rejects missing database', () => {
    expect(() => PostgresConnectionSchema.parse({ host: 'db.acme.com' })).toThrow();
  });

  it('accepts ssl block', () => {
    expect(
      PostgresConnectionSchema.parse({
        ...minimalValid,
        ssl: { mode: 'require' },
      })
    ).toMatchObject({ ssl: { mode: 'require' } });
  });

  it('rejects invalid ssl mode', () => {
    expect(() =>
      PostgresConnectionSchema.parse({
        ...minimalValid,
        ssl: { mode: 'invalid' },
      })
    ).toThrow();
  });
});

describe('PostgresAuthSchema', () => {
  it('parses password new-style', () => {
    expect(
      PostgresAuthSchema.parse({ type: 'password', user: 'svc', password: 'p4ss' })
    ).toMatchObject({ type: 'password' });
  });

  it('parses password legacy', () => {
    expect(
      PostgresAuthSchema.parse({
        type: 'password',
        user_env: 'PG_USER',
        password_env: 'PG_PASSWORD',
      })
    ).toMatchObject({ type: 'password' });
  });

  it('rejects password missing user', () => {
    expect(() => PostgresAuthSchema.parse({ type: 'password', password: 'p4ss' })).toThrow(
      /must be set/
    );
  });

  it('rejects password missing password', () => {
    expect(() => PostgresAuthSchema.parse({ type: 'password', user: 'svc' })).toThrow(
      /must be set/
    );
  });

  it('parses iam with region', () => {
    expect(
      PostgresAuthSchema.parse({ type: 'iam', user: 'svc', region: 'us-east-1' })
    ).toMatchObject({ type: 'iam', region: 'us-east-1' });
  });

  it('rejects iam missing region', () => {
    expect(() => PostgresAuthSchema.parse({ type: 'iam', user: 'svc' })).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => PostgresAuthSchema.parse({ type: 'oauth', user: 'svc' })).toThrow();
  });
});
