import { describe, expect, it } from 'vitest';

import { collectAuthEnvVars } from '../../src/commands/health-check-auth.js';

describe('collectAuthEnvVars', () => {
  it('collects legacy $ENV_VAR auth references', () => {
    expect(
      collectAuthEnvVars({
        type: 'api_key',
        key: '$TEST_API_KEY',
      })
    ).toEqual(['TEST_API_KEY']);
  });

  it('collects GitHub-style env template references', () => {
    expect(
      collectAuthEnvVars({
        type: 'bearer',
        token: '${{ env.VANTAGE_API_TOKEN }}',
      })
    ).toEqual(['VANTAGE_API_TOKEN']);
  });

  it('walks nested auth values and de-duplicates env vars', () => {
    expect(
      collectAuthEnvVars({
        oauth2: {
          client_id: '${{ env.CLIENT_ID }}',
          client_secret: '${{ env.CLIENT_SECRET }}',
          scopes: ['read', '${{ env.CLIENT_SECRET }}'],
        },
      })
    ).toEqual(['CLIENT_ID', 'CLIENT_SECRET']);
  });

  it('ignores non-env placeholders', () => {
    expect(
      collectAuthEnvVars({
        token: '${{ secrets.API_TOKEN }}',
        header: 'Bearer token',
      })
    ).toEqual([]);
  });
});
