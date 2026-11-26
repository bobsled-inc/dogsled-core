import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractorClient } from '../../src/runtime/client.js';
import { runActivateDispatcher } from '../../src/runtime/activate/dispatcher.js';
import type { ActivationResult } from '../../src/runtime/activate/dispatcher.js';
import type { ActivationRecord } from '../../src/runtime/activate/result-emitter.js';
import { ExtractorConfigError } from '../../src/runtime/errors.js';

const mockActionSpec = {
  spec_version: '1' as const,
  type: 'action' as const,
  transport: 'api' as const,
  name: 'upsert_contact',
  integration: 'salesforce',
  description: 'Upsert a contact in Salesforce',
  tags: [],
  input: {},
  api: {
    endpoint: '/contacts',
    method: 'POST' as const,
  },
  field_mapping: {
    fields: { name: 'name', email: 'email' },
    unmapped_fields: 'ignore' as const,
  },
  activate: { operation: 'create' as const, result_path: '$' },
  error_handling: {
    on_record_error: 'skip' as const,
    consecutive_failure_threshold: 10,
    max_retries: 3,
  },
};

const mockIntegrationSpec = {
  spec_version: '1' as const,
  type: 'integration' as const,
  name: 'salesforce',
  transport: {
    type: 'http' as const,
    base_url: 'https://api.salesforce.example.com' as `https://${string}`,
  },
};

const makeRecord = (id: string): ActivationRecord => ({
  entity_id: id,
  cluster_id: `cluster-${id}`,
  entity_trust_score: 0.9,
  trust_tier: 'high',
  name: 'Alice',
  email: 'alice@example.com',
});

describe('runActivateDispatcher', () => {
  it('returns skipped summary for dry-run mode', async () => {
    const results: ActivationResult[] = [];
    const summary = await runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1'), makeRecord('ent-2')],
      projectionRef: 'mydb.people__salesforce__projection_1',
      syncName: 'salesforce_sync',
      dryRun: true,
      onResult: async (r) => {
        results.push(r);
      },
    });

    expect(summary.skipped).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('emits correct idempotency keys per record', async () => {
    const results: ActivationResult[] = [];
    await runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1'), makeRecord('ent-2')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      dryRun: true,
      onResult: async (r) => {
        results.push(r);
      },
    });

    const keys = results.map((r) => r.idempotency_key);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBeDefined();
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toHaveLength(64);
  });

  it('respects limit option', async () => {
    const results: ActivationResult[] = [];
    await runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1'), makeRecord('ent-2'), makeRecord('ent-3')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      dryRun: true,
      limit: 2,
      onResult: async (r) => {
        results.push(r);
      },
    });

    expect(results).toHaveLength(2);
  });

  it('returns empty summary for empty records', async () => {
    const summary = await runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
    });
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('aborts after consecutiveFailureThreshold consecutive failures', async () => {
    const results: ActivationResult[] = [];
    const records = [
      makeRecord('ent-1'),
      makeRecord('ent-2'),
      makeRecord('ent-3'),
      makeRecord('ent-4'),
      makeRecord('ent-5'),
    ];

    // Field mapping failure — entity_id missing — triggers validation_error for every record
    const badActionSpec = {
      ...mockActionSpec,
      field_mapping: {
        fields: { required_field: 'missing_source_field' },
        unmapped_fields: 'error' as const,
      },
    };

    const summary = await runActivateDispatcher({
      actionSpec: badActionSpec,
      integrationSpec: mockIntegrationSpec,
      records,
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      consecutiveFailureThreshold: 2,
      onResult: async (r) => {
        results.push(r);
      },
    });

    // Loop should abort after 2 consecutive failures — 3rd through 5th records never processed
    expect(summary.failed).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'failed')).toBe(true);
  });

  it('classifies HTTP 429 as rate_limited and retries', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({ status: 429, data: null, headers: new Headers() }),
    } as unknown as ExtractorClient;
    const results: ActivationResult[] = [];

    vi.useFakeTimers();
    const summaryPromise = runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      client: mockClient,
      onResult: async (r) => {
        results.push(r);
      },
    });
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;
    vi.useRealTimers();

    expect(summary.failed).toBe(1);
    expect(results[0]?.error?.code).toBe('rate_limited');
    // 1 initial + 3 retries from DEFAULT_RETRY_CONFIG
    expect(mockClient.request).toHaveBeenCalledTimes(4);
  });

  it('marks the request as a write, so the client keeps its earlier retry loop', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({ status: 200, data: null, headers: new Headers() }),
    } as unknown as ExtractorClient;

    await runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      client: mockClient,
    });

    expect(mockClient.request).toHaveBeenCalledWith(expect.objectContaining({ idempotent: false }));
  });

  it('classifies network errors as network_error and retries', async () => {
    const networkError = new TypeError('fetch failed');
    const mockClient = {
      request: vi.fn().mockRejectedValue(networkError),
    } as unknown as ExtractorClient;
    const results: ActivationResult[] = [];

    vi.useFakeTimers();
    const summaryPromise = runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      client: mockClient,
      onResult: async (r) => {
        results.push(r);
      },
    });
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;
    vi.useRealTimers();

    expect(summary.failed).toBe(1);
    expect(results[0]?.error?.code).toBe('network_error');
    // 1 initial + 3 retries from DEFAULT_RETRY_CONFIG
    expect(mockClient.request).toHaveBeenCalledTimes(4);
  });

  it('does not retry fail-fast client configuration errors', async () => {
    const configError = new ExtractorConfigError('invalid auth config');
    const mockClient = {
      request: vi.fn().mockRejectedValue(configError),
    } as unknown as ExtractorClient;

    await expect(
      runActivateDispatcher({
        actionSpec: mockActionSpec,
        integrationSpec: mockIntegrationSpec,
        records: [makeRecord('ent-1')],
        projectionRef: 'mydb.projection_1',
        syncName: 'sync',
        client: mockClient,
      })
    ).rejects.toThrow('invalid auth config');
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it('succeeds when client recovers after transient HTTP 500', async () => {
    const mockClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ status: 500, data: null, headers: new Headers() })
        .mockResolvedValueOnce({ status: 200, data: null, headers: new Headers() }),
    } as unknown as ExtractorClient;
    const results: ActivationResult[] = [];

    vi.useFakeTimers();
    const summaryPromise = runActivateDispatcher({
      actionSpec: mockActionSpec,
      integrationSpec: mockIntegrationSpec,
      records: [makeRecord('ent-1')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      client: mockClient,
      onResult: async (r) => {
        results.push(r);
      },
    });
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;
    vi.useRealTimers();

    expect(summary.succeeded).toBe(1);
    expect(results[0]?.status).toBe('succeeded');
    expect(mockClient.request).toHaveBeenCalledTimes(2);
  });

  it('propagates an error thrown by onResult', async () => {
    const boom = new Error('audit write failed');
    await expect(
      runActivateDispatcher({
        actionSpec: mockActionSpec,
        integrationSpec: mockIntegrationSpec,
        records: [makeRecord('ent-1')],
        projectionRef: 'mydb.projection_1',
        syncName: 'sync',
        dryRun: true,
        onResult: async () => {
          throw boom;
        },
      })
    ).rejects.toThrow('audit write failed');
  });
});

describe('runActivateDispatcher through the real ExtractorClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function dispatchOnce(
    transport: Partial<(typeof mockIntegrationSpec)['transport']> & Record<string, unknown> = {}
  ): Promise<ActivationResult | undefined> {
    const results: ActivationResult[] = [];
    await runActivateDispatcher({
      actionSpec: {
        ...mockActionSpec,
        input: { name: { type: 'string' }, email: { type: 'string' } },
      },
      integrationSpec: {
        ...mockIntegrationSpec,
        transport: { ...mockIntegrationSpec.transport, retry: { max_retries: 0 }, ...transport },
      },
      records: [makeRecord('ent-1')],
      projectionRef: 'mydb.projection_1',
      syncName: 'sync',
      retryConfig: { maxRetries: 1, baseDelayMs: 0 },
      onResult: async (r) => {
        results.push(r);
      },
    });
    return results[0];
  }

  it.each([
    [429, 'rate_limited'],
    [503, 'server_error'],
  ] as const)(
    'classifies an exhausted HTTP %i retry as %s and retries it',
    async (status, code) => {
      const fetchMock = vi.fn(async () => new Response('', { status }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await dispatchOnce();

      expect(result?.error).toMatchObject({ code, retryable: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it('classifies a fetch failure as network_error and retries it', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchOnce();

    expect(result?.error).toMatchObject({ code: 'network_error', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a request deadline as timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          })
      )
    );

    const result = await dispatchOnce({ timeout_ms: 20 });

    expect(result?.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('classifies a token-mint failure as a non-retryable auth_error', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchOnce({
      auth: {
        type: 'custom-token',
        token_url: 'https://auth.salesforce.example.com/dispatcher-mint-failure',
      },
    });

    expect(result?.error).toMatchObject({ code: 'auth_error', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
