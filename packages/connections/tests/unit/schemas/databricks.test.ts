import { describe, expect, it } from 'vitest';

import {
  DatabricksAuthSchema,
  DatabricksConnectionSchema,
} from '../../../src/schemas/databricks.js';

describe('DatabricksConnectionSchema', () => {
  const minimalValid = {
    workspace_url: 'https://acme.cloud.databricks.com',
    http_path: '/sql/1.0/warehouses/abc123',
  };

  it('accepts minimum required fields', () => {
    expect(DatabricksConnectionSchema.parse(minimalValid)).toMatchObject(minimalValid);
  });

  it('accepts legacy _env fields', () => {
    expect(
      DatabricksConnectionSchema.parse({
        workspace_url_env: 'DATABRICKS_URL',
        http_path_env: 'DATABRICKS_PATH',
      })
    ).toMatchObject({
      workspace_url_env: 'DATABRICKS_URL',
      http_path_env: 'DATABRICKS_PATH',
    });
  });

  it('accepts optional catalog + schema defaults', () => {
    expect(
      DatabricksConnectionSchema.parse({
        ...minimalValid,
        catalog: 'main',
        schema: 'default',
      })
    ).toMatchObject({ catalog: 'main', schema: 'default' });
  });

  it('rejects missing workspace_url', () => {
    expect(() =>
      DatabricksConnectionSchema.parse({ http_path: '/sql/1.0/warehouses/abc123' })
    ).toThrow(/must be set/);
  });

  it('rejects missing http_path', () => {
    expect(() =>
      DatabricksConnectionSchema.parse({ workspace_url: 'https://acme.cloud.databricks.com' })
    ).toThrow(/must be set/);
  });

  it('rejects workspace_url + workspace_url_env together', () => {
    expect(() =>
      DatabricksConnectionSchema.parse({
        ...minimalValid,
        workspace_url_env: 'DATABRICKS_URL',
      })
    ).toThrow(/Cannot set both/);
  });

  it('rejects http_path + http_path_env together', () => {
    expect(() =>
      DatabricksConnectionSchema.parse({
        ...minimalValid,
        http_path_env: 'DATABRICKS_PATH',
      })
    ).toThrow(/Cannot set both/);
  });
});

describe('DatabricksAuthSchema', () => {
  it('parses pat new-style', () => {
    expect(DatabricksAuthSchema.parse({ type: 'pat', token: 'dapi-xxx' })).toMatchObject({
      type: 'pat',
      token: 'dapi-xxx',
    });
  });

  it('parses pat legacy', () => {
    expect(
      DatabricksAuthSchema.parse({ type: 'pat', token_env: 'DATABRICKS_TOKEN' })
    ).toMatchObject({ token_env: 'DATABRICKS_TOKEN' });
  });

  it('rejects pat missing token', () => {
    expect(() => DatabricksAuthSchema.parse({ type: 'pat' })).toThrow(/must be set/);
  });

  it('rejects pat with both token and token_env', () => {
    expect(() =>
      DatabricksAuthSchema.parse({
        type: 'pat',
        token: 'dapi-xxx',
        token_env: 'DATABRICKS_TOKEN',
      })
    ).toThrow(/Cannot set both/);
  });

  it('parses oauth_m2m new-style', () => {
    expect(
      DatabricksAuthSchema.parse({
        type: 'oauth_m2m',
        client_id: 'cid',
        client_secret: 'csec',
      })
    ).toMatchObject({ type: 'oauth_m2m', client_id: 'cid', client_secret: 'csec' });
  });

  it('parses oauth_m2m legacy', () => {
    expect(
      DatabricksAuthSchema.parse({
        type: 'oauth_m2m',
        client_id_env: 'DATABRICKS_CLIENT_ID',
        client_secret_env: 'DATABRICKS_CLIENT_SECRET',
      })
    ).toMatchObject({
      type: 'oauth_m2m',
      client_id_env: 'DATABRICKS_CLIENT_ID',
      client_secret_env: 'DATABRICKS_CLIENT_SECRET',
    });
  });

  it('rejects oauth_m2m missing client_id', () => {
    expect(() => DatabricksAuthSchema.parse({ type: 'oauth_m2m', client_secret: 'csec' })).toThrow(
      /must be set/
    );
  });

  it('rejects oauth_m2m missing client_secret', () => {
    expect(() => DatabricksAuthSchema.parse({ type: 'oauth_m2m', client_id: 'cid' })).toThrow(
      /must be set/
    );
  });

  it('rejects oauth_m2m with both client_id and client_id_env', () => {
    expect(() =>
      DatabricksAuthSchema.parse({
        type: 'oauth_m2m',
        client_id: 'cid',
        client_id_env: 'DATABRICKS_CLIENT_ID',
        client_secret: 'csec',
      })
    ).toThrow(/Cannot set both/);
  });

  it('rejects oauth_m2m with both client_secret and client_secret_env', () => {
    expect(() =>
      DatabricksAuthSchema.parse({
        type: 'oauth_m2m',
        client_id: 'cid',
        client_secret: 'csec',
        client_secret_env: 'DATABRICKS_CLIENT_SECRET',
      })
    ).toThrow(/Cannot set both/);
  });

  it('rejects unknown auth type', () => {
    expect(() =>
      DatabricksAuthSchema.parse({ type: 'service_account', credentials: 'x' })
    ).toThrow();
  });
});
