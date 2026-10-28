import { describe, expect, it } from 'vitest';

import {
  ClickHouseAuthSchema,
  ClickHouseConnectionSchema,
} from '../../../src/schemas/clickhouse.js';

describe('ClickHouseConnectionSchema', () => {
  const minimalValid = {
    host: 'clickhouse.internal',
    database: 'analytics',
  };

  it('accepts minimum required fields', () => {
    expect(ClickHouseConnectionSchema.parse(minimalValid)).toMatchObject(minimalValid);
  });

  // The port is resolved from the TLS mode at connect time rather than pinned
  // here, so that ClickHouse Cloud needs no transport settings at all.
  it('leaves the port unset so it can follow the scheme', () => {
    expect(ClickHouseConnectionSchema.parse(minimalValid).port).toBeUndefined();
  });

  it('still accepts an explicit port', () => {
    expect(ClickHouseConnectionSchema.parse({ ...minimalValid, port: 8443 }).port).toBe(8443);
  });

  it('accepts the ClickHouse Cloud TLS shape', () => {
    const parsed = ClickHouseConnectionSchema.parse({
      ...minimalValid,
      host: 'example.us-central1.gcp.clickhouse.cloud',
      port: 8443,
      ssl: { mode: 'require' },
    });
    expect(parsed.port).toBe(8443);
    expect(parsed.ssl?.mode).toBe('require');
  });

  it('accepts legacy _env fields', () => {
    expect(
      ClickHouseConnectionSchema.parse({
        host_env: 'CLICKHOUSE_HOST',
        database: 'analytics',
      })
    ).toMatchObject({ host_env: 'CLICKHOUSE_HOST' });
  });

  it('rejects host + host_env together', () => {
    expect(() =>
      ClickHouseConnectionSchema.parse({ ...minimalValid, host_env: 'CLICKHOUSE_HOST' })
    ).toThrow();
  });

  it('requires one of host / host_env', () => {
    expect(() => ClickHouseConnectionSchema.parse({ database: 'analytics' })).toThrow();
  });

  it('requires a database', () => {
    expect(() => ClickHouseConnectionSchema.parse({ host: 'clickhouse.internal' })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => ClickHouseConnectionSchema.parse({ ...minimalValid, schema: 'raw' })).toThrow();
  });

  it('rejects Postgres-style ssl modes it cannot honour', () => {
    expect(() =>
      ClickHouseConnectionSchema.parse({ ...minimalValid, ssl: { mode: 'verify-full' } })
    ).toThrow();
  });

  it('rejects a port outside the valid range', () => {
    expect(() => ClickHouseConnectionSchema.parse({ ...minimalValid, port: 70000 })).toThrow();
  });

  it('rejects a statement timeout beyond 24h', () => {
    expect(() =>
      ClickHouseConnectionSchema.parse({ ...minimalValid, statement_timeout_ms: 86_400_001 })
    ).toThrow();
  });
});

describe('ClickHouseAuthSchema', () => {
  it('accepts inline user + password', () => {
    expect(
      ClickHouseAuthSchema.parse({ type: 'password', user: 'default', password: 'private' })
    ).toMatchObject({ type: 'password', user: 'default' });
  });

  it('accepts legacy _env fields', () => {
    expect(
      ClickHouseAuthSchema.parse({
        type: 'password',
        user_env: 'CLICKHOUSE_USER',
        password_env: 'CLICKHOUSE_PASSWORD',
      })
    ).toMatchObject({ user_env: 'CLICKHOUSE_USER' });
  });

  it('allows a passwordless user', () => {
    expect(ClickHouseAuthSchema.parse({ type: 'password', user: 'default' })).toMatchObject({
      user: 'default',
    });
  });

  it('requires one of user / user_env', () => {
    expect(() => ClickHouseAuthSchema.parse({ type: 'password', password: 'private' })).toThrow();
  });

  it('rejects both password forms together', () => {
    expect(() =>
      ClickHouseAuthSchema.parse({
        type: 'password',
        user: 'default',
        password: 'private',
        password_env: 'CLICKHOUSE_PASSWORD',
      })
    ).toThrow();
  });

  it('rejects auth types the HTTP interface cannot use', () => {
    expect(() => ClickHouseAuthSchema.parse({ type: 'oauth', token: 'private' })).toThrow();
  });
});
