import { describe, expect, it } from 'vitest';

import { TargetFileSchema } from '../../../src/schemas/target.js';

describe('TargetFileSchema', () => {
  const minimalValid = {
    spec_version: '1',
    type: 'target',
    name: 'raw_load',
    integration: 'snowflake_prod',
  };

  it('accepts minimum required fields', () => {
    expect(TargetFileSchema.parse(minimalValid)).toMatchObject(minimalValid);
  });

  it('accepts overrides + defaults', () => {
    const parsed = TargetFileSchema.parse({
      ...minimalValid,
      overrides: {
        role: 'LOADER_ROLE',
        database: 'BOBSLED_CORE_RAW',
        schema: 'RAW',
        warehouse: 'LOAD_WH',
        catalog: 'main',
      },
      defaults: {
        load_strategy: 'merge',
        schema_behavior: 'evolve',
        buffer_size: 10000,
      },
    });
    expect(parsed.overrides?.role).toBe('LOADER_ROLE');
    expect(parsed.defaults?.load_strategy).toBe('merge');
  });

  it('rejects inline connection / auth (no credentials on targets)', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        connection: { account_identifier: 'xt' },
      })
    ).toThrow();

    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        auth: { type: 'pat', token: 'x' },
      })
    ).toThrow();
  });

  it('rejects non-snake_case integration handle', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        integration: 'Snowflake-Prod',
      })
    ).toThrow();
  });

  it('rejects non-snake_case name', () => {
    expect(() => TargetFileSchema.parse({ ...minimalValid, name: 'RAW-LOAD' })).toThrow();
  });

  it('rejects invalid load_strategy', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        defaults: { load_strategy: 'upsert' },
      })
    ).toThrow();
  });

  it('accepts every loader schema_behavior, including freeze', () => {
    for (const schema_behavior of ['evolve', 'strict', 'freeze']) {
      expect(
        TargetFileSchema.parse({ ...minimalValid, defaults: { schema_behavior } }).defaults
          ?.schema_behavior
      ).toBe(schema_behavior);
    }
  });

  it('rejects invalid schema_behavior', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        defaults: { schema_behavior: 'loose' },
      })
    ).toThrow();
  });

  it('rejects unknown override field', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        overrides: { unknown_field: 'x' },
      })
    ).toThrow();
  });

  it('rejects wrong type field', () => {
    expect(() =>
      TargetFileSchema.parse({
        ...minimalValid,
        type: 'integration',
      })
    ).toThrow();
  });

  it('rejects wrong spec_version', () => {
    expect(() => TargetFileSchema.parse({ ...minimalValid, spec_version: '0.1' })).toThrow();
  });

  it('coerces buffer_size from string numeral', () => {
    const parsed = TargetFileSchema.parse({
      ...minimalValid,
      defaults: { buffer_size: '500' as unknown as number },
    });
    expect(parsed.defaults?.buffer_size).toBe(500);
  });
});
