import { describe, expect, it } from 'vitest';

import { SnowflakeWorkloadIdentityAuthSchema } from '@bobsled-inc/connections';
import { SnowflakeAuthSchema, SnowflakeConnectionSchema } from '../../../src/schemas/snowflake.js';

describe('SnowflakeConnectionSchema', () => {
  const minimalValid = {
    account_identifier: 'xt12345.us-east-1',
    warehouse: 'COMPUTE_WH',
    role: 'DOGSLED_AI_ROLE',
  };

  it('accepts minimum required fields', () => {
    expect(SnowflakeConnectionSchema.parse(minimalValid)).toMatchObject(minimalValid);
  });

  it('accepts optional database / schema / user defaults', () => {
    const parsed = SnowflakeConnectionSchema.parse({
      ...minimalValid,
      user: 'svc_user',
      database: 'ANALYTICS',
      schema: 'RAW',
    });
    expect(parsed.database).toBe('ANALYTICS');
    expect(parsed.schema).toBe('RAW');
    expect(parsed.user).toBe('svc_user');
  });

  it('accepts legacy _env fields', () => {
    expect(
      SnowflakeConnectionSchema.parse({
        account_identifier_env: 'SF_ACCOUNT',
        warehouse_env: 'SF_WAREHOUSE',
        user_env: 'SF_USER',
        role: 'DOGSLED_AI_ROLE',
      })
    ).toMatchObject({ account_identifier_env: 'SF_ACCOUNT' });
  });

  it('rejects account_identifier + account_identifier_env together', () => {
    expect(() =>
      SnowflakeConnectionSchema.parse({
        ...minimalValid,
        account_identifier_env: 'SF_ACCOUNT',
      })
    ).toThrow(/Cannot set both/);
  });

  it('rejects missing role', () => {
    expect(() =>
      SnowflakeConnectionSchema.parse({
        account_identifier: 'xt12345',
        warehouse: 'COMPUTE_WH',
      })
    ).toThrow();
  });

  it('rejects missing warehouse and warehouse_env', () => {
    expect(() =>
      SnowflakeConnectionSchema.parse({
        account_identifier: 'xt12345',
        role: 'DOGSLED_AI_ROLE',
      })
    ).toThrow(/must be set/);
  });

  it('rejects unknown top-level field', () => {
    expect(() => SnowflakeConnectionSchema.parse({ ...minimalValid, unknown: 'x' })).toThrow();
  });

  describe('warehouses set', () => {
    it('accepts a warehouses set whose values include the default warehouse', () => {
      const parsed = SnowflakeConnectionSchema.parse({
        account_identifier: 'xt12345.us-east-1',
        warehouse: 'COMPUTE_WH',
        warehouses: { small: 'COMPUTE_WH', large: 'BIG_WH' },
        role: 'DOGSLED_AI_ROLE',
      });
      expect(parsed.warehouses).toEqual({ small: 'COMPUTE_WH', large: 'BIG_WH' });
    });

    it('rejects a default warehouse that is not one of the set values', () => {
      expect(() =>
        SnowflakeConnectionSchema.parse({
          account_identifier: 'xt12345.us-east-1',
          warehouse: 'MISSING_WH',
          warehouses: { small: 'COMPUTE_WH', large: 'BIG_WH' },
          role: 'DOGSLED_AI_ROLE',
        })
      ).toThrow(/must be one of the declared warehouses values/);
    });

    it('rejects an empty warehouses set', () => {
      expect(() =>
        SnowflakeConnectionSchema.parse({
          account_identifier: 'xt12345.us-east-1',
          warehouse: 'COMPUTE_WH',
          warehouses: {},
          role: 'DOGSLED_AI_ROLE',
        })
      ).toThrow(/at least one entry/);
    });

    it('rejects duplicate warehouse names within the set', () => {
      expect(() =>
        SnowflakeConnectionSchema.parse({
          account_identifier: 'xt12345.us-east-1',
          warehouse: 'COMPUTE_WH',
          warehouses: { a: 'COMPUTE_WH', b: 'COMPUTE_WH' },
          role: 'DOGSLED_AI_ROLE',
        })
      ).toThrow(/must not repeat warehouse names/);
    });

    it('skips default-membership check when the default is supplied via warehouse_env', () => {
      // The legacy env-var default has no literal value at parse time, so the
      // membership check is deferred to interpolation.
      const parsed = SnowflakeConnectionSchema.parse({
        account_identifier: 'xt12345.us-east-1',
        warehouse_env: 'SF_WAREHOUSE',
        warehouses: { small: 'COMPUTE_WH', large: 'BIG_WH' },
        role: 'DOGSLED_AI_ROLE',
      });
      expect(parsed.warehouses).toEqual({ small: 'COMPUTE_WH', large: 'BIG_WH' });
    });

    it('skips default-membership check when the default uses `${{ env.VAR }}` interpolation', () => {
      // The current (non-deprecated) env form has no resolved value at parse
      // time, so the membership check must be deferred to interpolation — not
      // rejected as a literal that happens not to be in the set.
      const parsed = SnowflakeConnectionSchema.parse({
        account_identifier: 'xt12345.us-east-1',
        warehouse: '${{ env.SF_WAREHOUSE }}',
        warehouses: { small: 'COMPUTE_WH', large: 'BIG_WH' },
        role: 'DOGSLED_AI_ROLE',
      });
      expect(parsed.warehouses).toEqual({ small: 'COMPUTE_WH', large: 'BIG_WH' });
      expect(parsed.warehouse).toBe('${{ env.SF_WAREHOUSE }}');
    });

    it('still accepts a single-warehouse connection with no set (back-compat)', () => {
      const parsed = SnowflakeConnectionSchema.parse(minimalValid);
      expect(parsed.warehouses).toBeUndefined();
      expect(parsed.warehouse).toBe('COMPUTE_WH');
    });
  });
});

describe('SnowflakeAuthSchema', () => {
  it('parses pat with new-style token', () => {
    expect(SnowflakeAuthSchema.parse({ type: 'pat', token: 'secret' })).toEqual({
      type: 'pat',
      token: 'secret',
    });
  });

  it('parses pat with legacy token_env', () => {
    expect(SnowflakeAuthSchema.parse({ type: 'pat', token_env: 'SF_TOKEN' })).toEqual({
      type: 'pat',
      token_env: 'SF_TOKEN',
    });
  });

  it('rejects pat with neither token nor token_env', () => {
    expect(() => SnowflakeAuthSchema.parse({ type: 'pat' })).toThrow(/must be set/);
  });

  it('parses rsa_key with new-style path, no passphrase', () => {
    expect(
      SnowflakeAuthSchema.parse({ type: 'rsa_key', private_key_path: '/tmp/key.pem' })
    ).toMatchObject({ type: 'rsa_key', private_key_path: '/tmp/key.pem' });
  });

  it('parses rsa_key with legacy env', () => {
    expect(
      SnowflakeAuthSchema.parse({
        type: 'rsa_key',
        private_key_path_env: 'SF_KEY',
        private_key_passphrase_env: 'SF_KEY_PASS',
      })
    ).toMatchObject({ type: 'rsa_key' });
  });

  it('rejects rsa_key missing private_key_path', () => {
    expect(() => SnowflakeAuthSchema.parse({ type: 'rsa_key' })).toThrow(/must be set/);
  });

  it('parses oauth', () => {
    expect(
      SnowflakeAuthSchema.parse({
        type: 'oauth',
        client_id: 'cid',
        client_secret: 'csec',
        token_url: 'https://auth.example.com/token',
      })
    ).toMatchObject({ type: 'oauth' });
  });

  it('rejects oauth token_url that is not https', () => {
    expect(() =>
      SnowflakeAuthSchema.parse({
        type: 'oauth',
        client_id: 'cid',
        client_secret: 'csec',
        token_url: 'http://auth.example.com/token',
      })
    ).toThrow(/HTTPS/);
  });

  it('rejects oauth missing client fields', () => {
    expect(() =>
      SnowflakeAuthSchema.parse({
        type: 'oauth',
        token_url: 'https://auth.example.com/token',
      })
    ).toThrow(/must be set/);
  });

  it('accepts sledhouse_oidc with only type', () => {
    expect(SnowflakeAuthSchema.parse({ type: 'sledhouse_oidc' })).toEqual({
      type: 'sledhouse_oidc',
    });
  });

  it('accepts workload_identity with only type', () => {
    expect(SnowflakeAuthSchema.parse({ type: 'workload_identity' })).toEqual({
      type: 'workload_identity',
    });
  });

  it('exports workload_identity from the package root', () => {
    expect(SnowflakeWorkloadIdentityAuthSchema.parse({ type: 'workload_identity' })).toEqual({
      type: 'workload_identity',
    });
  });

  it('passes through host-specific fields on sledhouse_oidc', () => {
    const parsed = SnowflakeAuthSchema.parse({
      type: 'sledhouse_oidc',
      data_source_slug: 'acme_sf',
      workspace_id: 'ws_123',
    });
    expect(parsed).toMatchObject({
      type: 'sledhouse_oidc',
      data_source_slug: 'acme_sf',
      workspace_id: 'ws_123',
    });
  });

  it('rejects unknown auth type', () => {
    expect(() => SnowflakeAuthSchema.parse({ type: 'unknown', token: 'x' })).toThrow();
  });
});
