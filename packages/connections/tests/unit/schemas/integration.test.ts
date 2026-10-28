import { describe, expect, it } from 'vitest';

import {
  IntegrationFileSchema,
  SourceTypeSchema,
  SourceTypeValues,
} from '../../../src/schemas/integration.js';

describe('SourceTypeValues', () => {
  it('contains the Model Spec dialects with an integration schema', () => {
    expect([...SourceTypeValues].sort()).toEqual(
      ['bigquery', 'clickhouse', 'databricks', 'duckdb', 'postgres', 'snowflake'].sort()
    );
  });

  it('SourceTypeSchema rejects unknown values', () => {
    expect(() => SourceTypeSchema.parse('redshift')).toThrow();
    expect(() => SourceTypeSchema.parse('api')).toThrow();
  });
});

describe('IntegrationFileSchema — discriminated union', () => {
  it('parses a snowflake integration', () => {
    const parsed = IntegrationFileSchema.parse({
      auth_env_vars: ['SF_ACCOUNT'],
      spec_version: '1',
      type: 'integration',
      name: 'snowflake_prod',
      source_type: 'snowflake',
      connection: {
        account_identifier: '${{ env.SF_ACCOUNT }}',
        warehouse: 'COMPUTE_WH',
        role: 'DOGSLED_AI_ROLE',
      },
      auth: { type: 'rsa_key', private_key_path: '/tmp/sf.pem' },
    });
    expect(parsed.source_type).toBe('snowflake');
    if (parsed.source_type === 'snowflake') {
      expect(parsed.auth.type).toBe('rsa_key');
    }
  });

  it('parses a bigquery integration', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'bigquery_analytics',
      source_type: 'bigquery',
      connection: { project_id: 'acme-data' },
      auth: { type: 'adc' },
    });
    expect(parsed.source_type).toBe('bigquery');
  });

  it('parses a postgres integration', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'postgres_crm',
      source_type: 'postgres',
      connection: { host: 'db.acme.com', database: 'crm' },
      auth: { type: 'password', user: 'svc', password: 'p4ss' },
    });
    expect(parsed.source_type).toBe('postgres');
  });

  it('parses a databricks integration', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'databricks_main',
      source_type: 'databricks',
      connection: {
        workspace_url: 'https://acme.cloud.databricks.com',
        http_path: '/sql/1.0/warehouses/abc123',
      },
      auth: { type: 'pat', token: 'dapi-xxx' },
    });
    expect(parsed.source_type).toBe('databricks');
  });

  it('parses a duckdb integration', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'duckdb_local',
      source_type: 'duckdb',
      connection: {},
      auth: { type: 'file', path: '/tmp/w.duckdb' },
    });
    expect(parsed.source_type).toBe('duckdb');
  });

  it('parses a sledhouse_oidc Snowflake integration (schema-only; runner fails elsewhere)', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'acme_sledhouse',
      source_type: 'snowflake',
      connection: {
        account_identifier: 'xt12345',
        warehouse: 'DOGSLED_AI_WH',
        role: 'DOGSLED_AI_ROLE',
      },
      auth: { type: 'sledhouse_oidc', data_source_slug: 'acme_sf' },
    });
    expect(parsed.source_type).toBe('snowflake');
    if (parsed.source_type === 'snowflake') {
      expect(parsed.auth.type).toBe('sledhouse_oidc');
    }
  });

  it('rejects unknown source_type', () => {
    expect(() =>
      IntegrationFileSchema.parse({
        spec_version: '1',
        type: 'integration',
        name: 'redshift_warehouse',
        source_type: 'redshift',
        connection: {},
        auth: {},
      })
    ).toThrow();
  });

  it('rejects wrong spec_version', () => {
    expect(() =>
      IntegrationFileSchema.parse({
        spec_version: '0.1',
        type: 'integration',
        name: 'snowflake_prod',
        source_type: 'snowflake',
        connection: {
          account_identifier: 'xt',
          warehouse: 'W',
          role: 'R',
        },
        auth: { type: 'pat', token: 'x' },
      })
    ).toThrow();
  });

  it('rejects wrong type field', () => {
    expect(() =>
      IntegrationFileSchema.parse({
        spec_version: '1',
        type: 'target',
        name: 'snowflake_prod',
        source_type: 'snowflake',
        connection: {
          account_identifier: 'xt',
          warehouse: 'W',
          role: 'R',
        },
        auth: { type: 'pat', token: 'x' },
      })
    ).toThrow();
  });

  it('rejects non-snake_case name', () => {
    expect(() =>
      IntegrationFileSchema.parse({
        spec_version: '1',
        type: 'integration',
        name: 'Snowflake-Prod',
        source_type: 'snowflake',
        connection: {
          account_identifier: 'xt',
          warehouse: 'W',
          role: 'R',
        },
        auth: { type: 'pat', token: 'x' },
      })
    ).toThrow();
  });

  it('passes through host-specific top-level fields (passthrough on integration)', () => {
    const parsed = IntegrationFileSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'snowflake_prod',
      source_type: 'snowflake',
      connection: {
        account_identifier: 'xt',
        warehouse: 'W',
        role: 'R',
      },
      auth: { type: 'pat', token: 'x' },
      storage: { type: 'internal_stage' },
      tags: ['pii'],
    }) as Record<string, unknown>;
    expect(parsed['storage']).toEqual({ type: 'internal_stage' });
    expect(parsed['tags']).toEqual(['pii']);
  });
});
