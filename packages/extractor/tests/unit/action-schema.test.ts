import { describe, expect, it } from 'vitest';

import { ActionSpecSchema } from '../../src/schemas/action.js';

describe('ActionSpecSchema', () => {
  it('parses an API action with field mappings and defaults', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      tags: ['crm'],
      api: {
        endpoint: '/sobjects/Contact/Email/${{ input.email }}',
        method: 'PATCH',
        request_body: {
          FirstName: '${{ mapped.first_name }}',
        },
      },
      input: {
        email: { type: 'string', required: true },
        first_name: { type: 'string' },
      },
      field_mapping: {
        fields: {
          email: 'email',
          first_name: {
            source: 'first_name',
            transform: 'to_string',
          },
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'external_id',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.error_handling.max_retries).toBe(3);
    expect(result.data.field_mapping.unmapped_fields).toBe('ignore');
    expect(result.data.activate.result_path).toBe('$');
  });

  it('parses create-style API actions without identity metadata', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'create_saved_filter',
      integration: 'vantage',
      description: 'Create a saved filter',
      tags: ['cloud-infra'],
      api: {
        endpoint: '/saved_filters',
        method: 'POST',
        request_body: {
          title: '${{ mapped.title }}',
        },
      },
      input: {
        title: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          title: 'title',
        },
      },
      activate: {
        operation: 'create',
        result_path: '$.token',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts webhook actions with env-templated HTTPS URLs', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'webhook',
      name: 'notify_complete',
      description: 'Send a webhook',
      webhook: {
        url: 'https://${{ env.WEBHOOK_HOST }}/notify',
        headers: {
          Authorization: 'Bearer token',
        },
      },
      input: {
        entity_id: { type: 'string', required: true },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects transport-controlled hop-by-hop webhook headers while allowing authorization', () => {
    const restrictedHeaders = [
      'Connection',
      'Keep-Alive',
      'Proxy-Authenticate',
      'Proxy-Authorization',
      'TE',
      'Trailer',
      'Trailers',
      'Upgrade',
    ];

    for (const header of restrictedHeaders) {
      const result = ActionSpecSchema.safeParse({
        spec_version: '1',
        type: 'action',
        transport: 'webhook',
        name: 'notify_complete',
        description: 'Send a webhook',
        webhook: {
          url: 'https://${{ env.WEBHOOK_HOST }}/notify',
          headers: {
            [header]: 'forbidden',
          },
        },
        input: {
          entity_id: { type: 'string', required: true },
        },
      });

      expect(result.success).toBe(false);
    }

    const allowedResult = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'webhook',
      name: 'notify_complete',
      description: 'Send a webhook',
      webhook: {
        url: 'https://${{ env.WEBHOOK_HOST }}/notify',
        headers: {
          Authorization: 'Bearer token',
        },
      },
      input: {
        entity_id: { type: 'string', required: true },
      },
    });

    expect(allowedResult.success).toBe(true);
  });

  it('rejects API identity fields that are neither mapped nor present in input', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['external_id'],
          strategy: 'external_id',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.message).toContain('Identity field "external_id"');
  });

  it('rejects duplicate identity fields', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email', 'email'],
          strategy: 'external_id',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.message).toContain('identity.fields');
  });

  it('requires identity metadata for update-style API actions', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'update_contact',
      integration: 'salesforce',
      description: 'Update a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'update',
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
  });

  it('requires lookup_endpoint when the identity strategy is lookup', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'lookup',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.message).toContain('lookup_endpoint');
  });

  it('rejects blank lookup_endpoint values for lookup identity strategies', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'lookup',
          lookup_endpoint: '   ',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.message).toContain('lookup_endpoint must be a non-empty string');
  });

  it('rejects absolute lookup_endpoint values for lookup identity strategies', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'lookup',
          lookup_endpoint: 'https://evil.example',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(
      result.error.issues.some(
        (issue) =>
          issue.path.join('.') === 'activate.identity.lookup_endpoint' &&
          issue.message.includes('must start with "/"')
      )
    ).toBe(true);
  });

  it('rejects bare lookup_endpoint values for lookup identity strategies', () => {
    const result = ActionSpecSchema.safeParse({
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'lookup',
          lookup_endpoint: 'items/search',
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(
      result.error.issues.some(
        (issue) =>
          issue.path.join('.') === 'activate.identity.lookup_endpoint' &&
          issue.message.includes('must start with "/"')
      )
    ).toBe(true);
  });
});
