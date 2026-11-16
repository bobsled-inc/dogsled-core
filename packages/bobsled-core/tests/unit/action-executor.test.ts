import { afterEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  apiTransport: {
    executeApiAction: vi.fn(),
  },
  webhookTransport: {
    executeWebhookAction: vi.fn(),
  },
}));

vi.mock('../../src/lib/transports/api.js', () => transportMocks.apiTransport);
vi.mock('../../src/lib/transports/webhook.js', () => transportMocks.webhookTransport);

import { executeAction, validateInputs } from '../../src/lib/action-executor.js';

import type { Action } from '../../src/lib/action-registry.js';

const { apiTransport, webhookTransport } = transportMocks;

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    name: 'upsert_contact',
    qualifiedName: 'salesforce/upsert_contact',
    integration: 'salesforce',
    transport: 'api',
    tags: ['crm'],
    description: 'Upsert a contact',
    inputs: {
      email: { type: 'string', required: true },
      score: { type: 'integer' },
    },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      tags: ['crm'],
      description: 'Upsert a contact',
      api: {
        endpoint: '/items',
        method: 'POST',
      },
      input: {
        email: { type: 'string', required: true },
        score: { type: 'integer' },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
        unmapped_fields: 'ignore',
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'external_id',
        },
        result_path: '$',
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/upsert_contact.yml',
    ...overrides,
  };
}

describe('action executor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validates and coerces inputs before dispatch', () => {
    const action = makeAction();
    const result = validateInputs(action, {
      email: 'alice@example.com',
      score: '7',
    });

    expect(result).toEqual({
      success: true,
      data: {
        email: 'alice@example.com',
        score: 7,
      },
    });
  });

  it('returns a validation_error result without calling transports', async () => {
    const action = makeAction();

    const result = await executeAction(action, {});

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('validation_error');
    expect(apiTransport.executeApiAction).not.toHaveBeenCalled();
  });

  it('dispatches API actions after validation succeeds', async () => {
    apiTransport.executeApiAction.mockResolvedValueOnce({
      status: 'success',
      action: 'salesforce/upsert_contact',
      transport: 'api',
      attempted_at: new Date().toISOString(),
      duration_ms: 5,
    });

    const action = makeAction();
    const result = await executeAction(action, {
      email: 'alice@example.com',
      score: '3',
    });

    expect(apiTransport.executeApiAction).toHaveBeenCalledWith(
      action,
      {
        email: 'alice@example.com',
        score: 3,
      },
      undefined
    );
    expect(result.status).toBe('success');
  });

  it('dispatches webhook actions through the webhook transport', async () => {
    webhookTransport.executeWebhookAction.mockResolvedValueOnce({
      status: 'skipped',
      action: 'notify_complete',
      transport: 'webhook',
      attempted_at: new Date().toISOString(),
      duration_ms: 1,
    });

    const action = makeAction({
      name: 'notify_complete',
      qualifiedName: 'notify_complete',
      integration: undefined,
      transport: 'webhook',
      tags: ['notifications'],
      spec: {
        spec_version: '1',
        type: 'action',
        transport: 'webhook',
        name: 'notify_complete',
        tags: ['notifications'],
        description: 'Send a webhook',
        webhook: {
          url: 'https://hooks.example.com/notify',
          method: 'POST',
          headers: {},
        },
        input: {
          entity_id: { type: 'string', required: true },
        },
        error_handling: {
          on_record_error: 'skip',
          consecutive_failure_threshold: 10,
          max_retries: 3,
        },
      },
      inputs: {
        entity_id: { type: 'string', required: true },
      },
    });

    const result = await executeAction(action, { entity_id: 'ent_123' });

    expect(webhookTransport.executeWebhookAction).toHaveBeenCalledWith(
      action,
      { entity_id: 'ent_123' },
      undefined
    );
    expect(result.status).toBe('skipped');
  });
});
