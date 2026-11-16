import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SourceSchema } from '../../src/framework/core/source.js';
import type { Source } from '../../src/framework/core/source.js';
import { buildOperationRequest } from '../../src/framework/runtime/request-builder.js';
import type { ResolvedApiConfig } from '../../src/framework/runtime/merge-integration.js';
import {
  collectIntegrationStructuralFindings,
  collectOptionalOnlyEnvRefs,
} from '../../src/commands/verify-shared.js';
import { IntegrationSpecSchema } from '../../src/framework/extractor/resource.js';
import type { IntegrationSpec } from '../../src/types/index.js';

function customApiSource(overrides: Record<string, unknown> = {}): unknown {
  return {
    spec_version: '2',
    type: 'source',
    source_type: 'custom_api',
    name: 'langsmith',
    auth_env_vars: ['LANGSMITH_API_KEY'],
    transports: [
      {
        id: 'default',
        base_url: 'https://api.smith.langchain.com',
        auth: {
          type: 'api-key',
          header: 'x-api-key',
          key: '${{ env.LANGSMITH_API_KEY }}',
        },
      },
    ],
    default_transport: 'default',
    ...overrides,
  };
}

describe('custom_api SourceSchema', () => {
  it('accepts source_type: custom_api with inline transport and auth_env_vars', () => {
    const parsed = SourceSchema.parse(customApiSource());
    expect(parsed.source_type).toBe('custom_api');
    expect(parsed.auth_env_vars).toEqual(['LANGSMITH_API_KEY']);
    expect(parsed.transports[0]?.type).toBe('http');
  });

  it('strips the dogsled_source_kind orchestrator marker', () => {
    const parsed = SourceSchema.parse(customApiSource({ dogsled_source_kind: 'custom_api' }));
    expect('dogsled_source_kind' in parsed).toBe(false);
    expect(parsed.source_type).toBe('custom_api');
  });

  it('still rejects any other source_type literal on a v2 source', () => {
    expect(SourceSchema.safeParse(customApiSource({ source_type: 'api' })).success).toBe(false);
    expect(SourceSchema.safeParse(customApiSource({ source_type: 'snowflake' })).success).toBe(
      false
    );
  });

  it('accepts a plain v2 source with no source_type (ordinary bundled source)', () => {
    const parsed = SourceSchema.parse(customApiSource({ source_type: undefined }));
    expect(parsed.source_type).toBeUndefined();
  });
});

describe('verify env-var gate honors auth_env_vars', () => {
  const rawYaml = `
transports:
  - id: default
    base_url: https://api.smith.langchain.com
    auth:
      type: api-key
      header: x-api-key
      key: \${{ env.LANGSMITH_API_KEY }}
`;

  it('passes when env refs are covered by auth_env_vars alone (no meta auth_setup)', () => {
    const spec = SourceSchema.parse(customApiSource()) as unknown as IntegrationSpec;
    const findings = collectIntegrationStructuralFindings('langsmith', spec, rawYaml, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(false);
  });

  it('flags an env ref that is declared in neither auth_env_vars nor auth_setup', () => {
    const spec = SourceSchema.parse(customApiSource()) as unknown as IntegrationSpec;
    const raw = `${rawYaml}      extra: \${{ env.UNDECLARED_TOKEN }}\n`;
    const findings = collectIntegrationStructuralFindings('langsmith', spec, raw, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(true);
  });
});

describe('custom_api SSRF enforcement', () => {
  // The shared test setup enables BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1.
  // Unset it so the public-host guard runs, mirroring production.
  let original: string | undefined;
  beforeAll(() => {
    original = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  });
  afterAll(() => {
    if (original !== undefined) {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = original;
    }
  });

  it('blocks a custom_api transport pointed at a private host', async () => {
    const source = SourceSchema.parse(customApiSource({ source_type: undefined })) as Source;
    const transport = source.transports[0];
    expect(transport).toBeDefined();
    const baseUrl = transport && 'base_url' in transport ? transport.base_url : '';
    expect(baseUrl).toBeTruthy();

    const api: ResolvedApiConfig = {
      base_url: 'https://10.0.0.1',
      endpoint: '/datasets',
      method: 'GET',
      timeout_ms: 30000,
      headers: {},
      query_params: {},
      auth: { type: 'none' },
    };

    await expect(
      buildOperationRequest({ api, inputSchema: {}, providedInput: {} })
    ).rejects.toThrow(/private\/internal host/);
  });
});

describe('optional transport headers', () => {
  const sourceWithOptionalHeader = () =>
    customApiSource({
      transports: [
        {
          id: 'default',
          base_url: 'https://api.smith.langchain.com',
          auth: { type: 'api-key', header: 'x-api-key', key: '${{ env.LANGSMITH_API_KEY }}' },
          optional_headers: { 'x-acting-user': '${{ env.ACTING_USER }}' },
        },
      ],
    });
  const rawYaml = `
transports:
  - id: default
    base_url: https://api.smith.langchain.com
    auth:
      type: api-key
      header: x-api-key
      key: \${{ env.LANGSMITH_API_KEY }}
    optional_headers:
      x-acting-user: \${{ env.ACTING_USER }}
`;

  it('parses optional_headers on an http transport', () => {
    const parsed = SourceSchema.parse(sourceWithOptionalHeader());
    const transport = parsed.transports[0];
    expect(transport?.type === 'http' && transport.optional_headers).toEqual({
      'x-acting-user': '${{ env.ACTING_USER }}',
    });
  });

  it('rejects an optional header that references input, mapped or integration', () => {
    for (const value of [
      '${{ input.actor }}',
      'x-${{ mapped.id }}',
      '${{ integration.base_url }}',
    ]) {
      const result = SourceSchema.safeParse(
        customApiSource({
          transports: [
            {
              id: 'default',
              base_url: 'https://api.smith.langchain.com',
              optional_headers: { 'x-scope': value },
            },
          ],
        })
      );
      expect(result.success, value).toBe(false);
    }
    const allowed = SourceSchema.safeParse(
      customApiSource({
        transports: [
          {
            id: 'default',
            base_url: 'https://api.smith.langchain.com',
            optional_headers: { 'x-scope': 'Bearer ${{ secrets.TOKEN }}/${{ env.TENANT }}' },
          },
        ],
      })
    );
    expect(allowed.success).toBe(true);
  });

  it('rejects an optional header with an unsafe name', () => {
    const result = SourceSchema.safeParse(
      customApiSource({
        transports: [
          {
            id: 'default',
            base_url: 'https://api.smith.langchain.com',
            optional_headers: { 'bad header': 'value' },
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it('requires a declaration for a variable used only by an optional header', () => {
    const spec = SourceSchema.parse(sourceWithOptionalHeader()) as unknown as IntegrationSpec;
    const findings = collectIntegrationStructuralFindings('langsmith', spec, rawYaml, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(true);
  });

  it('keeps a variable required when a declared field also references it', () => {
    const shared = customApiSource({
      transports: [
        {
          id: 'default',
          base_url: 'https://api.smith.langchain.com',
          auth: { type: 'api-key', header: 'x-api-key', key: '${{ env.LANGSMITH_API_KEY }}' },
          headers: { 'x-also': '${{ env.ACTING_USER }}' },
          optional_headers: { 'x-acting-user': '${{ env.ACTING_USER }}' },
        },
      ],
    });
    const spec = SourceSchema.parse(shared) as unknown as IntegrationSpec;
    const raw = `${rawYaml}    headers:\n      x-also: \${{ env.ACTING_USER }}\n`;
    const findings = collectIntegrationStructuralFindings('langsmith', spec, raw, null);
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(true);
    expect(collectOptionalOnlyEnvRefs(spec)).toEqual(new Set());
  });

  it('requires optional-only declarations on a singular-transport API integration', () => {
    const spec = IntegrationSpecSchema.parse({
      auth_env_vars: ['LEGACY_TOKEN'],
      spec_version: '1',
      type: 'integration',
      name: 'legacy',
      transport: {
        base_url: 'https://api.example.test',
        auth: { type: 'bearer', token: '${{ env.LEGACY_TOKEN }}' },
        optional_headers: { 'x-acting-user': '${{ env.ACTING_USER }}' },
      },
    }) as unknown as IntegrationSpec;
    expect(collectOptionalOnlyEnvRefs(spec)).toEqual(new Set(['ACTING_USER']));
    const raw = `
transport:
  base_url: https://api.example.test
  auth:
    type: bearer
    token: \${{ env.LEGACY_TOKEN }}
  optional_headers:
    x-acting-user: \${{ env.ACTING_USER }}
`;
    const findings = collectIntegrationStructuralFindings('legacy', spec, raw, {
      auth_setup: [{ env: 'LEGACY_TOKEN', description: 'token' }],
      docs_url: 'https://example.test/docs',
    });
    expect(findings.some((f) => f.code === 'MISSING_AUTH_SETUP')).toBe(true);
  });

  it('omits the header from a built request when the variable is unset', async () => {
    const source = SourceSchema.parse(sourceWithOptionalHeader()) as Source;
    const transport = source.transports[0];
    expect(transport?.type).toBe('http');
    if (transport?.type !== 'http') return;
    const api: ResolvedApiConfig = {
      base_url: transport.base_url,
      endpoint: '/runs',
      method: 'GET',
      timeout_ms: 30_000,
      headers: {},
      optional_headers: transport.optional_headers ?? {},
      query_params: {},
      auth: { type: 'none' },
    };
    const withoutActor = await buildOperationRequest({
      api,
      inputSchema: {},
      context: {
        declaredEnvVars: new Set(['LANGSMITH_API_KEY', 'ACTING_USER']),
        env: { LANGSMITH_API_KEY: 'k' },
        allowProcessEnvFallback: false,
      },
      skipDnsValidation: true,
    });
    expect(withoutActor.headers).not.toHaveProperty('x-acting-user');
    const withActor = await buildOperationRequest({
      api,
      inputSchema: {},
      context: {
        declaredEnvVars: new Set(['LANGSMITH_API_KEY', 'ACTING_USER']),
        env: { ACTING_USER: 'assertion-1' },
        allowProcessEnvFallback: false,
      },
      skipDnsValidation: true,
    });
    expect(withActor.headers['x-acting-user']).toBe('assertion-1');
  });
});
