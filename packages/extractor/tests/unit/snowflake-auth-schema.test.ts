import { describe, expect, it } from 'vitest';

import {
  SnowflakeAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeWorkloadIdentityAuthSchema,
} from '../../src/framework/core/warehouse.js';

describe('SnowflakeWorkloadIdentityAuthSchema', () => {
  it('accepts a token reference and defaults provider to OIDC', () => {
    const result = SnowflakeWorkloadIdentityAuthSchema.safeParse({
      type: 'workload_identity',
      token: '${{ env.SF_WIF_TOKEN }}',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: 'workload_identity',
        provider: 'OIDC',
        token: '${{ env.SF_WIF_TOKEN }}',
      });
    }
  });

  it('accepts GCP and AZURE providers', () => {
    for (const provider of ['GCP', 'AZURE']) {
      const result = SnowflakeWorkloadIdentityAuthSchema.safeParse({
        type: 'workload_identity',
        provider,
        token: '${{ env.SF_WIF_TOKEN }}',
      });
      expect(result.success, provider).toBe(true);
    }
  });

  it('rejects the AWS provider (needs a signed request, not a bearer token)', () => {
    const result = SnowflakeWorkloadIdentityAuthSchema.safeParse({
      type: 'workload_identity',
      provider: 'AWS',
      token: '${{ env.SF_WIF_TOKEN }}',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing token', () => {
    const result = SnowflakeWorkloadIdentityAuthSchema.safeParse({
      type: 'workload_identity',
    });
    expect(result.success).toBe(false);
  });

  it('rejects the legacy token_env shape', () => {
    const result = SnowflakeWorkloadIdentityAuthSchema.safeParse({
      type: 'workload_identity',
      token_env: 'SF_WIF_TOKEN',
    });
    expect(result.success).toBe(false);
  });

  it('is accepted by the SnowflakeAuthSchema union', () => {
    expect(
      SnowflakeAuthSchema.safeParse({
        type: 'workload_identity',
        token: '${{ env.SF_WIF_TOKEN }}',
      }).success
    ).toBe(true);
  });
});

describe('SnowflakeRsaKeyAuthSchema', () => {
  it('accepts minimal rsa_key auth with private_key_path_env', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
      private_key_path_env: 'SF_PRIVATE_KEY_PATH',
    });
    expect(result.success).toBe(true);
  });

  it('accepts rsa_key auth with optional passphrase env', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
      private_key_path_env: 'SF_PRIVATE_KEY_PATH',
      private_key_passphrase_env: 'SF_PRIVATE_KEY_PASSPHRASE',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing private_key_path_env', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
    });
    expect(result.success).toBe(false);
  });

  it('rejects user_env on the auth block (it belongs on connection)', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'rsa_key',
      user_env: 'SF_USER',
      private_key_path_env: 'SF_PRIVATE_KEY_PATH',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong discriminator', () => {
    const result = SnowflakeRsaKeyAuthSchema.safeParse({
      type: 'pat',
      private_key_path_env: 'X',
    });
    expect(result.success).toBe(false);
  });
});

describe('SnowflakeAuthSchema (union) — rsa_key variant', () => {
  it('accepts pat variant', () => {
    expect(SnowflakeAuthSchema.safeParse({ type: 'pat', token_env: 'SF_TOKEN' }).success).toBe(
      true
    );
  });

  it('accepts oauth variant', () => {
    expect(
      SnowflakeAuthSchema.safeParse({
        type: 'oauth',
        client_id_env: 'SF_CLIENT_ID',
        client_secret_env: 'SF_CLIENT_SECRET',
        token_url: 'https://example.com/oauth/token',
      }).success
    ).toBe(true);
  });

  it('accepts rsa_key variant in the union', () => {
    expect(
      SnowflakeAuthSchema.safeParse({
        type: 'rsa_key',
        private_key_path_env: 'SF_PRIVATE_KEY_PATH',
        private_key_passphrase_env: 'SF_PRIVATE_KEY_PASSPHRASE',
      }).success
    ).toBe(true);
  });

  it('rejects unknown auth types', () => {
    expect(SnowflakeAuthSchema.safeParse({ type: 'magic', magic_env: 'M' }).success).toBe(false);
  });
});
