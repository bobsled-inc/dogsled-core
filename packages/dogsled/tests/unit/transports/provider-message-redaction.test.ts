import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeAction, type ActionResult } from '../../../src/actions/index.js';

import type { HttpTransportConfig } from '@bobsled-inc/extractor/core';
import type { IntegrationSpec } from '@bobsled-inc/extractor/extractor';
import type { Action } from '../../../src/lib/action-registry.js';

const inputs = { id: '42', name: 'Alice' };

function makeApiAction(): Action {
  return {
    name: 'update_contact',
    qualifiedName: 'crm/update_contact',
    integration: 'crm',
    transport: 'api',
    tags: [],
    description: 'Update a contact',
    inputs: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'update_contact',
      integration: 'crm',
      tags: [],
      description: 'Update a contact',
      api: {
        endpoint: '/contacts/${{ input.id }}',
        method: 'PATCH',
        request_body: { name: '${{ mapped.name }}' },
      },
      input: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      field_mapping: {
        fields: { id: 'id', name: 'name' },
        unmapped_fields: 'ignore',
      },
      activate: {
        operation: 'update',
        identity: { fields: ['id'], strategy: 'external_id' },
        result_path: '$',
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/update_contact.yml',
  };
}

function makeWebhookAction(headers: Record<string, string>): Action {
  return {
    name: 'notify_complete',
    qualifiedName: 'notify_complete',
    integration: undefined,
    transport: 'webhook',
    tags: [],
    description: 'Notify an external system',
    inputs: { entity_id: { type: 'string', required: true } },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'webhook',
      auth_env_vars: ['WEBHOOK_TOKEN', 'WEBHOOK_BASIC'],
      name: 'notify_complete',
      tags: [],
      description: 'Notify an external system',
      webhook: {
        url: 'https://hooks.example.com/notify',
        method: 'POST',
        headers,
        request_body: { id: '${{ input.entity_id }}' },
      },
      input: { entity_id: { type: 'string', required: true } },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/notify_complete.yml',
  };
}

function makeIntegration(
  transport: Partial<HttpTransportConfig>,
  authEnvVars: string[] = []
): IntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'crm',
    ...(authEnvVars.length > 0 ? { auth_env_vars: authEnvVars } : {}),
    transport: {
      type: 'http',
      base_url: 'https://api.example.com',
      auth: { type: 'none' },
      retry: { max_retries: 0 },
      ...transport,
    },
  } as IntegrationSpec;
}

function encodedForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  return [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    new URLSearchParams({ value }).toString().slice('value='.length),
    json,
    json.replaceAll('/', '\\/'),
  ];
}

function echo(value: string): string {
  return encodedForms(value).join(' | ');
}

function unicodeEscaped(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!.toString(16).padStart(4, '0');
    return `\\u${code}`;
  }).join('');
}

function providerResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function messageBody(message: string, rawEscapedValues: readonly string[] = []): string {
  let body = JSON.stringify({ error: { message } });
  rawEscapedValues.forEach((value, index) => {
    body = body.replace(`__RAW_${index}__`, unicodeEscaped(value));
  });
  return body;
}

function expectReceiptExcludes(result: ActionResult, values: readonly string[]): void {
  const serialized = JSON.stringify(result);
  const message = result.error?.provider_message ?? '';
  for (const value of values) {
    for (const form of encodedForms(value)) {
      expect(serialized).not.toContain(form);
      expect(message).not.toContain(form);
    }
  }
}

function requestAuthorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

describe('provider message redaction through executeAction', () => {
  beforeEach(() => {
    vi.stubEnv('DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('redacts the expired and the refreshed OAuth token a refusal reflects', async () => {
    const tokenUrl = 'https://auth.example.com/oauth2-refresh-then-refuse';
    const tokens = ['first"oauth/token+1', 'second"oauth/token+2'];
    let minted = 0;
    const authorizations: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === tokenUrl) {
          return providerResponse(
            200,
            JSON.stringify({ access_token: tokens[minted++], expires_in: 3600 })
          );
        }
        authorizations.push(requestAuthorization(init));
        if (authorizations.length === 1) {
          return providerResponse(401, JSON.stringify({ message: 'Token expired.' }));
        }
        return providerResponse(
          403,
          messageBody(
            `Refused ${echo(tokens[0]!)} and ${echo(tokens[1]!)} decoded __RAW_0__ __RAW_1__`,
            tokens
          )
        );
      })
    );

    const result = await executeAction(makeApiAction(), inputs, {
      resolvedIntegration: makeIntegration({
        auth: {
          type: 'oauth2',
          grant_type: 'client_credentials',
          token_url: tokenUrl,
          client_id: 'acme-client',
          client_secret: 'acme-client-secret',
        },
      }),
      safeErrors: true,
    });

    expect(authorizations).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);
    expect(result.error).toMatchObject({
      code: 'permission_denied',
      message: 'The external service refused the Action.',
      provider_status: 403,
    });
    expect(result.error?.provider_message).toMatch(/^Refused \[REDACTED\]/);
    expect(result.error?.provider_message).toContain('decoded [REDACTED] [REDACTED]');
    expectReceiptExcludes(result, tokens);
  });

  it('redacts a custom token reflected by the final response after retries are exhausted', async () => {
    const tokenUrl = 'https://auth.example.com/custom-token-exhausted-retries';
    const token = 'custom"token/429+x';
    let apiCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === tokenUrl) {
          return providerResponse(200, JSON.stringify({ access_token: token }));
        }
        apiCalls += 1;
        return providerResponse(
          429,
          messageBody(`Slow down ${echo(token)} decoded __RAW_0__`, [token]),
          { 'Retry-After': '0' }
        );
      })
    );

    const result = await executeAction(makeApiAction(), inputs, {
      resolvedIntegration: makeIntegration({
        auth: { type: 'custom-token', token_url: tokenUrl, token_ttl_seconds: 0 },
        retry: { max_retries: 1 },
      }),
      safeErrors: true,
    });

    expect(apiCalls).toBe(2);
    expect(result.error).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      provider_status: 429,
    });
    expect(result.error?.provider_message).toMatch(/^Slow down \[REDACTED\]/);
    expectReceiptExcludes(result, [token]);
  });

  it('redacts the Basic payload, its decoded credential, and the password', async () => {
    const password = 'basic/pass?word>1';
    const decoded = `acme-user:${password}`;
    const payload = Buffer.from(decoded).toString('base64');
    vi.stubEnv('ACME_BASIC_PASSWORD', password);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse(
          403,
          messageBody(
            `Credential ${echo(payload)} for ${echo(decoded)} decoded __RAW_0__ __RAW_1__ is read-only.`,
            [payload, decoded]
          )
        )
      )
    );

    const result = await executeAction(makeApiAction(), inputs, {
      resolvedIntegration: makeIntegration(
        {
          auth: {
            type: 'basic',
            username: 'acme-user',
            password: '${{ env.ACME_BASIC_PASSWORD }}',
          },
        },
        ['ACME_BASIC_PASSWORD']
      ),
      safeErrors: true,
    });

    expect(result.error).toMatchObject({ code: 'permission_denied', provider_status: 403 });
    expect(result.error?.provider_message).toMatch(/^Credential \[REDACTED\].* is read-only\.$/);
    expectReceiptExcludes(result, [payload, decoded, password]);
  });

  it('redacts an API credential after normalizing text and sanitizing URLs', async () => {
    const token = 'acme-ordering-token-7';
    vi.stubEnv('ACME_TOKEN', token);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse(
          403,
          messageBody(
            [
              'Refused acme-ordering​-token-7,',
              'acme-ordering-\ntoken-7,',
              'https://ACME-ORDERING-TOKEN-7.example.com/v1?sig=x and',
              'https://%61cme-ordering-token-7.example.com/v2',
            ].join(' ')
          )
        )
      )
    );

    const result = await executeAction(makeApiAction(), inputs, {
      resolvedIntegration: makeIntegration(
        { auth: { type: 'bearer', token: '${{ env.ACME_TOKEN }}' } },
        ['ACME_TOKEN']
      ),
      safeErrors: true,
    });

    expect(result.error).toMatchObject({
      code: 'permission_denied',
      provider_status: 403,
      provider_message:
        'Refused [REDACTED], [REDACTED], https://[REDACTED].example.com/v1?[redacted] and ' +
        'https://[REDACTED].example.com/v2',
    });
    expectReceiptExcludes(result, [token]);
    expect(JSON.stringify(result)).not.toMatch(/acme-ordering/i);
  });

  it('redacts a webhook credential after normalizing text and sanitizing URLs', async () => {
    const token = 'hook-ordering-token-9';
    vi.stubEnv('WEBHOOK_TOKEN', token);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse(
          403,
          messageBody(
            [
              'Refused hook-ordering⁠-token-9,',
              'hook-ordering\r\n-token-9,',
              'https://HOOK-ORDERING-TOKEN-9.example.com/x?sig=y.',
            ].join(' ')
          )
        )
      )
    );

    const result = await executeAction(
      makeWebhookAction({ Authorization: 'Bearer ${{ env.WEBHOOK_TOKEN }}' }),
      { entity_id: 'ent_123' },
      { safeErrors: true }
    );

    expect(result.error).toMatchObject({
      code: 'permission_denied',
      provider_status: 403,
      provider_message:
        'Refused [REDACTED], [REDACTED], https://[REDACTED].example.com/x?[redacted]',
    });
    expectReceiptExcludes(result, [token]);
    expect(JSON.stringify(result)).not.toMatch(/hook-ordering/i);
  });

  it('redacts the decoded credential of a webhook Basic header', async () => {
    const decoded = 'hook-user:hook>pass?2';
    const payload = Buffer.from(decoded).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse(
          403,
          messageBody(`Credential ${echo(payload)} for ${echo(decoded)} is read-only.`)
        )
      )
    );

    const result = await executeAction(
      makeWebhookAction({ Authorization: 'Basic ${{ env.WEBHOOK_BASIC }}' }),
      { entity_id: 'ent_123' },
      { secrets: { WEBHOOK_BASIC: payload }, safeErrors: true }
    );

    expect(result.error).toMatchObject({ code: 'permission_denied', provider_status: 403 });
    expect(result.error?.provider_message).toMatch(/^Credential \[REDACTED\].* is read-only\.$/);
    expectReceiptExcludes(result, [payload, decoded, 'hook>pass?2']);
  });

  it('previews a dry run without sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeAction(makeApiAction(), inputs, {
      resolvedIntegration: makeIntegration({ auth: { type: 'bearer', token: 'dry-run-token' } }),
      dryRun: true,
      safeErrors: true,
    });

    expect(result.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('dry-run-token');
  });
});
