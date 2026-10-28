import { describe, expect, it } from 'vitest';

import { BigQueryAuthSchema, BigQueryConnectionSchema } from '../../../src/schemas/bigquery.js';

describe('BigQueryConnectionSchema', () => {
  it('accepts project_id shorthand', () => {
    expect(BigQueryConnectionSchema.parse({ project_id: 'acme-data' })).toMatchObject({
      project_id: 'acme-data',
    });
  });

  it('accepts project_ids array', () => {
    expect(
      BigQueryConnectionSchema.parse({ project_ids: ['acme-raw', 'acme-modeled'] })
    ).toMatchObject({ project_ids: ['acme-raw', 'acme-modeled'] });
  });

  it('rejects when neither project_id nor project_ids is set', () => {
    expect(() => BigQueryConnectionSchema.parse({})).toThrow(/must be set/);
  });

  it('rejects empty project_ids array', () => {
    expect(() => BigQueryConnectionSchema.parse({ project_ids: [] })).toThrow();
  });

  it('accepts default_location + billing_project_id + dataset', () => {
    expect(
      BigQueryConnectionSchema.parse({
        project_id: 'acme',
        billing_project_id: 'acme-billing',
        default_location: 'US',
        dataset: 'ANALYTICS',
      })
    ).toMatchObject({ default_location: 'US', dataset: 'ANALYTICS' });
  });

  it('rejects unknown field', () => {
    expect(() => BigQueryConnectionSchema.parse({ project_id: 'acme', unknown: 'x' })).toThrow();
  });
});

describe('BigQueryAuthSchema', () => {
  it('parses adc', () => {
    expect(BigQueryAuthSchema.parse({ type: 'adc' })).toEqual({ type: 'adc' });
  });

  it('rejects adc with extra fields', () => {
    expect(() => BigQueryAuthSchema.parse({ type: 'adc', unknown: 'x' })).toThrow();
  });

  it('parses wif with new-style', () => {
    expect(
      BigQueryAuthSchema.parse({
        type: 'wif',
        service_account_email: 'svc@acme.iam.gserviceaccount.com.example.com',
      })
    ).toMatchObject({ type: 'wif' });
  });

  it('parses wif with legacy env', () => {
    expect(
      BigQueryAuthSchema.parse({
        type: 'wif',
        service_account_email_env: 'BQ_SA_EMAIL',
      })
    ).toMatchObject({ service_account_email_env: 'BQ_SA_EMAIL' });
  });

  it('rejects wif missing service account email', () => {
    expect(() => BigQueryAuthSchema.parse({ type: 'wif' })).toThrow(/must be set/);
  });

  it('parses service_account new-style', () => {
    expect(
      BigQueryAuthSchema.parse({
        type: 'service_account',
        credentials: '{"type":"service_account"}',
      })
    ).toMatchObject({ type: 'service_account' });
  });

  it('parses service_account legacy', () => {
    expect(
      BigQueryAuthSchema.parse({
        type: 'service_account',
        credentials_env: 'GOOGLE_APPLICATION_CREDENTIALS',
      })
    ).toMatchObject({ credentials_env: 'GOOGLE_APPLICATION_CREDENTIALS' });
  });

  it('rejects service_account missing credentials', () => {
    expect(() => BigQueryAuthSchema.parse({ type: 'service_account' })).toThrow(/must be set/);
  });

  it('rejects unknown type', () => {
    expect(() => BigQueryAuthSchema.parse({ type: 'password', password: 'x' })).toThrow();
  });
});
