import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_EMBEDDING_ENV_NAMES } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeApiAction } from '../../../src/lib/transports/api.js';

import type { Action } from '../../../src/lib/action-registry.js';

function makeApiAction(): Action {
  return {
    name: 'upsert_contact',
    qualifiedName: 'salesforce/upsert_contact',
    integration: 'salesforce',
    transport: 'api',
    tags: ['crm'],
    description: 'Upsert a contact',
    inputs: {
      email: { type: 'string', required: true },
      first_name: { type: 'string' },
      last_name: { type: 'string', required: true },
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
        endpoint: '/sobjects/Contact/Email/${{ input.email }}',
        method: 'PATCH',
        request_body: {
          FirstName: '${{ mapped.first_name }}',
          LastName: '${{ mapped.last_name }}',
        },
      },
      input: {
        email: { type: 'string', required: true },
        first_name: { type: 'string' },
        last_name: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
          first_name: 'first_name',
          last_name: 'last_name',
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
  };
}

describe('executeApiAction reserved credentials', () => {
  it.each([
    ['a declared host name', ['GITHUB_TOKEN'], 'skipped'],
    ['an undeclared name', undefined, 'failed'],
  ])('previews a reserved auth name only for %s', async (_case, names, status) => {
    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      {
        dryRun: true,
        secrets: { GITHUB_TOKEN: 'host-canary' },
        declaredSecretNames: names,
      },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            auth_env_vars: ['GITHUB_TOKEN'],
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'bearer', token: '${{ env.GITHUB_TOKEN }}' },
            },
          }) as never,
      }
    );

    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain('host-canary');
  });
});

describe('executeApiAction and a host-supplied embedding model', () => {
  const cases = HOST_EMBEDDING_ENV_NAMES.flatMap((name) =>
    (['secrets', 'env'] as const).flatMap((source) =>
      (['header', 'auth'] as const).map((place) => [source, name, place] as const)
    )
  );

  it.each(cases)('refuses %s.%s in its %s', async (source, name, place) => {
    const template = '${{ ' + source + '.' + name + ' }}';
    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      {
        dryRun: true,
        secrets: { [name]: 'host-canary' },
        declaredSecretNames: [...HOST_EMBEDDING_ENV_NAMES],
      },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            auth_env_vars: [...HOST_EMBEDDING_ENV_NAMES],
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              ...(place === 'header' ? { headers: { 'X-Value': template } } : {}),
              auth: place === 'auth' ? { type: 'bearer', token: template } : { type: 'none' },
            },
          }) as never,
      }
    );
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('host-canary');
  });
});

describe('executeApiAction', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('returns success for a completed API request', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: '003123' },
      headers: new Headers(),
      status: 200,
    });
    const close = vi.fn().mockResolvedValue(undefined);

    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () =>
          ({
            request,
            close,
          }) as never,
      }
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          mapped: {
            email: 'alice@example.com',
            first_name: 'Alice',
            last_name: 'Doe',
          },
        },
      })
    );
    expect(result).toMatchObject({
      status: 'success',
      target_record_id: '003123',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('builds and validates dry-run requests without calling the client', async () => {
    const createClient = vi.fn();
    const buildRequest = vi.fn().mockResolvedValue({
      url: 'https://api.example.com/sobjects/Contact/Email/alice%40example.com',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        FirstName: 'Alice',
        LastName: 'Doe',
      },
      timeout_ms: 30_000,
      auth: { type: 'none' },
      interpolationContext: {
        input: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        mapped: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
      },
      input: {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
    });

    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      { dryRun: true },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: createClient as never,
        buildRequest,
      }
    );

    expect(buildRequest).toHaveBeenCalledOnce();
    expect(buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          mapped: {
            email: 'alice@example.com',
            first_name: 'Alice',
            last_name: 'Doe',
          },
          env: process.env,
          secrets: process.env,
        }),
        skipDnsValidation: true,
      })
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.preview).toEqual({
      action: 'salesforce/upsert_contact',
      integration: 'salesforce',
      operation: 'upsert',
      target_host: 'api.example.com',
      input_fields: ['email', 'first_name', 'last_name'],
      effect: 'Upsert a contact',
      request: {
        method: 'PATCH',
        path_template: '/sobjects/Contact/Email/{email}',
        input_locations: {},
        whole_input_locations: [],
      },
    });
  });

  it('previews no location for an optional mapped input that was not supplied', async () => {
    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { dryRun: true, secrets: {} },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
      }
    );

    expect(result.preview?.request?.input_locations).toEqual({
      email: ['path'],
      last_name: ['body'],
    });
  });

  it('previews where the planned request sends each input without carrying values', async () => {
    const action = makeApiAction();
    if (action.spec.transport !== 'api') throw new Error('expected an API action');
    action.inputs = {
      account_id: { type: 'string', required: true },
      item_id: { type: 'string', required: true },
      mode: { type: 'string', required: true },
      api_key: { type: 'string', required: true },
      trace: { type: 'string', required: true },
      tenant: { type: 'string', required: true },
      note: { type: 'string' },
    };
    action.spec = {
      ...action.spec,
      input: action.inputs,
      api: {
        endpoint:
          '/accounts/${{ input.account_id }}/items/${{ mapped.item }}?mode=${{ input.mode }}',
        method: 'DELETE',
        headers: { 'X-Trace': '${{ mapped.trace }}' },
        query_params: { key: '${{ input.api_key }}' },
        request_body: { note: '${{ input.note }}', everything: '${{ input }}' },
      },
      field_mapping: { fields: { item: 'item_id' }, unmapped_fields: 'passthrough' },
    };
    const inputs = {
      account_id: 'acct-1',
      item_id: 'item-2',
      mode: 'hard',
      api_key: 'key-secret',
      trace: 'trace-3',
      tenant: 'tenant-4',
      note: 'note-5',
    };

    const result = await executeApiAction(
      action,
      inputs,
      { dryRun: true, secrets: {} },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              headers: { 'X-Tenant': '${{ input.tenant }}' },
              auth: { type: 'none' },
            },
          }) as never,
      }
    );

    expect(result.status).toBe('skipped');
    expect(result.preview?.request).toEqual({
      method: 'DELETE',
      path_template: '/accounts/{account_id}/items/{item_id}%3Fmode={mode}',
      input_locations: {
        account_id: ['path'],
        api_key: ['query'],
        item_id: ['path'],
        mode: ['path'],
        note: ['body'],
        tenant: ['header'],
        trace: ['header'],
      },
      whole_input_locations: ['body'],
    });
    expect(JSON.stringify(result.preview)).not.toMatch(
      /acct-1|item-2|hard|key-secret|trace-3|tenant-4|note-5/
    );
  });

  it('uses a resolved integration, request-scoped secrets, and cancellation', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: '003123' },
      headers: new Headers(),
      status: 200,
    });
    const createClient = vi.fn(() => ({ request }));
    const loadIntegration = vi.fn();
    const signal = new AbortController().signal;
    const resolvedIntegration = {
      spec_version: '1' as const,
      type: 'integration' as const,
      name: 'salesforce',
      auth_env_vars: ['API_TOKEN'],
      transport: {
        type: 'http' as const,
        base_url: 'https://api.example.com',
        auth: { type: 'bearer' as const, token: '${{ secrets.API_TOKEN }}' },
      },
    };

    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      {
        resolvedIntegration,
        secrets: { API_TOKEN: 'request-only-token' },
        signal,
        limits: { maxResponseBytes: 32 * 1024 },
      },
      { createClient: createClient as never, loadIntegration }
    );

    expect(loadIntegration).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledWith(resolvedIntegration, {
      secrets: { API_TOKEN: 'request-only-token' },
      env: { API_TOKEN: 'request-only-token' },
      onResolvedSecret: expect.any(Function),
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ signal, responseBodyLimitBytes: 32 * 1024 })
    );
    expect(result.status).toBe('success');
  });

  it('marks an Action request as a write, so the client keeps its earlier retry loop', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: '003123' },
      headers: new Headers(),
      status: 200,
    });
    const resolvedIntegration = {
      spec_version: '1' as const,
      type: 'integration' as const,
      name: 'salesforce',
      transport: { type: 'http' as const, base_url: 'https://api.example.com' },
    };

    await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { resolvedIntegration },
      { createClient: (() => ({ request })) as never, loadIntegration: vi.fn() }
    );

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ idempotent: false }));
  });

  it('cancels an API request that is already running', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const request = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      markStarted?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
        });
      });
    });
    const close = vi.fn().mockResolvedValue(undefined);

    const pending = executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { signal: controller.signal },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () => ({ request, close }) as never,
      }
    );
    await started;
    controller.abort();

    const result = await pending;
    expect(result.error).toMatchObject({ code: 'cancelled', retryable: false });
    expect(close).toHaveBeenCalledOnce();
  });

  it('times out an API request that runs past its limit', async () => {
    vi.useFakeTimers();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const request = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      markStarted?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
        });
      });
    });

    const pending = executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { limits: { timeoutMs: 25 } },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () => ({ request }) as never,
      }
    );
    await started;
    await vi.advanceTimersByTimeAsync(25);

    const result = await pending;
    expect(result.error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it.each([
    [{ timeoutMs: 60_001 }, 'timeoutMs'],
    [{ maxResponseBytes: 1024 * 1024 + 1 }, 'maxResponseBytes'],
  ])('rejects invalid Action limits before the request', async (limits, message) => {
    const request = vi.fn();

    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { limits },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () => ({ request }) as never,
      }
    );

    expect(request).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({ code: 'validation_error', retryable: false });
    expect(result.error?.message).toContain(message);
  });

  it('uses the HTTP transport from a resolved Source', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: '003123' },
      headers: new Headers(),
      status: 200,
    });
    const createClient = vi.fn(() => ({ request }));

    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      {
        resolvedIntegration: {
          spec_version: '2',
          type: 'source',
          source_type: 'custom_api',
          name: 'salesforce',
          default_transport: 'rest',
          transports: [
            {
              id: 'rest',
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          ],
        },
      },
      { createClient: createClient as never }
    );

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'salesforce',
        transport: expect.objectContaining({ type: 'http', base_url: 'https://api.example.com' }),
      }),
      { onResolvedSecret: expect.any(Function) }
    );
    expect(result.status).toBe('success');
  });

  it('rejects a resolved Integration with the wrong name', async () => {
    const createClient = vi.fn();
    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      {
        resolvedIntegration: {
          spec_version: '1',
          type: 'integration',
          name: 'wrong',
          transport: {
            type: 'http',
            base_url: 'https://api.example.com',
            auth: { type: 'none' },
          },
        },
      },
      { createClient: createClient as never }
    );

    expect(createClient).not.toHaveBeenCalled();
    expect(result.error?.message).toContain('does not match Action Integration');
  });

  it('maps HTTP failures to semantic action errors', async () => {
    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () =>
          ({
            request: vi
              .fn()
              .mockRejectedValue(new Error('API request failed: 429 Too Many Requests - [url]')),
          }) as never,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('hides upstream error details in safe server mode', async () => {
    const result = await executeApiAction(
      makeApiAction(),
      { email: 'alice@example.com', last_name: 'Doe' },
      { safeErrors: true },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () => ({
          request: vi
            .fn()
            .mockRejectedValue(
              new Error('API request failed: 500 Error - https://secret.example/token')
            ),
        }),
      }
    );

    expect(result.error).toMatchObject({
      code: 'server_error',
      message: 'The external service failed.',
    });
    expect(JSON.stringify(result)).not.toContain('secret.example');
  });

  it('rejects oversized integration specs before parsing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dogsled-api-action-'));
    mkdirSync(join(tempDir, 'integrations'));
    writeFileSync(
      join(tempDir, 'integrations', 'salesforce.yml'),
      'x'.repeat(1_024 * 1_024 + 1),
      'utf-8'
    );
    process.chdir(tempDir);

    try {
      const result = await executeApiAction(
        makeApiAction(),
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        { dryRun: true }
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatchObject({
        code: 'unknown',
        retryable: false,
      });
      expect(result.error?.message).toContain(
        'integrations/salesforce.yml: The file is 1048577 bytes; the limit is 1048576.'
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers the canonical local integration layout over bundled integrations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dogsled-api-action-layout-'));
    mkdirSync(join(tempDir, 'integrations', 'salesforce'), { recursive: true });
    writeFileSync(
      join(tempDir, 'integrations', 'salesforce', 'integration.yml'),
      [
        'spec_version: "1"',
        'type: integration',
        'name: salesforce',
        'transport:',
        '  type: http',
        '  base_url: https://local.example.com',
        '  auth:',
        '    type: none',
      ].join('\n'),
      'utf-8'
    );
    process.chdir(tempDir);

    const buildRequest = vi.fn().mockResolvedValue({
      url: 'https://local.example.com/sobjects/Contact/Email/alice%40example.com',
      method: 'PATCH',
      headers: {},
      body: undefined,
      timeout_ms: 30_000,
      auth: { type: 'none' },
      interpolationContext: {
        input: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        mapped: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
      },
      input: {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
    });

    try {
      const result = await executeApiAction(
        makeApiAction(),
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        { dryRun: true },
        { buildRequest }
      );

      expect(buildRequest).toHaveBeenCalledOnce();
      expect(buildRequest.mock.calls[0]?.[0]?.api).toMatchObject({
        base_url: 'https://local.example.com',
      });
      expect(result.status).toBe('skipped');
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('finds local integrations from an explicit project root when run in a nested directory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dogsled-api-action-nested-layout-'));
    const nestedDir = join(tempDir, 'apps', 'operator');
    mkdirSync(join(tempDir, 'integrations', 'salesforce'), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'integrations', 'salesforce', 'integration.yml'),
      [
        'spec_version: "1"',
        'type: integration',
        'name: salesforce',
        'transport:',
        '  type: http',
        '  base_url: https://local.example.com',
        '  auth:',
        '    type: none',
      ].join('\n'),
      'utf-8'
    );
    process.chdir(nestedDir);

    const buildRequest = vi.fn().mockResolvedValue({
      url: 'https://local.example.com/sobjects/Contact/Email/alice%40example.com',
      method: 'PATCH',
      headers: {},
      body: undefined,
      timeout_ms: 30_000,
      auth: { type: 'none' },
      interpolationContext: {
        input: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        mapped: {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
      },
      input: {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
    });

    try {
      const result = await executeApiAction(
        makeApiAction(),
        {
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Doe',
        },
        { dryRun: true, projectRoot: tempDir },
        { buildRequest }
      );

      expect(buildRequest).toHaveBeenCalledOnce();
      expect(buildRequest.mock.calls[0]?.[0]?.api).toMatchObject({
        base_url: 'https://local.example.com',
      });
      expect(result.status).toBe('skipped');
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps 422 API failures to validation errors', async () => {
    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () =>
          ({
            request: vi
              .fn()
              .mockRejectedValue(new Error('API request failed: 422 Unprocessable Entity - [url]')),
          }) as never,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      retryable: false,
    });
  });

  it('treats field-mapping failures as validation errors', async () => {
    const result = await executeApiAction(
      {
        ...makeApiAction(),
        spec: {
          ...makeApiAction().spec,
          field_mapping: {
            fields: {
              email: 'email',
              first_name: {
                source: 'first_name',
                required: true,
              },
            },
            unmapped_fields: 'ignore',
          },
        },
      },
      {
        email: 'alice@example.com',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () =>
          ({
            request: vi.fn(),
          }) as never,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      retryable: false,
    });
  });

  it('treats dry-run request-building failures as validation errors', async () => {
    const buildRequest = vi
      .fn()
      .mockRejectedValue(new Error('Missing mapped.first_name referenced in request_body'));

    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      { dryRun: true },
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        buildRequest,
      }
    );

    expect(buildRequest).toHaveBeenCalledOnce();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      message: 'Missing mapped.first_name referenced in request_body',
      retryable: false,
    });
  });

  it('treats live request preflight failures as validation errors without calling the client', async () => {
    const buildRequest = vi
      .fn()
      .mockRejectedValue(new Error('Missing mapped.first_name referenced in request_body'));
    const createClient = vi.fn();

    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: createClient as never,
        buildRequest,
      }
    );

    expect(buildRequest).toHaveBeenCalledOnce();
    expect(createClient).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      message: 'Missing mapped.first_name referenced in request_body',
      retryable: false,
    });
  });

  it('maps 400 API failures to validation errors', async () => {
    const result = await executeApiAction(
      makeApiAction(),
      {
        email: 'alice@example.com',
        first_name: 'Alice',
        last_name: 'Doe',
      },
      undefined,
      {
        loadIntegration: () =>
          ({
            spec_version: '1',
            type: 'integration',
            name: 'salesforce',
            transport: {
              type: 'http',
              base_url: 'https://api.example.com',
              auth: { type: 'none' },
            },
          }) as never,
        createClient: () =>
          ({
            request: vi
              .fn()
              .mockRejectedValue(new Error('API request failed: 400 Bad Request - [url]')),
          }) as never,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'validation_error',
      retryable: false,
    });
  });
});
