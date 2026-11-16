import { describe, expect, it } from 'vitest';

import { SyncSpecSchema } from '../../../src/sync/spec.js';

const baseSpec = {
  spec_version: '1',
  type: 'sync',
  name: 'contacts_to_webhook',
  source: {
    type: 'projection',
    connection: 'warehouse_prod',
    projection_ref: 'mart.contacts_projection',
    cursor: {
      field: 'observed_at',
      tie_breaker_fields: ['entity_id'],
      initial_value: '1970-01-01T00:00:00.000Z',
    },
  },
  target: {
    action: 'webhook/notify_contact',
    entity_key: { fields: ['email'] },
  },
};

describe('SyncSpecSchema', () => {
  it('applies v1 defaults', () => {
    const parsed = SyncSpecSchema.parse(baseSpec);
    expect(parsed.options.page_size).toBe(500);
    expect(parsed.options.checkpoint_interval_records).toBe(100);
    expect(parsed.source.filters).toEqual({});
  });

  it('rejects unsafe projection identifiers', () => {
    expect(() =>
      SyncSpecSchema.parse({
        ...baseSpec,
        source: { ...baseSpec.source, projection_ref: 'mart.contacts;DROP' },
      })
    ).toThrow();
  });

  it('rejects checkpoint intervals larger than the page size', () => {
    expect(() =>
      SyncSpecSchema.parse({
        ...baseSpec,
        options: { page_size: 10, checkpoint_interval_records: 11 },
      })
    ).toThrow();
  });
});
