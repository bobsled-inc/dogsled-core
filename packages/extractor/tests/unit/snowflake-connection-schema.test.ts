import { describe, expect, it } from 'vitest';

import { SnowflakeConnectionSchema } from '../../src/framework/core/warehouse.js';

describe('SnowflakeConnectionSchema', () => {
  const baseValid = {
    account_identifier_env: 'SF_ACCOUNT',
    warehouse_env: 'SF_WAREHOUSE',
    role: 'READER_ROLE',
  };

  it('accepts minimal connection with just account/warehouse/role', () => {
    const result = SnowflakeConnectionSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });

  it('accepts connection with database+schema+role set as defaults', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...baseValid,
      database: 'ANALYTICS',
      schema: 'PUBLIC',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional user_env for rsa_key auth / loader use', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...baseValid,
      user_env: 'SF_USER',
    });
    expect(result.success).toBe(true);
  });

  it('makes database optional', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...baseValid,
      schema: 'PUBLIC',
    });
    expect(result.success).toBe(true);
  });

  it('makes schema optional', () => {
    const result = SnowflakeConnectionSchema.safeParse({
      ...baseValid,
      database: 'ANALYTICS',
    });
    expect(result.success).toBe(true);
  });

  it('still requires account_identifier_env', () => {
    const { account_identifier_env: _, ...rest } = baseValid;
    expect(SnowflakeConnectionSchema.safeParse(rest).success).toBe(false);
  });

  it('still requires warehouse_env', () => {
    const { warehouse_env: _, ...rest } = baseValid;
    expect(SnowflakeConnectionSchema.safeParse(rest).success).toBe(false);
  });

  it('still requires role (session-wide permission boundary)', () => {
    const { role: _, ...rest } = baseValid;
    expect(SnowflakeConnectionSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts named selectable warehouses when the default is a declared value', () => {
    expect(
      SnowflakeConnectionSchema.safeParse({
        account_identifier: 'acct',
        warehouse: 'SMALL_WH',
        warehouses: { small: 'SMALL_WH', large: 'BIG_WH' },
        role: 'READER_ROLE',
      }).success
    ).toBe(true);
  });

  it('rejects a named warehouse map whose default is not declared', () => {
    expect(
      SnowflakeConnectionSchema.safeParse({
        account_identifier: 'acct',
        warehouse: 'OTHER_WH',
        warehouses: { small: 'SMALL_WH' },
        role: 'READER_ROLE',
      }).success
    ).toBe(false);
  });
});
