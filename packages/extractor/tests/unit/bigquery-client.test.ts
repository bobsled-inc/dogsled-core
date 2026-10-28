import { describe, expect, it } from 'vitest';

import { resolveBigQueryAccessTokenAuth } from '../../src/runtime/bigquery-client.js';

describe('resolveBigQueryAccessTokenAuth', () => {
  it('returns undefined for adc / wif / service_account / absent auth (ambient resolution preserved)', () => {
    expect(resolveBigQueryAccessTokenAuth(undefined)).toBeUndefined();
    expect(resolveBigQueryAccessTokenAuth(null)).toBeUndefined();
    expect(resolveBigQueryAccessTokenAuth({ type: 'adc' })).toBeUndefined();
    expect(
      resolveBigQueryAccessTokenAuth({ type: 'wif', service_account_email_env: 'SA_EMAIL' })
    ).toBeUndefined();
    expect(
      resolveBigQueryAccessTokenAuth({ type: 'service_account', credentials: '/key.json' })
    ).toBeUndefined();
  });

  it('extracts a static access token', () => {
    expect(resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: 'tok' })).toEqual({
      accessToken: 'tok',
      tokenCommand: undefined,
    });
  });

  it('extracts access token + token_command (refreshable)', () => {
    expect(
      resolveBigQueryAccessTokenAuth({
        type: 'access_token',
        access_token: 'tok',
        token_command: 'node mint.js',
      })
    ).toEqual({ accessToken: 'tok', tokenCommand: 'node mint.js' });
  });

  it('treats a blank token_command as absent', () => {
    expect(
      resolveBigQueryAccessTokenAuth({
        type: 'access_token',
        access_token: 'tok',
        token_command: '   ',
      })
    ).toEqual({ accessToken: 'tok', tokenCommand: undefined });
  });

  it('throws when access_token is empty (e.g. unresolved ${{ env.X }})', () => {
    expect(() =>
      resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: '' })
    ).toThrow(/non-empty "access_token"/);
    expect(() =>
      resolveBigQueryAccessTokenAuth({ type: 'access_token', access_token: '   ' })
    ).toThrow(/non-empty "access_token"/);
  });
});
