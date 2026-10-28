import { describe, expect, it } from 'vitest';

import { parseDashboardIntegrationsResponse, parseDashboardModelsResponse } from './dashboard-data';

describe('dashboard refresh payload parsing', () => {
  it('accepts valid integration payloads', () => {
    expect(
      parseDashboardIntegrationsResponse({
        integrations: [
          {
            name: 'stripe',
            display_name: 'Stripe',
            category: 'finance',
            resource_count: 12,
            integration_type: 'api',
          },
        ],
      })
    ).toEqual([
      {
        name: 'stripe',
        display_name: 'Stripe',
        category: 'finance',
        resource_count: 12,
        integration_type: 'api',
      },
    ]);
  });

  it('rejects malformed integration payloads', () => {
    expect(
      parseDashboardIntegrationsResponse({
        integrations: [{ name: 'stripe', resource_count: '12' }],
      })
    ).toBeNull();
  });

  it('accepts valid model payloads', () => {
    expect(
      parseDashboardModelsResponse({
        packages: [{ name: 'stripe_analytics', martCount: 4 }],
      })
    ).toEqual([{ name: 'stripe_analytics', martCount: 4 }]);
  });

  it('rejects malformed model payloads', () => {
    expect(
      parseDashboardModelsResponse({
        packages: [{ name: 'stripe_analytics', martCount: '4' }],
      })
    ).toBeNull();
  });
});
