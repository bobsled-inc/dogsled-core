import { describe, expect, it } from 'vitest';

import { parseIntegrationDetail } from './integration-detail';

describe('parseIntegrationDetail', () => {
  it('normalizes a valid integration payload', () => {
    expect(
      parseIntegrationDetail({
        name: 'stripe',
        meta: {
          display_name: 'Stripe',
          docs_url: 'https://docs.stripe.com',
        },
        resources: [{ name: 'charges', description: 'Charges' }],
      })
    ).toEqual({
      name: 'stripe',
      meta: {
        display_name: 'Stripe',
        category: 'unknown',
        tags: [],
        docs_url: 'https://docs.stripe.com',
        logo_url: undefined,
        auth_setup: [],
      },
      spec: {
        transport: undefined,
      },
      resources: [{ name: 'charges', description: 'Charges' }],
      modelBundle: null,
    });
  });

  it('rejects payloads whose resources do not contain string names', () => {
    expect(
      parseIntegrationDetail({
        name: 'stripe',
        meta: {
          display_name: 'Stripe',
        },
        resources: [{ name: 42 }],
      })
    ).toBeNull();
  });
});
